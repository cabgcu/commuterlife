-- ============================================================================
-- Commuter Life — consolidated schema + realtime sync fix
--
-- This is a single, safe-to-run-anytime script that brings a Supabase
-- project's SQL up to date with everything index.html actually talks to.
-- It is 100% additive/idempotent:
--   * every CREATE TABLE uses IF NOT EXISTS — existing tables and their
--     rows (including your live app_state / app_state_history data) are
--     left completely untouched.
--   * every CREATE FUNCTION uses OR REPLACE — safe to re-run, just
--     redefines the function body.
--   * every trigger/policy is dropped-then-recreated by name, which does
--     not touch table data.
--   * GRANT/REVOKE only change permissions, never data.
--   * the realtime publication change is guarded so re-running it doesn't
--     error if app_state is already in the publication.
--
-- Nothing in this file can delete a row. Run the whole thing in the
-- Supabase SQL Editor (or `supabase db push`) whenever you're not sure
-- your project's SQL matches what's in this repo.
--
-- WHY YOU'RE SEEING SYNC ISSUES
-- ------------------------------
-- index.html opens a realtime channel on public.app_state
-- (`_supabase.channel('app_state_realtime').on('postgres_changes', ...)`,
-- around line 11796) so that when one device saves, every other open
-- device gets the new data pushed to it immediately. That only works if
-- the app_state table has been added to Supabase's `supabase_realtime`
-- publication — nothing in this repo's git history ever did that (it's a
-- step people usually do by hand in the dashboard and forget, or that
-- gets lost when a project is recreated). Without it, every client falls
-- back to polling on tab-focus/reconnect only, which is exactly the
-- "changes eventually show up, but not live, and sometimes clobber each
-- other" symptom. Section 6 below fixes that.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Base tables the app reads/writes directly.
--    (No-op if they already exist — your data is untouched.)
-- ----------------------------------------------------------------------------

create table if not exists public.app_state (
    id   bigint primary key,
    data jsonb  not null default '{}'::jsonb
);

comment on table public.app_state is
    'Single source of truth for the whole app. id=1 is the live row; ids 2-11 are rotating cloud backup slots (see CLOUD_BACKUP_SLOT_IDS in index.html).';

create table if not exists public.app_state_history (
    id            bigint generated always as identity primary key,
    app_state_id  bigint not null,
    data          jsonb  not null,
    change_type   text   not null,        -- 'UPDATE' or 'DELETE'
    changed_at    timestamptz not null default now()
);

create index if not exists app_state_history_lookup_idx
    on public.app_state_history (app_state_id, changed_at desc);

-- Secrets table used by the send-password-reset edge function
-- (supabase/functions/send-password-reset/index.ts reads BREVO_API_KEY
-- from here with the service-role key). Only create it if missing —
-- if it already exists with your BREVO_API_KEY row, that row is untouched.
create table if not exists public.app_secrets (
    key   text primary key,
    value text not null
);

comment on table public.app_secrets is
    'Server-side secrets (e.g. BREVO_API_KEY) read only by edge functions via the service-role key. Must never be selectable by anon/authenticated.';


-- ----------------------------------------------------------------------------
-- 2) app_state_history is an audit trail only — the trigger below (running
--    as table owner) is the only writer. Lock direct client access down.
-- ----------------------------------------------------------------------------

alter table public.app_state_history enable row level security;
revoke insert, update, delete on public.app_state_history from anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3) Snapshot every OLD row before it's changed or removed; block deletes
--    outright. (Final, bug-fixed version — returns NEW on UPDATE, not OLD,
--    otherwise every save silently reverts to the previous value.)
-- ----------------------------------------------------------------------------

create or replace function public.app_state_snapshot_before_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.app_state_history (app_state_id, data, change_type)
    values (old.id, old.data, tg_op);

    if tg_op = 'DELETE' then
        raise exception
            'app_state rows cannot be deleted (id=%). If you meant to reset the data, UPDATE it instead — the old value is preserved in app_state_history.',
            old.id;
    end if;

    return new; -- BEFORE UPDATE: let the update proceed with NEW as given
end;
$$;

drop trigger if exists trg_app_state_snapshot on public.app_state;
create trigger trg_app_state_snapshot
    before update or delete on public.app_state
    for each row
    execute function public.app_state_snapshot_before_change();

-- Belt-and-suspenders: revoke DELETE itself so even a direct SQL DELETE
-- from anon/authenticated (the roles the app's publishable key maps to)
-- is rejected before it reaches the trigger.
revoke delete on public.app_state from anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4) Reject an UPDATE that would overwrite real data with null/empty —
--    never a legitimate save, always a bug or a race.
-- ----------------------------------------------------------------------------

create or replace function public.app_state_reject_empty_overwrite()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.data is null or new.data = '{}'::jsonb then
        raise exception
            'Refusing to save empty/null data over app_state.id=% — this looks like a bug, not a real save. Previous value is in app_state_history.',
            old.id;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_app_state_reject_empty on public.app_state;
create trigger trg_app_state_reject_empty
    before update on public.app_state
    for each row
    execute function public.app_state_reject_empty_overwrite();


-- ----------------------------------------------------------------------------
-- 5) Make sure the app's publishable ("anon") key can actually do what
--    index.html needs: select/insert/update on app_state (never delete —
--    already revoked above). This is a reinforcement, not a behavior
--    change — the app already works today, so this should be a no-op,
--    but it makes the requirement explicit and self-healing if a grant
--    was ever dropped by hand in the dashboard.
-- ----------------------------------------------------------------------------

grant select, insert, update on public.app_state to anon, authenticated;

-- If Row Level Security is already enabled on app_state with your own
-- policies, DO NOT run the two lines below — they'd add a second,
-- wide-open policy alongside whatever you already have. Uncomment only
-- if `select relrowsecurity from pg_class where relname = 'app_state';`
-- returns true and you have no working policies:
--
-- alter table public.app_state enable row level security;
-- drop policy if exists app_state_allow_anon_all on public.app_state;
-- create policy app_state_allow_anon_all on public.app_state
--     for all to anon, authenticated using (true) with check (true);


-- ----------------------------------------------------------------------------
-- 6) Realtime: add app_state to the supabase_realtime publication so the
--    postgres_changes UPDATE listener in index.html actually fires. This
--    is almost certainly the missing piece behind "changes don't show up
--    on my other device until I switch tabs / refresh."
-- ----------------------------------------------------------------------------

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'app_state'
    ) then
        alter publication supabase_realtime add table public.app_state;
    end if;
end $$;


-- ----------------------------------------------------------------------------
-- 7) Lock down app_secrets — it holds BREVO_API_KEY. It must only ever be
--    reachable via the service-role key (edge functions), never via the
--    publishable/anon key that's embedded in index.html.
-- ----------------------------------------------------------------------------

alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
-- Intentionally no policies: RLS with zero policies denies anon/authenticated
-- entirely. service_role bypasses RLS by default, so edge functions still work.


-- ============================================================================
-- Restoring from history, if you ever need to:
--
--   select id, change_type, changed_at, jsonb_pretty(data)
--   from public.app_state_history
--   where app_state_id = 1
--   order by changed_at desc
--   limit 20;
--
--   update public.app_state
--   set data = (select data from public.app_state_history where id = <history_row_id>)
--   where id = 1;
-- ============================================================================
