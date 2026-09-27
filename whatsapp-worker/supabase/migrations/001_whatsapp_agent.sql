-- Conversations : une ligne par numéro WhatsApp
create table if not exists wa_conversations (
  wa_id           text primary key,              -- numéro du client (format international sans +)
  name            text,
  status          text not null default 'bot' check (status in ('bot', 'human')),
  last_inbound_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Messages : historique envoyé à Claude + déduplication des webhooks
create table if not exists wa_messages (
  id            bigint generated always as identity primary key,
  wa_id         text not null references wa_conversations (wa_id) on delete cascade,
  wa_message_id text unique,                     -- ID Meta : bloque les webhooks en double
  role          text not null check (role in ('user', 'assistant', 'system')),
  content       text not null,
  created_at    timestamptz not null default now()
);

create index if not exists wa_messages_wa_id_created_idx
  on wa_messages (wa_id, created_at desc);

-- RLS activée sans policy : seule la service role key (serveur) peut lire/écrire
alter table wa_conversations enable row level security;
alter table wa_messages enable row level security;
