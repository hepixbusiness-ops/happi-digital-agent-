import type { WAMessage } from 'baileys';

/** Texte lisible d'un message, ou un marqueur entre crochets pour les autres types. */
export function extractContent(m: WAMessage): string | null {
  const msg = m.message;
  if (!msg) return null;
  const text =
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption;
  if (text) return text;
  if (msg.audioMessage) return '[message audio]';
  if (msg.imageMessage) return '[image sans texte]';
  if (msg.videoMessage) return '[vidéo sans texte]';
  if (msg.documentMessage) return '[document]';
  if (msg.stickerMessage) return '[sticker]';
  if (msg.locationMessage) return '[localisation]';
  return null; // réactions, messages système, etc. : ignorés
}

/** Conversation privée uniquement : ni groupe, ni statut, ni chaîne. */
export function isPrivateChat(jid?: string | null): jid is string {
  return (
    !!jid &&
    !jid.endsWith('@g.us') &&
    !jid.endsWith('@broadcast') &&
    !jid.endsWith('@newsletter')
  );
}
