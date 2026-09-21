-- H1 only. All business writes are transactional RPCs; no client table DML.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
revoke create on schema public from public, anon, authenticated;
do $$ begin if not exists(select 1 from pg_roles where rolname='fichaje_reader') then create role fichaje_reader; end if; end $$;
alter role fichaje_reader nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
do $$ begin if not exists(select 1 from pg_roles where rolname='fichaje_writer') then create role fichaje_writer; end if; end $$;
alter role fichaje_writer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant fichaje_reader, fichaje_writer to postgres;
grant usage on schema public, private, auth to fichaje_reader, fichaje_writer;
grant create on schema public,private to fichaje_reader,fichaje_writer;
grant execute on function auth.uid() to fichaje_reader, fichaje_writer;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;
create type public.member_role as enum ('OWNER','ADMIN','EMPLOYEE');
create table public.organizations (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) between 1 and 200),
 status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED')),
 created_at timestamptz not null default clock_timestamp()
);
create table public.memberships (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 auth_user_id uuid not null references auth.users(id) on delete restrict,
 role public.member_role not null,
 active boolean not null default true,
 version bigint not null default 1 check (version > 0),
 created_at timestamptz not null default clock_timestamp(),
 unique (organization_id,id), unique (organization_id,auth_user_id)
);
create index memberships_identity on public.memberships(auth_user_id,organization_id);
create table public.employees (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 code text not null check(length(btrim(code)) between 1 and 50),
 display_name text not null check(length(btrim(display_name)) between 1 and 200),
 membership_id uuid,
 active boolean not null default true,
 version bigint not null default 1 check(version > 0),
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), unique(organization_id,code), unique(organization_id,membership_id),
 foreign key(organization_id,membership_id) references public.memberships(organization_id,id) on delete restrict
);
create table public.audit_log (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 actor_kind text not null check(actor_kind in ('USER','SYSTEM')),
 actor_id uuid references auth.users(id) on delete restrict,
 employee_id uuid,
 action text not null, entity_type text not null, entity_id uuid not null,
 request_id uuid not null, server_at timestamptz not null default clock_timestamp(),
 safe_details jsonb not null default '{}',
 unique(organization_id,id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict
);
create index audit_tenant on public.audit_log(organization_id,server_at);
create table private.idempotency_records (
 organization_id uuid not null references public.organizations(id) on delete restrict,
 principal_kind text not null check(principal_kind in ('USER','SYSTEM')),
 principal_id uuid not null,
 operation text not null, key uuid not null,
 payload_sha256 text not null, response jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,principal_kind,principal_id,operation,key)
);
create table private.invitations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 email text not null check(length(email) between 3 and 254 and email = lower(btrim(email))),
 role public.member_role not null check(role <> 'OWNER'),
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
 accepted_by uuid references auth.users(id) on delete restrict,
 unique(organization_id,id),
 foreign key(organization_id,created_by) references public.memberships(organization_id,id) on delete restrict
);
-- Explicit privileges also override Supabase's default public-schema grants.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
grant select on public.organizations,public.memberships,public.employees,public.audit_log to authenticated;
grant select on public.organizations,public.memberships to fichaje_reader;
grant select,insert,update on public.organizations,public.memberships,public.employees to fichaje_writer;
grant select,insert on public.audit_log,private.idempotency_records to fichaje_writer;
grant select,insert,update on private.invitations to fichaje_writer;
-- Only verified Auth attributes are read; no user_metadata authorization.
grant select(id,email,email_confirmed_at,banned_until) on auth.users to fichaje_writer;
alter table public.organizations enable row level security;
alter table public.organizations force row level security;
create policy writer_access on public.organizations to fichaje_writer using (true) with check (true);
alter table public.memberships enable row level security;
alter table public.memberships force row level security;
create policy writer_access on public.memberships to fichaje_writer using (true) with check (true);
alter table public.employees enable row level security;
alter table public.employees force row level security;
create policy writer_access on public.employees to fichaje_writer using (true) with check (true);
alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;
create policy writer_access on public.audit_log to fichaje_writer using (true) with check (true);
alter table private.idempotency_records enable row level security;
alter table private.idempotency_records force row level security;
create policy writer_access on private.idempotency_records to fichaje_writer using (true) with check (true);
alter table private.invitations enable row level security;
alter table private.invitations force row level security;
create policy writer_access on private.invitations to fichaje_writer using (true) with check (true);
create policy reader_access on public.organizations for select to fichaje_reader using (true);
create policy reader_access on public.memberships for select to fichaje_reader using (true);

-- Separate read-only role avoids recursive memberships policy evaluation.
create function private.current_role(p_org uuid) returns public.member_role
language sql stable security definer set search_path = '' as $$
 select m.role from public.memberships m join public.organizations o on o.id=m.organization_id
 where m.organization_id=p_org and m.auth_user_id=(select auth.uid()) and m.active and o.status='ACTIVE'
$$;
alter function private.current_role(uuid) owner to fichaje_reader;
revoke all on function private.current_role(uuid) from public,anon;
grant execute on function private.current_role(uuid) to authenticated,fichaje_writer;

create policy organization_read on public.organizations for select to authenticated
 using(private.current_role(id) is not null);
create policy membership_read on public.memberships for select to authenticated
 using(private.current_role(organization_id) in ('OWNER','ADMIN') or
 (private.current_role(organization_id)='EMPLOYEE' and auth_user_id=(select auth.uid()) and active));
create policy employee_read on public.employees for select to authenticated
 using(private.current_role(organization_id) in ('OWNER','ADMIN') or
 (private.current_role(organization_id)='EMPLOYEE' and membership_id in
 (select m.id from public.memberships m where m.organization_id=employees.organization_id and m.auth_user_id=(select auth.uid()) and m.active)));
create policy audit_read on public.audit_log for select to authenticated
 using(private.current_role(organization_id) in ('OWNER','ADMIN'));

create function private.immutable_record() returns trigger
language plpgsql set search_path='' as $$
begin raise exception using errcode='42501',message='IMMUTABLE'; end $$;
revoke all on function private.immutable_record() from public,anon,authenticated;
create trigger audit_immutable before update or delete or truncate on public.audit_log
 for each statement execute function private.immutable_record();
create trigger idempotency_immutable before update or delete or truncate on private.idempotency_records
 for each statement execute function private.immutable_record();

-- Deferred invariant permits atomic transfer but never commits an ownerless tenant.
create function private.require_owner() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_org uuid;
begin
 if TG_TABLE_NAME='organizations' then v_org:=NEW.id;
 elsif TG_OP='DELETE' then v_org:=OLD.organization_id;
 else v_org:=NEW.organization_id; end if;
 perform 1 from public.organizations where id=v_org for update;
 if not exists(select 1 from public.memberships where organization_id=v_org and role='OWNER' and active)
 then raise exception using errcode='23514',message='LAST_OWNER'; end if;
 return null;
end $$;
alter function private.require_owner() owner to fichaje_writer;
revoke all on function private.require_owner() from public,anon,authenticated;
create constraint trigger organization_owner after insert on public.organizations
 deferrable initially deferred for each row execute function private.require_owner();
create constraint trigger membership_owner after insert or update or delete on public.memberships
 deferrable initially deferred for each row execute function private.require_owner();

-- Serializes H1 mutations per tenant. Re-check authorization AFTER acquiring the lock.
create function private.authorize(p_org uuid) returns public.member_role
language plpgsql set search_path='' as $$
declare v_role public.member_role;
begin
 if auth.uid() is null then raise exception using errcode='42501',message='UNAUTHENTICATED'; end if;
 -- Cheap denial before taking a lock on an unrelated organization.
 if private.current_role(p_org) is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform 1 from public.organizations where id=p_org and status='ACTIVE' for update;
 v_role:=private.current_role(p_org);
 if not FOUND or v_role is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 return v_role;
end $$;
create function private.replay(p_org uuid,p_request uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_row private.idempotency_records;
begin
 if p_request is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 select * into v_row from private.idempotency_records
 where organization_id=p_org and principal_kind='USER' and principal_id=auth.uid() and operation=p_operation and key=p_request;
 if FOUND then
  if v_row.payload_sha256<>encode(sha256(convert_to(p_payload::text,'UTF8')),'hex')
  then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
  return v_row.response;
 end if;
 return null;
end $$;
create function private.receipt(p_org uuid,p_request uuid,p_operation text,p_payload jsonb,p_response jsonb,p_entity text,p_id uuid)
returns jsonb language plpgsql set search_path='' as $$
begin
 insert into public.audit_log(organization_id,actor_kind,actor_id,action,entity_type,entity_id,request_id)
 values(p_org,'USER',auth.uid(),p_operation,p_entity,p_id,p_request);
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response)
 values(p_org,'USER',auth.uid(),p_operation,p_request,encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'),p_response);
 return p_response;
end $$;
revoke all on function private.authorize(uuid),private.replay(uuid,uuid,text,jsonb),private.receipt(uuid,uuid,text,jsonb,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function private.authorize(uuid),private.replay(uuid,uuid,text,jsonb),private.receipt(uuid,uuid,text,jsonb,jsonb,text,uuid) to fichaje_writer;

-- No API grant. Explicit operator transaction only; no signup trigger or self-service OWNER.
create function private.bootstrap_organization(p_org uuid,p_name text,p_owner uuid,p_request uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_array(p_name,p_owner); v_old private.idempotency_records;
begin
 if p_org is null or p_owner is null or p_request is null or p_name is null or length(btrim(p_name)) not between 1 and 200
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
 select * into v_old from private.idempotency_records where organization_id=p_org and principal_kind='SYSTEM'
 and principal_id=p_owner and operation='bootstrap' and key=p_request;
 if FOUND then
  if v_old.payload_sha256<>encode(sha256(convert_to(v_payload::text,'UTF8')),'hex')
  then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
  return p_org;
 end if;
 if not exists(select 1 from auth.users where id=p_owner and email_confirmed_at is not null and (banned_until is null or banned_until<clock_timestamp()))
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 insert into public.organizations(id,name) values(p_org,btrim(p_name));
 insert into public.memberships(organization_id,auth_user_id,role) values(p_org,p_owner,'OWNER');
 insert into public.audit_log(organization_id,actor_kind,action,entity_type,entity_id,request_id)
 values(p_org,'SYSTEM','bootstrap','organizations',p_org,p_request);
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response)
 values(p_org,'SYSTEM',p_owner,'bootstrap',p_request,encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'),jsonb_build_object('id',p_org));
 return p_org;
end $$;
alter function private.bootstrap_organization(uuid,text,uuid,uuid) owner to fichaje_writer;
revoke all on function private.bootstrap_organization(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.bootstrap_organization(uuid,text,uuid,uuid) to postgres;

create function public.manage_employee(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_expected_version bigint,
 p_code text,p_display_name text,p_membership_id uuid,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_row public.employees; v_result jsonb;
 v_payload jsonb:=jsonb_build_array(p_employee_id,p_expected_version,p_code,p_display_name,p_membership_id,p_active);
begin
 v_role:=private.authorize(p_organization_id);
 if v_role not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'manage_employee',v_payload);
 if v_result is not null then return v_result; end if;
 if p_employee_id is null or p_expected_version is null or p_active is null or p_code is null or p_display_name is null
 or length(btrim(p_code)) not between 1 and 50 or length(btrim(p_display_name)) not between 1 and 200
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 if p_membership_id is not null and not exists(select 1 from public.memberships where organization_id=p_organization_id and id=p_membership_id and active)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into v_row from public.employees where organization_id=p_organization_id and id=p_employee_id;
 if FOUND then
  if v_row.version<>p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
  update public.employees set code=btrim(p_code),display_name=btrim(p_display_name),membership_id=p_membership_id,active=p_active,version=version+1
  where organization_id=p_organization_id and id=p_employee_id returning * into v_row;
 else
  if p_expected_version<>0 then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
  insert into public.employees(id,organization_id,code,display_name,membership_id,active)
  values(p_employee_id,p_organization_id,btrim(p_code),btrim(p_display_name),p_membership_id,p_active) returning * into v_row;
 end if;
 return private.receipt(p_organization_id,p_request_id,'manage_employee',v_payload,jsonb_build_object('id',v_row.id,'version',v_row.version),'employees',v_row.id);
exception when unique_violation then raise exception using errcode='22023',message='INVALID_INPUT';
end $$;

create function public.manage_membership(p_organization_id uuid,p_request_id uuid,p_membership_id uuid,p_expected_version bigint,
 p_role public.member_role,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_row public.memberships; v_result jsonb;
 v_payload jsonb:=jsonb_build_array(p_membership_id,p_expected_version,p_role,p_active);
begin
 v_role:=private.authorize(p_organization_id);
 if v_role not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into v_row from public.memberships where organization_id=p_organization_id and id=p_membership_id;
 if not FOUND or v_row.role='OWNER' or p_role='OWNER' or (v_role='ADMIN' and (v_row.role<>'EMPLOYEE' or p_role<>'EMPLOYEE'))
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'manage_membership',v_payload);
 if v_result is not null then return v_result; end if;
 if p_role is null or p_active is null or p_expected_version is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 if v_row.version<>p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 update public.memberships set role=p_role,active=p_active,version=version+1
 where organization_id=p_organization_id and id=p_membership_id returning * into v_row;
 return private.receipt(p_organization_id,p_request_id,'manage_membership',v_payload,jsonb_build_object('id',v_row.id,'version',v_row.version),'memberships',v_row.id);
end $$;

create function public.transfer_ownership(p_organization_id uuid,p_request_id uuid,p_new_owner_membership_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_target public.memberships; v_result jsonb;
 v_payload jsonb:=jsonb_build_array(p_new_owner_membership_id,p_expected_version);
begin
 v_role:=private.authorize(p_organization_id);
 -- A previous owner (now ADMIN) can only replay an already committed transfer, never create another.
 if v_role not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'transfer_ownership',v_payload);
 if v_result is not null then return v_result; end if;
 if v_role<>'OWNER' then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into v_target from public.memberships where organization_id=p_organization_id and id=p_new_owner_membership_id and active and auth_user_id<>auth.uid();
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if p_expected_version is null or v_target.version<>p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 update public.memberships set role='ADMIN',version=version+1 where organization_id=p_organization_id and auth_user_id=auth.uid();
 update public.memberships set role='OWNER',version=version+1 where organization_id=p_organization_id and id=v_target.id;
 return private.receipt(p_organization_id,p_request_id,'transfer_ownership',v_payload,jsonb_build_object('id',v_target.id,'version',v_target.version+1),'memberships',v_target.id);
end $$;

-- Caller generates a 256-bit token locally; only its SHA-256 is retained.
-- Delivery is out-of-band in H1. No emails are sent by these functions.
create function public.create_invitation(p_organization_id uuid,p_request_id uuid,p_email text,p_role public.member_role,p_token_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_result jsonb; v_id uuid; v_actor uuid;
 v_payload jsonb:=jsonb_build_array(p_email,p_role,p_token_hash);
begin
 v_role:=private.authorize(p_organization_id);
 if v_role not in ('OWNER','ADMIN') or p_role='OWNER' or (v_role='ADMIN' and p_role<>'EMPLOYEE')
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'create_invitation',v_payload);
 if v_result is not null then return v_result; end if;
 if p_email is null or length(p_email) not between 3 and 254 or p_email<>lower(btrim(p_email)) or position('@' in p_email)<2
 or p_role is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 select id into v_actor from public.memberships where organization_id=p_organization_id and auth_user_id=auth.uid();
 insert into private.invitations(organization_id,email,role,token_hash,created_by)
 values(p_organization_id,p_email,p_role,p_token_hash,v_actor) returning id into v_id;
 return private.receipt(p_organization_id,p_request_id,'create_invitation',v_payload,jsonb_build_object('id',v_id),'invitations',v_id);
exception when unique_violation then raise exception using errcode='22023',message='INVALID_INPUT';
end $$;

create function public.accept_invitation(p_organization_id uuid,p_request_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_inv private.invitations; v_email text; v_id uuid; v_result jsonb; v_payload jsonb;
begin
 if auth.uid() is null then raise exception using errcode='42501',message='UNAUTHENTICATED'; end if;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_payload:=jsonb_build_array(encode(sha256(convert_to(p_token,'UTF8')),'hex'));
 select * into v_inv from private.invitations where organization_id=p_organization_id and token_hash=v_payload->>0;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform 1 from public.organizations where id=p_organization_id and status='ACTIVE' for update;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select lower(email) into v_email from auth.users where id=auth.uid() and email_confirmed_at is not null
 and (banned_until is null or banned_until<clock_timestamp());
 if v_email is null or v_email<>v_inv.email then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 -- Re-read after serialization. A consumed token only permits same-user/same-request replay while active.
 select * into v_inv from private.invitations where id=v_inv.id and organization_id=p_organization_id;
 if v_inv.accepted_by is not null then
  if v_inv.accepted_by<>auth.uid() or private.current_role(p_organization_id) is null
  then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  v_result:=private.replay(p_organization_id,p_request_id,'accept_invitation',v_payload);
  if v_result is not null then return v_result; end if;
  raise exception using errcode='42501',message='FORBIDDEN';
 end if;
 if v_inv.expires_at<=clock_timestamp() or not exists(select 1 from public.memberships
 where organization_id=p_organization_id and id=v_inv.created_by and active
 and (role='OWNER' or (role='ADMIN' and v_inv.role='EMPLOYEE')))
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'accept_invitation',v_payload);
 if v_result is not null then return v_result; end if;
 -- Existing memberships, including revoked ones, cannot be reactivated through invitations.
 if exists(select 1 from public.memberships where organization_id=p_organization_id and auth_user_id=auth.uid())
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 insert into public.memberships(organization_id,auth_user_id,role) values(p_organization_id,auth.uid(),v_inv.role) returning id into v_id;
 update private.invitations set accepted_by=auth.uid() where id=v_inv.id and organization_id=p_organization_id;
 return private.receipt(p_organization_id,p_request_id,'accept_invitation',v_payload,jsonb_build_object('id',v_id,'version',1),'memberships',v_id);
end $$;
alter function public.manage_employee(uuid,uuid,uuid,bigint,text,text,uuid,boolean) owner to fichaje_writer;
revoke all on function public.manage_employee(uuid,uuid,uuid,bigint,text,text,uuid,boolean) from public,anon,service_role;
grant execute on function public.manage_employee(uuid,uuid,uuid,bigint,text,text,uuid,boolean) to authenticated;
alter function public.manage_membership(uuid,uuid,uuid,bigint,public.member_role,boolean) owner to fichaje_writer;
revoke all on function public.manage_membership(uuid,uuid,uuid,bigint,public.member_role,boolean) from public,anon,service_role;
grant execute on function public.manage_membership(uuid,uuid,uuid,bigint,public.member_role,boolean) to authenticated;
alter function public.transfer_ownership(uuid,uuid,uuid,bigint) owner to fichaje_writer;
revoke all on function public.transfer_ownership(uuid,uuid,uuid,bigint) from public,anon,service_role;
grant execute on function public.transfer_ownership(uuid,uuid,uuid,bigint) to authenticated;
alter function public.create_invitation(uuid,uuid,text,public.member_role,text) owner to fichaje_writer;
revoke all on function public.create_invitation(uuid,uuid,text,public.member_role,text) from public,anon,service_role;
grant execute on function public.create_invitation(uuid,uuid,text,public.member_role,text) to authenticated;
alter function public.accept_invitation(uuid,uuid,text) owner to fichaje_writer;
revoke all on function public.accept_invitation(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.accept_invitation(uuid,uuid,text) to authenticated;

revoke create on schema public,private from fichaje_reader,fichaje_writer;
