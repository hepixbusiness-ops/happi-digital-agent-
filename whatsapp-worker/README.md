# Agent WhatsApp (Baileys + Claude)

Répond automatiquement aux clients qui écrivent au numéro, mémorise les conversations
dans Supabase et passe la main à un humain quand il le faut.

## 1. Base de données

Migration déjà appliquée sur le projet Supabase `happi-digital-agent`
(tables `wa_conversations` et `wa_messages`). Pour un autre projet : exécuter
`supabase/migrations/001_whatsapp_agent.sql` dans l'éditeur SQL.

## 2. Personnaliser l'entreprise

Remplir le bloc `BUSINESS` en haut de `src/agent.ts` : nom, activité, horaires,
services et prix, zone de livraison, moyens de paiement. L'IA n'utilise que ces
informations.

## 3. Variables d'environnement

```bash
cp .env.example .env
```

| Variable | Où la trouver |
| --- | --- |
| `ANTHROPIC_API_KEY` | console.anthropic.com > API Keys |
| `SUPABASE_URL` | `https://vuzjrsgobeevfqjmsgsm.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase > Project Settings > API Keys > `service_role` (secrète, jamais côté navigateur) |
| `PAIRING_NUMBER` | Numéro à connecter, format `2376XXXXXXXX`. Vide = QR code |
| `OWNER_WHATSAPP` | Ton numéro perso pour les alertes de transfert (optionnel) |

## 4. Lancer

Il faut une machine allumée en permanence (VPS type Hetzner, Contabo, OVH,
~4 €/mois, avec Docker). Pas Vercel ni une fonction serverless : le worker garde
une connexion WhatsApp ouverte.

```bash
docker compose up -d --build
docker compose logs -f
```

Au premier lancement, les logs affichent un **code d'appairage** (si
`PAIRING_NUMBER` est rempli) ou un **QR code**. Sur le téléphone du numéro :
WhatsApp > Appareils connectés > Connecter un appareil. Le log `✅ WhatsApp connecté`
confirme. La session est gardée dans `./auth` : ne pas supprimer ce dossier.

En local, pour tester : `npm install` puis `npm run dev`.

## Au quotidien

- **Reprendre une conversation à la main** : réponds simplement depuis ton
  téléphone (ou WhatsApp Web). Dès ton premier message, l'IA se tait pour ce
  client (`wa_conversations.status = 'human'`). Même chose quand l'IA transfère
  elle-même, ou quand c'est toi qui écris en premier à quelqu'un.
  Limite : un message envoyé pendant que le worker était arrêté n'est pas vu.
- **Rendre la main à l'IA** : dans Supabase,
  `update wa_conversations set status = 'bot' where wa_id = '...';`
- **Session perdue** (`❌ Session déconnectée`) : supprimer `auth/` et relancer
  pour reconnecter le numéro.

## Bon à savoir

Baileys n'est pas l'API officielle de WhatsApp. Utilise un numéro dédié (pas ton
numéro principal), laisse l'agent répondre seulement à ceux qui écrivent, et
n'envoie pas de messages en masse : c'est ce qui fait bannir un numéro.

## Tests

```bash
npm run typecheck && npm test
```
