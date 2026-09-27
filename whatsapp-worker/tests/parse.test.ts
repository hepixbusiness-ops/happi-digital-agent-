import { describe, expect, it } from 'vitest';
import { extractContent, isPrivateChat } from '../src/parse.ts';

const m = (message: any) => ({ key: {}, message }) as any;

describe('extractContent', () => {
  it('texte simple', () => expect(extractContent(m({ conversation: 'Bonjour' }))).toBe('Bonjour'));
  it('texte étendu (réponse citée, lien)', () =>
    expect(extractContent(m({ extendedTextMessage: { text: 'Prix ?' } }))).toBe('Prix ?'));
  it('légende de photo', () =>
    expect(extractContent(m({ imageMessage: { caption: 'Celle-ci' } }))).toBe('Celle-ci'));
  it('photo sans légende', () => expect(extractContent(m({ imageMessage: {} }))).toBe('[image sans texte]'));
  it('note vocale', () => expect(extractContent(m({ audioMessage: {} }))).toBe('[message audio]'));
  it('réaction ignorée', () => expect(extractContent(m({ reactionMessage: { text: '👍' } }))).toBeNull());
  it('message vide ignoré', () => expect(extractContent(m(undefined))).toBeNull());
});

describe('isPrivateChat', () => {
  it('numéro classique', () => expect(isPrivateChat('237699000000@s.whatsapp.net')).toBe(true));
  it('identifiant LID (Baileys 7)', () => expect(isPrivateChat('123456789@lid')).toBe(true));
  it('groupe', () => expect(isPrivateChat('1203630@g.us')).toBe(false));
  it('statut', () => expect(isPrivateChat('status@broadcast')).toBe(false));
  it('chaîne', () => expect(isPrivateChat('1203630@newsletter')).toBe(false));
  it('vide', () => expect(isPrivateChat(undefined)).toBe(false));
});
