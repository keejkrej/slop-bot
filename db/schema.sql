create table if not exists bots (
  id text primary key,
  user_id text not null,
  name text not null,
  handle text not null,
  persona text not null,
  model text not null,
  color text not null,
  integration_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, handle)
);

create table if not exists conversations (
  id text primary key,
  user_id text not null,
  title text not null,
  bot_ids jsonb not null,
  active_run_id text,
  run_status text not null default 'idle',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  user_id text not null,
  sender_type text not null,
  sender_id text not null,
  content text not null,
  status text not null default 'complete',
  error text,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on messages(conversation_id, created_at);

create table if not exists integrations (
  id text primary key,
  user_id text not null,
  kind text not null,
  name text not null,
  url text not null,
  description text not null,
  status text not null,
  tool_count integer not null default 0,
  last_error text,
  secret_ciphertext text,
  created_at timestamptz not null default now()
);

create table if not exists oauth_states (
  state text primary key,
  integration_id text not null,
  user_id text not null,
  platform text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists oauth_states_expires_idx on oauth_states(expires_at);

create table if not exists desktop_jobs (
  id text primary key,
  user_id text not null,
  device_id text not null,
  integration_id text not null,
  tool_name text not null,
  args jsonb not null,
  status text not null default 'pending',
  output jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists desktop_jobs_pending_idx on desktop_jobs(user_id, device_id, status);
