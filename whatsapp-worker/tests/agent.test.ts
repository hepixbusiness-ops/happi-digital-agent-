import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create }; },
}));

import { runAgent } from '../src/agent.ts';

const history = [{ role: 'user' as const, content: 'Bonjour' }];

beforeEach(() => create.mockReset());

describe('runAgent', () => {
  it('renvoie le texte de Claude', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '  Bonjour !  ' }] });
    expect(await runAgent(history)).toEqual({ reply: 'Bonjour !', handoff: null });
  });

  it("envoie le prompt système, l'outil de transfert et l'historique", async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await runAgent(history);
    const args = create.mock.calls[0][0];
    expect(args.system).toContain('Ne prétends jamais être humain');
    expect(args.tools.map((t: any) => t.name)).toEqual(['transferer_a_un_humain']);
    expect(args.messages).toEqual(history);
  });

  it('détecte un transfert accompagné de texte', async () => {
    create.mockResolvedValue({
      content: [
        { type: 'text', text: "Un collègue va vous répondre." },
        { type: 'tool_use', name: 'transferer_a_un_humain', input: { raison: 'Litige', resume: 'Remboursement' } },
      ],
    });
    expect(await runAgent(history)).toEqual({
      reply: 'Un collègue va vous répondre.',
      handoff: { raison: 'Litige', resume: 'Remboursement' },
    });
  });

  it('utilise un message par défaut si le transfert arrive sans texte', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'transferer_a_un_humain', input: { raison: 'r', resume: 's' } }],
    });
    const res = await runAgent(history);
    expect(res.reply).toMatch(/membre de l'équipe/);
    expect(res.handoff).not.toBeNull();
  });
});
