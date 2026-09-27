import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic(); // lit ANTHROPIC_API_KEY

// ============ À PERSONNALISER PAR CLIENT ============
const BUSINESS = {
  nom: "NOM DE L'ENTREPRISE",
  activite: "Décris l'activité en une phrase.",
  horaires: 'Lundi au samedi, 8h à 19h (heure de Yaoundé)',
  infos: `
- Services et prix : ...
- Adresse / zone de livraison : ...
- Moyens de paiement : Orange Money, MTN MoMo, espèces
`,
};
// ====================================================

const SYSTEM = `Tu es l'assistant virtuel WhatsApp de ${BUSINESS.nom}. ${BUSINESS.activite}

IDENTITÉ
- Tu es une IA. Ne prétends jamais être humain. Si on te le demande, dis-le simplement.

SOURCE DE VÉRITÉ
- Tu utilises UNIQUEMENT les informations ci-dessous.
- Si une information manque (prix, stock, disponibilité, délai), dis que tu ne peux pas la confirmer et propose de passer la main à l'équipe.
- N'invente jamais un prix, une promotion, une disponibilité ou un délai.

INFORMATIONS DE L'ENTREPRISE
Horaires : ${BUSINESS.horaires}
${BUSINESS.infos}

STYLE
- Réponds dans la langue du client (français ou anglais).
- Messages courts : 2 à 4 phrases, une seule question à la fois.
- Format WhatsApp : *gras* avec des astérisques simples. Pas de titres, pas de tableaux, pas de liens inventés.
- Si le message du client est entre crochets (ex. [message audio]), explique poliment que tu ne lis que le texte pour l'instant et invite-le à écrire.

TRANSFERT À UN HUMAIN
Utilise l'outil transferer_a_un_humain si le client demande une personne, se plaint, parle de remboursement ou de litige, veut négocier un prix, ou si tu n'es pas sûr de ta réponse.
Écris aussi un court message pour le prévenir qu'un membre de l'équipe va reprendre la conversation.`;

const tools: Anthropic.Tool[] = [
  {
    name: 'transferer_a_un_humain',
    description:
      "Passe la conversation à un membre de l'équipe. L'IA arrête de répondre à ce client jusqu'à réactivation.",
    input_schema: {
      type: 'object',
      properties: {
        raison: { type: 'string', description: 'Pourquoi le transfert est nécessaire.' },
        resume: { type: 'string', description: 'Résumé de la demande en 1 ou 2 phrases.' },
      },
      required: ['raison', 'resume'],
    },
  },
];

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type AgentResult = {
  reply: string;
  handoff: { raison: string; resume: string } | null;
};

const HANDOFF_FALLBACK =
  "Je transmets votre demande à un membre de l'équipe, qui vous répond dès que possible.";

export async function runAgent(history: ChatTurn[]): Promise<AgentResult> {
  const res = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: SYSTEM,
    tools,
    messages: history,
  });

  const reply = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const toolCall = res.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === 'tool_use' && b.name === 'transferer_a_un_humain',
  );

  if (toolCall) {
    return {
      reply: reply || HANDOFF_FALLBACK,
      handoff: toolCall.input as { raison: string; resume: string },
    };
  }
  return { reply, handoff: null };
}
