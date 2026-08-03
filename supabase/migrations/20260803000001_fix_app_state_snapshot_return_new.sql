-- ============================================================================
-- Fix: app_state_snapshot_before_change() returned OLD instead of NEW on
-- UPDATE. In a BEFORE UPDATE row trigger, Postgres writes back whatever the
-- trigger function returns — returning `old` silently discarded every save
-- and rewrote the row with its previous value, with no error surfaced to the
-- client. This is why saves appeared to succeed but nothing ever persisted.
--
-- Safe to re-run: CREATE OR REPLACE.
-- ============================================================================

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
