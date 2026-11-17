-- AI-written LinkedIn captions (kill switch default OFF): a private "in your own words" box on each entry, and an editable
-- writing guide (with its version history) stored as a setting. Nothing here is public or shown on the website.

alter table entries add column rough_notes text not null default '' check (char_length(rough_notes) <= 4000);

create table settings (
  key         text primary key,
  value       jsonb not null,
  version     integer not null default 1,
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);

create table settings_history (
  id          bigserial primary key,
  key         text not null,
  version     integer not null,
  value       jsonb not null,
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);
create index settings_history_key on settings_history (key, version desc);

-- Same lock-down as the other tables (see 002): no API role may read or write them.
alter table settings enable row level security;
alter table settings_history enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table settings, settings_history from %I', r);
      execute format('revoke all on sequence settings_history_id_seq from %I', r);
    end if;
  end loop;
end $$;
