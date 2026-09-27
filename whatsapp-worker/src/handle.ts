import type { WAMessageKey, WASocket } from 'baileys';
import { db } from './db.ts';
import { runAgent, type ChatTurn } from './agent.ts';

const HISTORY_LIMIT = 20;  // messages envoyés à Claude
const DEBOUNCE_MS = 3000;  // regroupe les messages envoyés en rafale

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = new Map<string, NodeJS.Timeout>();

export type Incoming = {
  jid: string;         // identifiant WhatsApp du client (…@s.whatsapp.net ou …@lid)
  key: WAMessageKey;
  name: string | null;
  content: string;
};

export async function onIncoming(sock: WASocket, msg: Incoming) {
  const now = new Date().toISOString();

  // 1. Conversation (le statut n'est pas écrasé : colonne absente de l'upsert)
  await db.from('wa_conversations').upsert(
    { wa_id: msg.jid, name: msg.name, last_inbound_at: now, updated_at: now },
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
  clearTimeout(pending.get(msg.jid));
  pending.set(
    msg.jid,
    setTimeout(() => {
      pending.delete(msg.jid);
      respond(sock, msg.jid).catch((err) => console.error('[agent] échec', msg.jid, err));
    }, DEBOUNCE_MS),
  );
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

  await db.from('wa_conversations').upsert(
    { wa_id: jid, status: 'human', updated_at: now },
    { onConflict: 'wa_id' },
  );
  const { error } = await db.from('wa_messages').insert({
    wa_id: jid,
    wa_message_id: msg.key.id,
    role: 'assistant',
    content: msg.content,
  });
  if (error && error.code !== '23505') throw error;
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
    await sock.sendMessage(jid, { text: reply });
    await db.from('wa_messages').insert({ wa_id: jid, role: 'assistant', content: reply });
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
