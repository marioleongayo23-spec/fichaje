-- Synchronous write-ahead metadata in an independently retained PostgreSQL
-- database. No production connection is provisioned by this migration.
create extension if not exists dblink with schema extensions;
create role fichaje_journal nologin noinherit nobypassrls;
grant fichaje_journal to postgres;
grant usage,create on schema private to fichaje_journal;
grant usage on schema extensions to fichaje_journal;
grant execute on function extensions.dblink(text,text) to fichaje_journal;
create table private.journal_source(id uuid primary key default gen_random_uuid());
insert into private.journal_source default values;
create table private.recovery_outbox (
 id uuid primary key, source_id uuid not null, transaction_id xid8 not null,
 organization_id uuid not null, kind text not null, payload jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table private.recovery_replay_context (
 backend_pid integer not null, transaction_id xid8 not null,
 primary key(backend_pid,transaction_id)
);
do $$ declare t text; begin
 foreach t in array array['journal_source','recovery_outbox','recovery_replay_context'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('alter table private.%I force row level security',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
grant select on private.journal_source,private.recovery_replay_context to fichaje_journal;
grant insert on private.recovery_outbox to fichaje_journal;
grant select on private.recovery_outbox,private.journal_source to fichaje_retention;
grant select,insert,delete on private.recovery_replay_context to fichaje_retention;
create policy journal_source_read on private.journal_source for select to fichaje_journal,fichaje_retention using(true);
create policy journal_append on private.recovery_outbox for insert to fichaje_journal with check(true);
create policy journal_operator_read on private.recovery_outbox for select to fichaje_retention using(true);
create policy replay_context_read on private.recovery_replay_context for select to fichaje_journal using(true);
create policy replay_context_offline on private.recovery_replay_context to fichaje_retention using(true) with check(true);
create trigger immutable before update or delete or truncate on private.recovery_outbox
 for each statement execute function private.immutable_record();

create function private.journal_prepare(p_org uuid,p_kind text,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_source uuid; v_xid xid8; accepted boolean;
begin
 if exists(select 1 from private.recovery_replay_context where backend_pid=pg_catalog.pg_backend_pid()
  and transaction_id=pg_catalog.pg_current_xact_id()) then return null; end if;
 select id into strict v_source from private.journal_source;
 v_xid:=pg_catalog.pg_current_xact_id();
 -- dblink commits PREPARED before the local transaction can commit. A network
 -- or archive failure therefore aborts the local operation. A later reconciler
 -- uses pg_xact_status plus the transactional outbox to append COMMIT/ABORT.
 select ok into strict accepted from extensions.dblink('fichaje_recovery',format(
  'select journal.prepare(%L::uuid,%L::uuid,%L,%L::uuid,%L,%L::jsonb)',
  v_id,v_source,v_xid::text,p_org,p_kind,p_payload::text)) as result(ok boolean);
 if accepted is distinct from true then raise exception 'JOURNAL_UNAVAILABLE'; end if;
 insert into private.recovery_outbox(id,source_id,transaction_id,organization_id,kind,payload)
 values(v_id,v_source,v_xid,p_org,p_kind,p_payload);
 return v_id;
end $$;
alter function private.journal_prepare(uuid,text,jsonb) owner to fichaje_journal;
revoke all on function private.journal_prepare(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.journal_prepare(uuid,text,jsonb) to fichaje_retention;

create function private.verify_journal_entry(p_id uuid,p_org uuid,p_kind text,p_payload jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_source uuid; verified boolean;
begin
 select id into strict v_source from private.journal_source;
 select ok into strict verified from extensions.dblink('fichaje_recovery',format(
  'select journal.verify(%L::uuid,%L::uuid,%L::uuid,%L,%L::jsonb)',
  p_id,v_source,p_org,p_kind,p_payload::text)) as result(ok boolean);
 return verified is true;
end $$;
alter function private.verify_journal_entry(uuid,uuid,text,jsonb) owner to fichaje_journal;
revoke all on function private.verify_journal_entry(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.verify_journal_entry(uuid,uuid,text,jsonb) to fichaje_retention;

create function private.capture_recovery_state() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='legal_holds' then
  perform private.journal_prepare(new.organization_id,'HOLD',jsonb_build_object(
   'id',new.id,'employee_id',new.employee_id,'scope',new.scope,'release_of',new.release_of,
   'authorized_by',new.authorized_by,'created_at',new.created_at));
 elsif tg_table_name='organizations' then
  if new.status is distinct from old.status then
   perform private.journal_prepare(new.id,'ORGANIZATION_STATE',jsonb_build_object('id',new.id,'status',new.status));
  end if;
 elsif tg_table_name='memberships' then
  if new.active is distinct from old.active or new.role is distinct from old.role then
   perform private.journal_prepare(new.organization_id,'IDENTITY_STATE',jsonb_build_object(
    'table',tg_table_name,'id',new.id,'active',new.active,'version',new.version,'role',new.role));
  end if;
 elsif new.active is distinct from old.active or new.membership_id is distinct from old.membership_id then
  perform private.journal_prepare(new.organization_id,'IDENTITY_STATE',jsonb_build_object(
   'table',tg_table_name,'id',new.id,'active',new.active,'version',new.version,'membership_id',new.membership_id));
 end if;
 return new;
end $$;
alter function private.capture_recovery_state() owner to fichaje_journal;
revoke all on function private.capture_recovery_state() from public,anon,authenticated,service_role;
create trigger recovery_state after update on public.memberships for each row execute function private.capture_recovery_state();
create trigger recovery_state after update on public.employees for each row execute function private.capture_recovery_state();
create trigger recovery_state after update on public.organizations for each row execute function private.capture_recovery_state();
create trigger recovery_state after insert on private.legal_holds for each row execute function private.capture_recovery_state();
revoke create on schema private from fichaje_journal;
