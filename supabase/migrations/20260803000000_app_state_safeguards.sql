-- ============================================================================
-- app_state safety net
--
-- The whole app persists to a single row in public.app_state (id = 1,
-- data jsonb). That makes one bad write — an accidental DELETE, a client
-- bug that saves null/empty data, a stale save racing a newer one — capable
-- of wiping out the entire workspace with nothing to recover from.
--
-- This migration adds three independent layers of protection:
--   1. Every UPDATE/DELETE on app_state is snapshotted into
--      app_state_history first, so any bad write can be rolled back.
--   2. DELETE on app_state is blocked outright (trigger + revoked grant).
--      This table should only ever be updated, never have rows removed.
--   3. UPDATE is rejected if the new data is null or an empty object —
--      the app never legitimately saves that, so it can only be a bug.
--
-- Safe to re-run: every object below is created with IF NOT EXISTS / OR
-- REPLACE / DROP ... IF EXISTS first.
-- ============================================================================

-- 1) History table — full version history of app_state.data.
create table if not exists public.app_state_history (
    id bigint generated always as identity primary key,
    app_state_id bigint not null,
    data jsonb not null,
    change_type text not null,          -- 'UPDATE' or 'DELETE'
    changed_at timestamptz not null default now()
);

create index if not exists app_state_history_lookup_idx
    on public.app_state_history (app_state_id, changed_at desc);

-- Lock the history table down: it's an audit trail, not something the
-- app (anon/authenticated) should ever write to directly — only the
-- trigger below (running as the table owner) writes to it.
alter table public.app_state_history enable row level security;
revoke insert, update, delete on public.app_state_history from anon, authenticated;

-- 2) Snapshot every OLD row before it's changed or removed, and block deletes.
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

-- Belt-and-suspenders: also revoke the DELETE grant itself, so even a
-- direct SQL DELETE from the anon/authenticated roles the app uses is
-- rejected before it ever reaches the trigger.
revoke delete on public.app_state from anon, authenticated;

-- 3) Reject an UPDATE that would overwrite real data with null/empty —
-- never a legitimate save, always a bug or an accident.
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

-- ============================================================================
-- Restoring from history, if you ever need to:
--
--   -- 1. Find the version you want (most recent first):
--   select id, change_type, changed_at, jsonb_pretty(data)
--   from public.app_state_history
--   where app_state_id = 1
--   order by changed_at desc
--   limit 20;
--
--   -- 2. Restore it (this itself gets snapshotted by the trigger above,
--   --    so restoring is also undoable):
--   update public.app_state
--   set data = (select data from public.app_state_history where id = <history_row_id>)
--   where id = 1;
-- ============================================================================
