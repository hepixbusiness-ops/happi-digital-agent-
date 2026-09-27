import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  toNumber,
  useMultiFileAuthState,
} from 'baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { MAX_AGE_MS, onIncoming, onOwnerReply, resumePending, setSocket } from './handle.ts';
import { extractContent, isPrivateChat } from './parse.ts';

const AUTH_DIR = process.env.AUTH_DIR ?? './auth';
const PAIRING_NUMBER = process.env.PAIRING_NUMBER; // ex. 2376XXXXXXXX : code à 8 caractères au lieu du QR
const WATCHDOG_MS = Number(process.env.CONNECT_WATCHDOG_MS ?? 60_000);

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log('⏳ Connexion à WhatsApp…');
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL ?? 'warn' }),
    markOnlineOnConnect: false, // le téléphone continue de recevoir les notifications
    syncFullHistory: false,
  });

  // Tout message antérieur a été envoyé pendant que ce socket n'existait pas
  const startedAt = Date.now();

  // Une seule relance par socket, quelle que soit la cause
  let restarted = false;
  const restart = (delayMs: number) => {
    if (restarted) return;
    restarted = true;
    clearTimeout(watchdog);
    setTimeout(() => start().catch((e) => console.error('[start] échec', e)), delayMs);
  };

  // Sans réponse de WhatsApp (réseau bloqué, pare-feu…), Baileys peut rester
  // silencieux indéfiniment : on force une nouvelle tentative visible.
  const watchdog = setTimeout(() => {
    console.error(`⚠️ Aucune réponse de WhatsApp après ${WATCHDOG_MS / 1000} s. Vérifie l'accès réseau du serveur à web.whatsapp.com. Nouvelle tentative…`);
    try { sock.end(undefined); } catch {}
    restart(5000);
  }, WATCHDOG_MS);

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      clearTimeout(watchdog);
      if (PAIRING_NUMBER && !pairingRequested) {
        pairingRequested = true;
        const code = await sock.requestPairingCode(PAIRING_NUMBER);
        console.log(`\nCode d'appairage : ${code}\nWhatsApp > Appareils connectés > Connecter avec un numéro\n`);
      } else if (!PAIRING_NUMBER) {
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      clearTimeout(watchdog);
      console.log('✅ WhatsApp connecté');
      setSocket(sock);
      resumePending().catch((e) => console.error('[reprise] échec', e));
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('❌ Session déconnectée. Supprime le dossier auth et reconnecte le numéro.');
        process.exit(1);
      }
      console.warn(`Connexion fermée (code ${code}), reconnexion dans 3 s…`);
      restart(3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!isPrivateChat(jid)) continue;
      const content = extractContent(m);
      if (!content) continue;

      // 'notify' : message en direct. 'append' : messages reçus pendant que le
      // worker était arrêté (relivrés à la connexion) ou envoyés par l'IA
      // elle-même. On garde les premiers s'ils sont récents.
      const at = toNumber(m.messageTimestamp) * 1000 || Date.now();
      if (type !== 'notify') {
        if (Date.now() - at > MAX_AGE_MS) continue;
        if (m.key.fromMe && at >= startedAt) continue; // envoyé par l'IA
      }

      try {
        if (m.key.fromMe) {
          // Envoyé à la main depuis le téléphone (ou WhatsApp Web) du propriétaire
          const alt = m.key.remoteJidAlt;
          await onOwnerReply({ jids: alt && alt !== jid ? [jid, alt] : [jid], key: m.key, content });
          continue;
        }
        await onIncoming(sock, { jid, key: m.key, name: m.pushName ?? null, content, at });
      } catch (err) {
        console.error('[whatsapp] échec traitement', m.key.id, err);
      }
    }
  });
}

start().catch((e) => console.error('[start] échec', e));

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
