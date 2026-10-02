-- H8 encrypted backup vault for a dedicated offsite PostgreSQL project.
-- Run only in the dedicated backup project/database, never in the application database.
create extension if not exists pgcrypto;
create schema if not exists backup_vault;
revoke all on schema backup_vault from public;

create table if not exists backup_vault.objects (
  object_key text primary key,
  backup_name text not null,
  content_type text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes >= 0),
  payload bytea not null,
  created_at timestamptz not null default clock_timestamp(),
  check (octet_length(payload)=size_bytes),
  check (encode(digest(payload,'sha256'),'hex')=sha256)
);
revoke all on backup_vault.objects from public;

create table if not exists backup_vault.purge_log (
  id bigint generated always as identity primary key,
  object_key text not null,
  sha256 text not null,
  size_bytes bigint not null,
  purged_at timestamptz not null default clock_timestamp(),
  reason text not null check (reason='RETENTION_35_DAYS')
);
revoke all on backup_vault.purge_log from public;

create or replace function backup_vault.block_update_truncate()
returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_BACKUP_VAULT';
end $$;

create or replace function backup_vault.guard_delete()
returns trigger language plpgsql as $$
begin
  if current_setting('backup_vault.retention_purge', true)='on'
     and old.created_at <= clock_timestamp()-interval '35 days' then
    return old;
  end if;
  raise exception 'IMMUTABLE_BACKUP_VAULT';
end $$;

drop trigger if exists immutable_update_truncate on backup_vault.objects;
create trigger immutable_update_truncate
before update or truncate on backup_vault.objects
for each statement execute function backup_vault.block_update_truncate();

drop trigger if exists retention_delete_guard on backup_vault.objects;
create trigger retention_delete_guard
before delete on backup_vault.objects
for each row execute function backup_vault.guard_delete();

create or replace function backup_vault.purge_expired()
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare n integer;
begin
  perform set_config('backup_vault.retention_purge','on',true);
  with doomed as (
    select object_key,sha256,size_bytes
    from backup_vault.objects
    where created_at <= clock_timestamp()-interval '35 days'
    for update
  ), logged as (
    insert into backup_vault.purge_log(object_key,sha256,size_bytes,reason)
    select object_key,sha256,size_bytes,'RETENTION_35_DAYS' from doomed
    returning object_key
  )
  delete from backup_vault.objects o
  using logged l
  where o.object_key=l.object_key;
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function backup_vault.purge_expired() from public;
