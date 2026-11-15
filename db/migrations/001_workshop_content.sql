-- JNR workshop content system. Plain Postgres (works on Supabase, Neon or any Postgres 13+).
-- Run with: npm run migrate   (scripts/migrate.js applies each file once, in name order)

create table users (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  name             text not null,
  role             text not null check (role in ('workshop','editor','admin')),
  password_hash    text not null,
  disabled         boolean not null default false,
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now()
);
create unique index users_email_lower on users (lower(email));

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  user_agent  text
);
create index sessions_user on sessions (user_id);

create table entries (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('in_production','completed','update')),
  status              text not null default 'draft'
                        check (status in ('draft','pending_approval','approved','rejected','published','failed')),
  -- Public-facing fields (only these ever reach the website or LinkedIn, and only via an approved snapshot)
  title               text not null check (char_length(title) between 3 and 120),
  summary             text not null check (char_length(summary) between 1 and 600),
  material            text not null default '' check (char_length(material) <= 200),
  process             text not null default '' check (char_length(process) <= 200),
  stage               text,
  body                text not null default '' check (char_length(body) <= 8000),
  is_case_study       boolean not null default false,
  event_date          date not null default current_date,
  -- Private fields: never copied into a snapshot, caption or page
  job_ref             text check (job_ref is null or char_length(job_ref) <= 60),
  customer_name       text check (customer_name is null or char_length(customer_name) <= 200),
  customer_notes      text check (customer_notes is null or char_length(customer_notes) <= 2000),
  internal_notes      text check (internal_notes is null or char_length(internal_notes) <= 4000),
  customer_public_ok  boolean not null default false,
  customer_public_label text check (customer_public_label is null or char_length(customer_public_label) <= 120),
  -- Publishing
  destinations        jsonb not null default '{"website": true, "linkedin": false}',
  caption             text not null default '' check (char_length(caption) <= 3000),
  caption_source      text not null default 'none' check (caption_source in ('none','template','ai','manual')),
  slug                text unique,
  version             integer not null default 1,
  created_by          uuid references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  submitted_at        timestamptz,
  reviewed_by         uuid references users(id),
  reviewed_at         timestamptz,
  review_note         text,
  approved_snapshot   jsonb,
  approved_at         timestamptz,
  live_snapshot       jsonb,
  live_at             timestamptz
);
create index entries_status on entries (status, updated_at desc);
create index entries_live on entries (live_at desc) where live_snapshot is not null;

create table entry_images (
  id             uuid primary key default gen_random_uuid(),
  entry_id       uuid not null references entries(id) on delete cascade,
  position       integer not null default 0,
  state          text not null default 'awaiting_upload' check (state in ('awaiting_upload','ready')),
  original_key   text not null,            -- private bucket, never public
  original_name  text,
  content_type   text not null,
  bytes          bigint,
  sha256         text,
  width          integer,
  height         integer,
  alt_text       text not null default '' check (char_length(alt_text) <= 300),
  cleared_for_public boolean not null default false,
  public_key     text,                      -- set only when an entry is approved
  public_thumb_key text,
  created_at     timestamptz not null default now()
);
create index entry_images_entry on entry_images (entry_id, position);
create unique index entry_images_dedupe on entry_images (entry_id, sha256) where sha256 is not null;

create table publications (
  id               uuid primary key default gen_random_uuid(),
  entry_id         uuid not null references entries(id) on delete cascade,
  destination      text not null check (destination in ('website','linkedin')),
  channel_id       text,
  content_hash     text not null,
  idempotency_key  text not null unique,
  status           text not null default 'pending'
                     check (status in ('pending','sending','saved','verified','failed','uncertain')),
  buffer_post_id   text,
  attempts         integer not null default 0,
  last_error       text,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index publications_entry on publications (entry_id);

create table idempotency_keys (
  key         text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  entry_id    uuid references entries(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  action      text not null,
  entry_id    uuid,
  detail      jsonb not null default '{}'
);
create index audit_entry on audit_log (entry_id, at desc);
create index audit_at on audit_log (at desc);
