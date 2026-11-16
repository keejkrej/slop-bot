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
  run_id text,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on messages(conversation_id, created_at);
-- Bot output is owned by at most one durable run. Ordinary user/system
-- messages keep run_id null and are unaffected.
alter table messages add column if not exists run_id text;
create unique index if not exists messages_bot_run_idx on messages(run_id) where run_id is not null;

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

create table if not exists pending_actions (
  id text primary key,
  user_id text not null,
  conversation_id text not null,
  bot_id text not null,
  kind text not null,
  summary text not null,
  model_messages jsonb not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

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

-- Durable per-conversation agent runs. Additive migration: existing databases
-- gain the new columns/tables without rewriting prior rows.
alter table pending_actions add column if not exists run_id text;
alter table pending_actions add column if not exists provider_approval_id text;

create table if not exists runs (
  id text primary key,
  user_id text not null,
  conversation_id text not null references conversations(id) on delete cascade,
  bot_id text not null default '',
  status text not null default 'queued',
  trigger jsonb not null,
  attempt integer not null default 0,
  fence integer not null default 0,
  idempotency_key text,
  message_id text,
  action_id text,
  workflow_run_id text,
  output_message_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table runs add column if not exists bot_id text not null default '';
alter table runs add column if not exists workflow_run_id text;
alter table runs add column if not exists output_message_id text;
alter table runs add column if not exists lease_owner text;
alter table runs add column if not exists lease_expires_at timestamptz;
create unique index if not exists runs_idempotency_idx on runs(user_id, idempotency_key) where idempotency_key is not null;
-- One logical turn owns the active conversation slot.
create unique index if not exists runs_active_conversation_idx on runs(conversation_id) where status in ('queued', 'running', 'awaiting_approval');
create index if not exists runs_conversation_idx on runs(conversation_id, created_at);

create table if not exists run_events (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  seq integer not null,
  type text not null,
  data jsonb,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create unique index if not exists run_events_seq_idx on run_events(run_id, seq);
create unique index if not exists run_events_dedupe_idx on run_events(run_id, dedupe_key) where dedupe_key is not null;

create table if not exists run_timers (
  id text primary key,
  user_id text not null,
  run_id text not null references runs(id) on delete cascade,
  kind text not null,
  due_at timestamptz not null,
  status text not null default 'pending',
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists run_timers_run_kind_idx on run_timers(run_id, kind);
create index if not exists run_timers_due_idx on run_timers(status, due_at);

-- User-managed proactive automation tasks and their durable occurrences.
create table if not exists automation_tasks (
  id text primary key,
  user_id text not null,
  bot_id text not null,
  conversation_id text not null references conversations(id) on delete cascade,
  title text not null,
  instructions text not null,
  schedule jsonb not null,
  status text not null default 'active',
  next_due_at timestamptz,
  last_occurred_at timestamptz,
  last_error text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table automation_tasks add column if not exists revision integer not null default 0;
create index if not exists automation_tasks_due_idx on automation_tasks(status, next_due_at);
create index if not exists automation_tasks_user_idx on automation_tasks(user_id, created_at);

create table if not exists automation_occurrences (
  id text primary key,
  task_id text not null references automation_tasks(id) on delete cascade,
  user_id text not null,
  occurrence_at timestamptz not null,
  execution_id text not null,
  run_id text,
  workflow_run_id text,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists automation_occurrences_task_at_idx on automation_occurrences(task_id, occurrence_at);
create unique index if not exists automation_occurrences_execution_idx on automation_occurrences(execution_id);
create index if not exists automation_occurrences_open_idx on automation_occurrences(status) where run_id is not null;
-- Bounded retry scan for durably reserved occurrences that never got a run.
create index if not exists automation_occurrences_pending_idx on automation_occurrences(occurrence_at) where run_id is null and status = 'queued';

create table if not exists run_claims (
  user_id text not null,
  idempotency_key text not null,
  run_id text not null references runs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

-- Per-user read bookmarks for unread bot-message counts. Additive and
-- legacy-safe: existing databases simply gain an empty table.
create table if not exists conversation_reads (
  user_id text not null,
  conversation_id text not null references conversations(id) on delete cascade,
  last_read_at timestamptz not null,
  last_read_message_id text,
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
create index if not exists conversation_reads_user_idx on conversation_reads(user_id);
-- Bounded unread scan: one user's bot messages ordered by time.
create index if not exists messages_user_sender_created_idx on messages(user_id, sender_type, created_at);
