-- Defence in depth for hosted Postgres such as Supabase, which exposes tables in the public schema through an HTTP API
-- using the public "anon" key. This application connects directly with its own database role and never uses that API, so:
--   1. turn on row level security for every table (with no policies, API roles can read and write nothing), and
--   2. remove any grants the API roles might have on them.
-- On plain Postgres this is harmless.
alter table users enable row level security;
alter table sessions enable row level security;
alter table entries enable row level security;
alter table entry_images enable row level security;
alter table publications enable row level security;
alter table idempotency_keys enable row level security;
alter table audit_log enable row level security;
alter table schema_migrations enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;
