import type { WAMessageKey, WASocket } from 'baileys';
import { db } from './db.ts';
import { runAgent, type ChatTurn } from './agent.ts';

const HISTORY_LIMIT = 20;  // messages envoyés à Claude
// Attente après le dernier message du client avant de répondre (regroupe aussi
// les rafales). + rédaction et frappe (~10 s) : réponse vers 90 s au total.
const DEBOUNCE_MS = Number(process.env.REPLY_WAIT_MS ?? 80_000);
const MIN_WAIT_MS = 5_000;          // regroupe les messages relivrés d'un coup
export const MAX_AGE_MS = 6 * 3600_000; // au-delà, un message en attente est abandonné

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = new Map<string, NodeJS.Timeout>();

// Socket actif : après une reconnexion, les réponses en attente partent par le
// nouveau socket et non par celui qui a été fermé.
let current: WASocket | null = null;
export function setSocket(sock: WASocket) {
  current = sock;
}

/** Programme la réponse `DEBOUNCE_MS` après `lastAt`, le dernier message du client. */
function schedule(jid: string, lastAt: number) {
  clearTimeout(pending.get(jid));
  const delay = Math.max(MIN_WAIT_MS, lastAt + DEBOUNCE_MS - Date.now());
  pending.set(
    jid,
    setTimeout(() => {
      pending.delete(jid);
      if (!current) return;
      respond(current, jid).catch((err) => console.error('[agent] échec', jid, err));
    }, delay),
  );
}

export type Incoming = {
  jid: string;         // identifiant WhatsApp du client (…@s.whatsapp.net ou …@lid)
  key: WAMessageKey;
  name: string | null;
  content: string;
  at?: number;         // heure d'envoi par le client (ms), par défaut maintenant
};

export async function onIncoming(sock: WASocket, msg: Incoming) {
  current = sock;
  const at = msg.at ?? Date.now();
  const now = new Date().toISOString();

  // 1. Conversation (le statut n'est pas écrasé : colonne absente de l'upsert)
  await db.from('wa_conversations').upsert(
    { wa_id: msg.jid, name: msg.name, last_inbound_at: new Date(at).toISOString(), updated_at: now },
    { onConflict: 'wa_id' },
  );

  // 2. Stockage + déduplication (Baileys peut relivrer après reconnexion)
  const { error } = await db.from('wa_messages').insert({
    wa_id: msg.jid,
    wa_message_id: msg.key.id,
    role: 'user',
    content: msg.content,
  });
  if (error) {
    if (error.code === '23505') return;
    throw error;
  }

  // 3. Conversation reprise par un humain : l'IA se tait
  if (await isHuman(msg.jid)) return;

  await sock.readMessages([msg.key]).catch(() => {});

  // 4. Debounce en mémoire : une seule réponse pour une rafale de messages
  schedule(msg.jid, at);
}

/**
 * Au démarrage : reprogramme les clients dont le dernier message est resté sans
 * réponse (le worker s'est arrêté pendant l'attente).
 */
export async function resumePending() {
  const since = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const { data: convos, error } = await db
    .from('wa_conversations')
    .select('wa_id, last_inbound_at')
    .eq('status', 'bot')
    .gte('last_inbound_at', since);
  if (error) throw error;

  let resumed = 0;
  for (const c of (convos ?? []) as { wa_id: string; last_inbound_at: string }[]) {
    if (pending.has(c.wa_id)) continue;
    const { data: last } = await db
      .from('wa_messages')
      .select('role')
      .eq('wa_id', c.wa_id)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(1);
    if ((last as { role: string }[] | null)?.[0]?.role !== 'user') continue;
    schedule(c.wa_id, Date.parse(c.last_inbound_at));
    resumed++;
  }
  if (resumed) console.log(`↻ ${resumed} conversation(s) en attente de réponse reprise(s)`);
}

/**
 * Message envoyé à la main depuis le téléphone du numéro : l'humain reprend
 * la conversation et l'IA se tait (réactivation : status = 'bot').
 */
export async function onOwnerReply(msg: { jids: string[]; key: WAMessageKey; content: string }) {
  // Baileys 7 : le même client peut apparaître en @lid ou en @s.whatsapp.net
  for (const jid of msg.jids) {
    clearTimeout(pending.get(jid));
    pending.delete(jid);
  }

  const { data: known } = await db.from('wa_conversations').select('wa_id').in('wa_id', msg.jids);
  const jid = (known as { wa_id: string }[] | null)?.[0]?.wa_id ?? msg.jids[0];
  const now = new Date().toISOString();

  await db.from('wa_conversations').upsert({ wa_id: jid, updated_at: now }, { onConflict: 'wa_id' });
  const { error } = await db.from('wa_messages').insert({
    wa_id: jid,
    wa_message_id: msg.key.id,
    role: 'assistant',
    content: msg.content,
  });
  if (error) {
    if (error.code === '23505') return; // déjà connu : relivraison ou message de l'IA
    throw error;
  }
  await db.from('wa_conversations').update({ status: 'human', updated_at: now }).eq('wa_id', jid);
}

async function isHuman(jid: string) {
  const { data } = await db.from('wa_conversations').select('status').eq('wa_id', jid).single();
  return data?.status === 'human';
}

async function respond(sock: WASocket, jid: string) {
  // Historique (doit commencer par un message user pour l'API Claude)
  const { data: rows } = await db
    .from('wa_messages')
    .select('role, content')
    .eq('wa_id', jid)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = ((rows ?? []) as ChatTurn[]).reverse();
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length) return;

  await sock.sendPresenceUpdate('composing', jid);
  const { reply, handoff } = await runAgent(history);

  if (reply) {
    // Délai "humain" proportionnel à la longueur : réduit le risque de détection
    await sleep(Math.min(1200 + reply.length * 25, 7000));
    await sock.sendPresenceUpdate('paused', jid);
    // L'humain a pu reprendre la main pendant que Claude rédigeait
    if (await isHuman(jid)) return;
    const sent = await sock.sendMessage(jid, { text: reply });
    // L'ID permet de reconnaître ce message s'il revient de WhatsApp
    await db
      .from('wa_messages')
      .insert({ wa_id: jid, wa_message_id: sent?.key?.id ?? null, role: 'assistant', content: reply });
  }

  if (handoff) {
    await db
      .from('wa_conversations')
      .update({ status: 'human', updated_at: new Date().toISOString() })
      .eq('wa_id', jid);
    await db.from('wa_messages').insert({
      wa_id: jid,
      role: 'system',
      content: `TRANSFERT: ${handoff.raison} | ${handoff.resume}`,
    });

    const owner = process.env.OWNER_WHATSAPP;
    if (owner) {
      await sock
        .sendMessage(`${owner}@s.whatsapp.net`, {
          text: `🔔 Transfert ${jid}\n${handoff.raison}\n${handoff.resume}`,
        })
        .catch((err) => console.warn('[handoff] alerte non envoyée', err));
    }
  }
}
