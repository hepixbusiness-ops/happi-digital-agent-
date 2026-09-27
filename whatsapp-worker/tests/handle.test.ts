import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb, tables, resetDb } = await vi.hoisted(async () => await import('./fake-db.ts'));
vi.mock('../src/db.ts', () => ({ db: fakeDb }));
vi.mock('../src/agent.ts', () => ({ runAgent: vi.fn() }));

import { onIncoming, onOwnerReply } from '../src/handle.ts';
import { runAgent } from '../src/agent.ts';

const JID = '237699000000@s.whatsapp.net';
const agent = vi.mocked(runAgent);
let sock: any;
let n = 0;

const incoming = (content: string, id = `MSG${++n}`) => ({
  jid: JID, key: { id, remoteJid: JID, fromMe: false }, name: 'Aïcha', content,
});
const settle = () => vi.advanceTimersByTimeAsync(100_000); // debounce + délai de frappe
const sent = () => sock.sendMessage.mock.calls.map((c: any[]) => [c[0], c[1].text]);

beforeEach(() => {
  resetDb();
  vi.useFakeTimers();
  agent.mockReset();
  sock = {
    readMessages: vi.fn(async () => {}),
    sendPresenceUpdate: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({})),
  };
  delete process.env.OWNER_WHATSAPP;
});
afterEach(() => vi.useRealTimers());

describe('flux de réponse', () => {
  it('répond à un message et mémorise la réponse', async () => {
    agent.mockResolvedValue({ reply: 'Bonjour ! Comment puis-je aider ?', handoff: null });
    await onIncoming(sock, incoming('Bonjour'));
    await settle();

    expect(agent).toHaveBeenCalledWith([{ role: 'user', content: 'Bonjour' }]);
    expect(sent()).toEqual([[JID, 'Bonjour ! Comment puis-je aider ?']]);
    expect(sock.readMessages).toHaveBeenCalledOnce();
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('composing', JID);
    expect(tables.wa_messages.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(tables.wa_conversations[0]).toMatchObject({ wa_id: JID, name: 'Aïcha', status: 'bot' });
  });

  it('ne répond pas avant la fin du debounce', async () => {
    agent.mockResolvedValue({ reply: 'ok', handoff: null });
    await onIncoming(sock, incoming('Bonjour'));
    await vi.advanceTimersByTimeAsync(79_000);
    expect(agent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent).toHaveBeenCalledOnce();
  });

  it('une rafale de 3 messages donne UNE seule réponse avec les 3 en contexte', async () => {
    agent.mockResolvedValue({ reply: 'Le sac noir est à 15 000 FCFA.', handoff: null });
    await onIncoming(sock, incoming('Bonsoir'));
    await vi.advanceTimersByTimeAsync(60_000);
    await onIncoming(sock, incoming('svp'));
    await vi.advanceTimersByTimeAsync(60_000);
    await onIncoming(sock, incoming('le sac noir c combien'));
    await settle();

    expect(agent).toHaveBeenCalledOnce();
    expect(agent.mock.calls[0][0].map((t) => t.content)).toEqual(['Bonsoir', 'svp', 'le sac noir c combien']);
    expect(sock.sendMessage).toHaveBeenCalledOnce();
  });

  it('ignore un message reçu deux fois (même ID)', async () => {
    agent.mockResolvedValue({ reply: 'ok', handoff: null });
    await onIncoming(sock, incoming('Bonjour', 'DUP1'));
    await onIncoming(sock, incoming('Bonjour', 'DUP1'));
    await settle();

    expect(tables.wa_messages.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(sock.sendMessage).toHaveBeenCalledOnce();
  });

  it("n'envoie rien si Claude ne renvoie pas de texte", async () => {
    agent.mockResolvedValue({ reply: '', handoff: null });
    await onIncoming(sock, incoming('...'));
    await settle();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it("une panne de l'API Claude ne fait pas planter le worker", async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    agent.mockRejectedValue(new Error('overloaded'));
    await onIncoming(sock, incoming('Bonjour'));
    await settle();

    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();

    // le client suivant est toujours servi
    agent.mockResolvedValue({ reply: 'Me revoilà', handoff: null });
    await onIncoming(sock, incoming('Allô ?'));
    await settle();
    expect(sent()).toEqual([[JID, 'Me revoilà']]);
    err.mockRestore();
  });
});

describe('historique envoyé à Claude', () => {
  it('commence toujours par un message user et reste limité à 20', async () => {
    for (let i = 0; i < 15; i++) {
      await fakeDb.from('wa_messages').insert({ wa_id: JID, wa_message_id: `old${i}`, role: 'user', content: `q${i}` });
      await fakeDb.from('wa_messages').insert({ wa_id: JID, role: 'assistant', content: `r${i}` });
    }
    await fakeDb.from('wa_conversations').upsert({ wa_id: JID }, { onConflict: 'wa_id' });
    agent.mockResolvedValue({ reply: 'ok', handoff: null });

    await onIncoming(sock, incoming('nouvelle question'));
    await settle();

    const history = agent.mock.calls[0][0];
    expect(history.length).toBeLessThanOrEqual(20);
    expect(history[0].role).toBe('user');
    expect(history.at(-1)).toEqual({ role: 'user', content: 'nouvelle question' });
  });

  it("n'inclut pas les notes système de transfert", async () => {
    await fakeDb.from('wa_conversations').upsert({ wa_id: JID }, { onConflict: 'wa_id' });
    await fakeDb.from('wa_messages').insert({ wa_id: JID, role: 'system', content: 'TRANSFERT: ancien' });
    agent.mockResolvedValue({ reply: 'ok', handoff: null });
    await onIncoming(sock, incoming('Bonjour'));
    await settle();
    expect(agent.mock.calls[0][0].some((t: any) => t.content.startsWith('TRANSFERT'))).toBe(false);
  });
});

describe('transfert à un humain', () => {
  it("passe en mode humain, alerte le propriétaire et l'IA se tait ensuite", async () => {
    process.env.OWNER_WHATSAPP = '237677000000';
    agent.mockResolvedValue({
      reply: "Je transmets à l'équipe.",
      handoff: { raison: 'Réclamation', resume: 'Colis reçu abîmé' },
    });

    await onIncoming(sock, incoming('Mon colis est arrivé cassé !'));
    await settle();

    expect(tables.wa_conversations[0].status).toBe('human');
    expect(tables.wa_messages.some((r) => r.role === 'system' && r.content.includes('Réclamation'))).toBe(true);
    expect(sent()).toEqual([
      [JID, "Je transmets à l'équipe."],
      ['237677000000@s.whatsapp.net', expect.stringContaining('Colis reçu abîmé')],
    ]);

    agent.mockClear();
    sock.sendMessage.mockClear();
    await onIncoming(sock, incoming('Vous êtes là ?'));
    await settle();

    expect(agent).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(tables.wa_messages.at(-1)).toMatchObject({ role: 'user', content: 'Vous êtes là ?' }); // toujours stocké
  });

  it("un échec d'alerte au propriétaire ne bloque pas le transfert", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.OWNER_WHATSAPP = '237677000000';
    sock.sendMessage = vi.fn(async (to: string) => {
      if (to.startsWith('237677')) throw new Error('not on whatsapp');
      return {};
    });
    agent.mockResolvedValue({ reply: 'Je transmets.', handoff: { raison: 'x', resume: 'y' } });
    await onIncoming(sock, incoming('Je veux parler à quelqu’un'));
    await settle();

    expect(tables.wa_conversations[0].status).toBe('human');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('reprise par le propriétaire depuis son téléphone', () => {
  const owner = (content: string, jids = [JID], id = `OWN${++n}`) =>
    onOwnerReply({ jids, key: { id, remoteJid: jids[0], fromMe: true }, content });

  it("annule la réponse en attente et l'IA se tait ensuite", async () => {
    agent.mockResolvedValue({ reply: 'ok', handoff: null });
    await onIncoming(sock, incoming('Bonjour, vous faites des sites ?'));
    await vi.advanceTimersByTimeAsync(45_000);
    await owner('Oui ! Je vous appelle dans 5 min.');
    await settle();

    expect(agent).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(tables.wa_conversations[0].status).toBe('human');
    expect(tables.wa_messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Oui ! Je vous appelle dans 5 min.' });

    await onIncoming(sock, incoming('Merci'));
    await settle();
    expect(agent).not.toHaveBeenCalled();
  });

  it("n'envoie pas la réponse si le propriétaire reprend pendant que Claude rédige", async () => {
    agent.mockImplementation(async () => {
      await owner('Je prends le relais.');
      return { reply: 'Réponse IA', handoff: null };
    });
    await onIncoming(sock, incoming('Bonjour'));
    await settle();

    expect(agent).toHaveBeenCalledOnce();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(tables.wa_messages.some((r) => r.content === 'Réponse IA')).toBe(false);
  });

  it("une conversation lancée par le propriétaire reste en mode humain", async () => {
    agent.mockResolvedValue({ reply: 'ok', handoff: null });
    await owner('Salut, voici le devis.');
    await onIncoming(sock, incoming('Merci, je regarde'));
    await settle();

    expect(tables.wa_conversations).toHaveLength(1);
    expect(tables.wa_conversations[0].status).toBe('human');
    expect(agent).not.toHaveBeenCalled();
  });

  it('retrouve la conversation connue sous son identifiant LID', async () => {
    const LID = '123456789@lid';
    agent.mockResolvedValue({ reply: 'ok', handoff: null });
    await onIncoming(sock, { ...incoming('Bonjour'), jid: LID });
    await owner('Bonjour, Pharel ici.', [JID, LID]);
    await settle();

    expect(tables.wa_conversations).toHaveLength(1);
    expect(tables.wa_conversations[0]).toMatchObject({ wa_id: LID, status: 'human' });
    expect(agent).not.toHaveBeenCalled();
  });

  it('ignore un message du propriétaire reçu deux fois', async () => {
    await owner('Bonjour', [JID], 'OWNDUP');
    await owner('Bonjour', [JID], 'OWNDUP');
    expect(tables.wa_messages).toHaveLength(1);
  });
});
