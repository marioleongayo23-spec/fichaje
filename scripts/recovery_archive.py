"""Append-only schema of the independent recovery journal archive (H5, reused by H7).

The archive lives in a PostgreSQL instance whose persistence and custody are
independent from the application backup: restoring both to the same point would
void its guarantee. Used by the disposable CI journal (tests/integration/
journal_init.py), the REC drill (separate instance over verify-full TLS) and the
operator when provisioning the staging/production archive (docs/STAGING.md).
Only identifiers and recovery metadata are appended; entries are immutable and
finalized COMMITTED/ABORTED only by reconciliation against the live source.
"""

ARCHIVE_SCHEMA = '''create schema journal;
  revoke all on schema public from public;
  revoke all on database fichaje_recovery from public;
  grant connect on database fichaje_recovery to fichaje_archive_connection;
  grant usage on schema journal to fichaje_archive_connection,fichaje_archive_writer;
  grant create on schema journal to fichaje_archive_writer;
  create table journal.entries (
    ordinal bigint generated always as identity primary key,
    id uuid unique not null, source_id uuid not null, transaction_id text not null,
    organization_id uuid not null, kind text not null,
    payload jsonb not null, created_at timestamptz not null default clock_timestamp());
  create table journal.finalizations (
    id uuid primary key references journal.entries(id),
    outcome text not null check(outcome in ('COMMITTED','ABORTED')),
    created_at timestamptz not null default clock_timestamp());
  alter table journal.entries enable row level security;
  alter table journal.entries force row level security;
  alter table journal.finalizations enable row level security;
  alter table journal.finalizations force row level security;
  grant insert on journal.entries to fichaje_archive_writer;
  grant select on journal.entries,journal.finalizations to fichaje_archive_writer;
  grant usage on sequence journal.entries_ordinal_seq to fichaje_archive_writer;
  create policy append_only on journal.entries for insert to fichaje_archive_writer with check(true);
  create policy verifier_read on journal.entries for select to fichaje_archive_writer using(true);
  create policy verifier_read on journal.finalizations for select to fichaje_archive_writer using(true);
  create function journal.prepare(p_id uuid,p_source uuid,p_xid text,p_org uuid,p_kind text,p_payload jsonb)
  returns boolean language plpgsql security definer set search_path='' as $$
  begin
    if p_kind not in ('HOLD','IDENTITY_STATE','ORGANIZATION_STATE','PURGE') then
      raise exception 'INVALID_JOURNAL_KIND'; end if;
    insert into journal.entries(id,source_id,transaction_id,organization_id,kind,payload)
    values(p_id,p_source,p_xid,p_org,p_kind,p_payload);
    return true;
  end $$;
  alter function journal.prepare(uuid,uuid,text,uuid,text,jsonb) owner to fichaje_archive_writer;
  revoke all on function journal.prepare(uuid,uuid,text,uuid,text,jsonb) from public;
  grant execute on function journal.prepare(uuid,uuid,text,uuid,text,jsonb) to fichaje_archive_connection;
  create function journal.verify(p_id uuid,p_source uuid,p_org uuid,p_kind text,p_payload jsonb)
  returns boolean language sql stable security definer set search_path='' as $$
    select exists(select 1 from journal.entries e join journal.finalizations f on f.id=e.id
      where e.id=p_id and e.source_id=p_source and e.organization_id=p_org
      and e.kind=p_kind and e.payload=p_payload and f.outcome='COMMITTED')
  $$;
  alter function journal.verify(uuid,uuid,uuid,text,jsonb) owner to fichaje_archive_writer;
  revoke all on function journal.verify(uuid,uuid,uuid,text,jsonb) from public;
  grant execute on function journal.verify(uuid,uuid,uuid,text,jsonb) to fichaje_archive_connection;
  revoke create on schema journal from fichaje_archive_writer;
  create function journal.immutable() returns trigger language plpgsql as $$
  begin raise exception 'IMMUTABLE_JOURNAL'; end $$;
  create trigger immutable before update or delete or truncate on journal.entries
    for each statement execute function journal.immutable();
  create trigger immutable before update or delete or truncate on journal.finalizations
    for each statement execute function journal.immutable();'''
