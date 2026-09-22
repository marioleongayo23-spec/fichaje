-- SEC-H1-01: protected, transaction-bound capabilities. No client-settable GUC.
do $$ begin if not exists(select 1 from pg_roles where rolname='fichaje_guard') then create role fichaje_guard nologin noinherit; end if; end $$;
do $$ begin if exists(select 1 from pg_roles where rolname='fichaje_guard' and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolbypassrls)) then raise exception 'UNSAFE_TECHNICAL_ROLE'; end if; end $$;
grant fichaje_guard to postgres;
grant usage,create on schema private to fichaje_guard;
grant usage on schema public to fichaje_guard;
do $$ begin if not exists(select 1 from pg_roles where rolname='fichaje_bootstrap') then create role fichaje_bootstrap nologin noinherit; end if; end $$;
do $$ begin if exists(select 1 from pg_roles where rolname='fichaje_bootstrap' and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolbypassrls)) then raise exception 'UNSAFE_TECHNICAL_ROLE'; end if; end $$;
grant fichaje_bootstrap to postgres;
grant usage,create on schema private to fichaje_bootstrap;
grant usage on schema public to fichaje_bootstrap;
do $$ begin if not exists(select 1 from pg_roles where rolname='fichaje_acceptor') then create role fichaje_acceptor nologin noinherit; end if; end $$;
do $$ begin if exists(select 1 from pg_roles where rolname='fichaje_acceptor' and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolbypassrls)) then raise exception 'UNSAFE_TECHNICAL_ROLE'; end if; end $$;
grant fichaje_acceptor to postgres;
grant usage,create on schema private to fichaje_acceptor;
grant usage on schema public to fichaje_acceptor;
grant create on schema public to fichaje_acceptor;
grant execute on function private.request_uid(),private.verified_auth_email(uuid) to fichaje_guard;
grant execute on function private.request_uid(),private.verified_auth_email(uuid),private.current_role(uuid) to fichaje_bootstrap,fichaje_acceptor;
grant execute on function private.current_role(uuid) to fichaje_guard;
create table private.mutation_context (
 transaction_id xid8 not null,
 backend_pid integer not null,
 route text not null check(route in ('member','bootstrap','invitation')),
 organization_id uuid not null,
 principal_id uuid,
 subject_id uuid,
 invited_role public.member_role,
 primary key(transaction_id,backend_pid,route)
);
-- Deliberately no organization FK: bootstrap authorizes the new root before its INSERT.
alter table private.mutation_context enable row level security;
alter table private.mutation_context force row level security;
revoke all on private.mutation_context from public,anon,authenticated,service_role,fichaje_writer,fichaje_bootstrap,fichaje_acceptor;
grant select,insert,delete on private.mutation_context to fichaje_guard;
create policy context_guard on private.mutation_context to fichaje_guard using(true) with check(true);
grant select on public.organizations,public.memberships,private.invitations to fichaje_guard;
create policy guard_read on public.organizations for select to fichaje_guard using(true);
create policy guard_read on public.memberships for select to fichaje_guard using(true);
create policy guard_read on private.invitations for select to fichaje_guard using(true);

create function private.bind_context(p_org uuid,p_route text,p_subject uuid default null,p_role public.member_role default null)
returns void language plpgsql set search_path='' as $$
begin
 delete from private.mutation_context where transaction_id<>pg_current_xact_id();
 insert into private.mutation_context values(pg_current_xact_id(),pg_backend_pid(),p_route,p_org,private.request_uid(),p_subject,p_role)
 on conflict do nothing;
 if not exists(select 1 from private.mutation_context where transaction_id=pg_current_xact_id() and backend_pid=pg_backend_pid()
 and route=p_route and organization_id=p_org and principal_id is not distinct from private.request_uid()
 and subject_id is not distinct from p_subject and invited_role is not distinct from p_role)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
end $$;
revoke all on function private.bind_context(uuid,text,uuid,public.member_role) from public,anon,authenticated,service_role;
grant execute on function private.bind_context(uuid,text,uuid,public.member_role) to fichaje_guard;

create function private.member_scope(p_org uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if private.current_role(p_org) not in ('OWNER','ADMIN') or private.current_role(p_org) is null
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.bind_context(p_org,'member');
end $$;
alter function private.member_scope(uuid) owner to fichaje_guard;
revoke all on function private.member_scope(uuid) from public,anon,authenticated,service_role;
grant execute on function private.member_scope(uuid) to fichaje_writer;

create function private.invitation_scope(p_org uuid,p_token text) returns void
language plpgsql security definer set search_path='' as $$
declare v private.invitations;
begin
 select i.* into v from private.invitations i join public.organizations o on o.id=i.organization_id
 where i.organization_id=p_org and i.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and o.status='ACTIVE'
 and i.email=private.verified_auth_email(private.request_uid());
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if v.accepted_by is null then
  if v.expires_at<=clock_timestamp() or not exists(select 1 from public.memberships where organization_id=p_org
   and id=v.created_by and active and (role='OWNER' or (role='ADMIN' and v.role='EMPLOYEE')))
  then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 elsif v.accepted_by<>private.request_uid() or private.current_role(p_org) is null then
  raise exception using errcode='42501',message='FORBIDDEN';
 end if;
 perform private.bind_context(p_org,'invitation',v.id,v.role);
end $$;
alter function private.invitation_scope(uuid,text) owner to fichaje_guard;
revoke all on function private.invitation_scope(uuid,text) from public,anon,authenticated,service_role,fichaje_writer;
grant execute on function private.invitation_scope(uuid,text) to fichaje_acceptor;

create function private.bootstrap_scope(p_org uuid,p_owner uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_org is null or private.verified_auth_email(p_owner) is null then
 raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 perform private.bind_context(p_org,'bootstrap',p_owner);
end $$;
alter function private.bootstrap_scope(uuid,uuid) owner to fichaje_guard;
revoke all on function private.bootstrap_scope(uuid,uuid) from public,anon,authenticated,service_role,fichaje_writer;
grant execute on function private.bootstrap_scope(uuid,uuid) to fichaje_bootstrap;

create function private.scoped_tenant(p_route text) returns uuid
language sql stable security definer set search_path='' as $$
 select organization_id from private.mutation_context where transaction_id=pg_current_xact_id() and backend_pid=pg_backend_pid()
 and route=p_route and principal_id is not distinct from private.request_uid()
$$;
alter function private.scoped_tenant(text) owner to fichaje_guard;
revoke all on function private.scoped_tenant(text) from public,anon,authenticated,service_role;
grant execute on function private.scoped_tenant(text) to fichaje_writer,fichaje_bootstrap,fichaje_acceptor;
create function private.scoped_subject(p_route text) returns uuid
language sql stable security definer set search_path='' as $$
 select subject_id from private.mutation_context where transaction_id=pg_current_xact_id() and backend_pid=pg_backend_pid()
 and route=p_route and principal_id is not distinct from private.request_uid()
$$;
alter function private.scoped_subject(text) owner to fichaje_guard;
revoke all on function private.scoped_subject(text) from public,anon,authenticated,service_role;
grant execute on function private.scoped_subject(text) to fichaje_bootstrap,fichaje_acceptor;
create function private.scoped_invited_role() returns public.member_role
language sql stable security definer set search_path='' as $$
 select invited_role from private.mutation_context where transaction_id=pg_current_xact_id() and backend_pid=pg_backend_pid()
 and route='invitation' and principal_id=private.request_uid()
$$;
alter function private.scoped_invited_role() owner to fichaje_guard;
revoke all on function private.scoped_invited_role() from public,anon,authenticated,service_role;
grant execute on function private.scoped_invited_role() to fichaje_acceptor;
-- Capabilities expire by xid8, not a client clock. Remove visible contexts from
-- committed transactions on the next bind; uncommitted contexts are invisible by MVCC.
create function private.release_bootstrap_scope() returns void
language sql security definer set search_path='' as $$
 delete from private.mutation_context where transaction_id=pg_current_xact_id() and backend_pid=pg_backend_pid() and route='bootstrap'
$$;
alter function private.release_bootstrap_scope() owner to fichaje_guard;
revoke all on function private.release_bootstrap_scope() from public,anon,authenticated,service_role,fichaje_writer;
grant execute on function private.release_bootstrap_scope() to fichaje_bootstrap;
drop policy writer_access on public.organizations;
create policy writer_access on public.organizations to fichaje_writer using(id=private.scoped_tenant('member')) with check(id=private.scoped_tenant('member'));
drop policy writer_access on public.memberships;
create policy writer_access on public.memberships to fichaje_writer using(organization_id=private.scoped_tenant('member')) with check(organization_id=private.scoped_tenant('member'));
drop policy writer_access on public.employees;
create policy writer_access on public.employees to fichaje_writer using(organization_id=private.scoped_tenant('member')) with check(organization_id=private.scoped_tenant('member'));
drop policy writer_access on public.audit_log;
create policy writer_access on public.audit_log to fichaje_writer using(organization_id=private.scoped_tenant('member')) with check(organization_id=private.scoped_tenant('member'));
drop policy writer_access on private.idempotency_records;
create policy writer_access on private.idempotency_records to fichaje_writer using(organization_id=private.scoped_tenant('member')) with check(organization_id=private.scoped_tenant('member'));
drop policy writer_access on private.invitations;
create policy writer_access on private.invitations to fichaje_writer using(organization_id=private.scoped_tenant('member')) with check(organization_id=private.scoped_tenant('member'));
-- Specialized routes have no UPDATE of security roles and no access to employees.
grant select,insert on public.organizations,public.memberships,public.audit_log,private.idempotency_records to fichaje_bootstrap;
grant select on public.organizations,public.memberships,private.invitations,public.audit_log,private.idempotency_records to fichaje_acceptor;
grant update(id) on public.organizations to fichaje_acceptor;
grant insert on public.memberships,public.audit_log,private.idempotency_records to fichaje_acceptor;
grant update(accepted_by) on private.invitations to fichaje_acceptor;
create policy bootstrap_access on public.organizations to fichaje_bootstrap using(id=private.scoped_tenant('bootstrap')) with check(id=private.scoped_tenant('bootstrap'));
create policy bootstrap_access on public.memberships to fichaje_bootstrap using(organization_id=private.scoped_tenant('bootstrap')) with check(organization_id=private.scoped_tenant('bootstrap') and role='OWNER' and active and auth_user_id=private.scoped_subject('bootstrap'));
create policy bootstrap_access on public.audit_log to fichaje_bootstrap using(organization_id=private.scoped_tenant('bootstrap')) with check(organization_id=private.scoped_tenant('bootstrap'));
create policy bootstrap_access on private.idempotency_records to fichaje_bootstrap using(organization_id=private.scoped_tenant('bootstrap')) with check(organization_id=private.scoped_tenant('bootstrap'));
create policy invitation_access on public.organizations to fichaje_acceptor using(id=private.scoped_tenant('invitation')) with check(id=private.scoped_tenant('invitation'));
create policy invitation_access on public.memberships to fichaje_acceptor using(organization_id=private.scoped_tenant('invitation')) with check(organization_id=private.scoped_tenant('invitation') and role=private.scoped_invited_role() and active and auth_user_id=private.request_uid());
create policy invitation_access on public.audit_log to fichaje_acceptor using(organization_id=private.scoped_tenant('invitation')) with check(organization_id=private.scoped_tenant('invitation'));
create policy invitation_access on private.idempotency_records to fichaje_acceptor using(organization_id=private.scoped_tenant('invitation')) with check(organization_id=private.scoped_tenant('invitation'));
create policy invitation_access on private.invitations to fichaje_acceptor using(organization_id=private.scoped_tenant('invitation') and id=private.scoped_subject('invitation')) with check(organization_id=private.scoped_tenant('invitation') and id=private.scoped_subject('invitation') and accepted_by=private.request_uid());
create or replace function private.require_owner() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_org uuid;
begin
 if TG_TABLE_NAME='organizations' then v_org:=NEW.id;
 elsif TG_OP='DELETE' then v_org:=OLD.organization_id;
 else v_org:=NEW.organization_id; end if;

 if not exists(select 1 from public.memberships where organization_id=v_org and role='OWNER' and active)
 then raise exception using errcode='23514',message='LAST_OWNER'; end if;
 return null;
end $$;
alter function private.require_owner() owner to fichaje_reader;
create or replace function private.authorize(p_org uuid) returns public.member_role
language plpgsql set search_path='' as $$
declare v_role public.member_role;
begin
 if private.request_uid() is null then raise exception using errcode='42501',message='UNAUTHENTICATED'; end if;
 -- Cheap denial before taking a lock on an unrelated organization.
 if private.current_role(p_org) is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.member_scope(p_org);
 perform 1 from public.organizations where id=p_org and status='ACTIVE' for update;
 v_role:=private.current_role(p_org);
 if not FOUND or v_role is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 return v_role;
end $$;
create or replace function private.receipt(p_org uuid,p_request uuid,p_operation text,p_payload jsonb,p_response jsonb,p_entity text,p_id uuid,p_details jsonb)
returns jsonb language plpgsql set search_path='' as $$
begin
 insert into public.audit_log(organization_id,actor_kind,actor_id,action,entity_type,entity_id,request_id,safe_details)
 values(p_org,'USER',private.request_uid(),p_operation,p_entity,p_id,p_request,p_details);
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response)
 values(p_org,'USER',private.request_uid(),p_operation,p_request,encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'),p_response);
 return p_response;
end $$;
revoke all on function private.receipt(uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.receipt(uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb),private.replay(uuid,uuid,text,jsonb) to fichaje_writer,fichaje_acceptor;
create or replace function public.manage_employee(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_expected_version bigint,
 p_code text,p_display_name text,p_membership_id uuid,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_row public.employees; v_result jsonb; v_before jsonb;
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
  v_before:=jsonb_build_object('active',v_row.active,'membership_id',v_row.membership_id,'version',v_row.version);
  if v_row.version<>p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
  update public.employees set code=btrim(p_code),display_name=btrim(p_display_name),membership_id=p_membership_id,active=p_active,version=version+1
  where organization_id=p_organization_id and id=p_employee_id returning * into v_row;
 else
  if p_expected_version<>0 then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
  insert into public.employees(id,organization_id,code,display_name,membership_id,active)
  values(p_employee_id,p_organization_id,btrim(p_code),btrim(p_display_name),p_membership_id,p_active) returning * into v_row;
 end if;
 return private.receipt(p_organization_id,p_request_id,'manage_employee',v_payload,jsonb_build_object('id',v_row.id,'version',v_row.version),'employees',v_row.id,jsonb_build_object('before',v_before,'after',jsonb_build_object('active',v_row.active,'membership_id',v_row.membership_id,'version',v_row.version)));
exception when unique_violation then raise exception using errcode='22023',message='INVALID_INPUT';
end $$;
create or replace function public.manage_membership(p_organization_id uuid,p_request_id uuid,p_membership_id uuid,p_expected_version bigint,
 p_role public.member_role,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_row public.memberships; v_result jsonb; v_before jsonb;
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
 v_before:=jsonb_build_object('role',v_row.role,'active',v_row.active,'version',v_row.version);
 update public.memberships set role=p_role,active=p_active,version=version+1
 where organization_id=p_organization_id and id=p_membership_id returning * into v_row;
 return private.receipt(p_organization_id,p_request_id,'manage_membership',v_payload,jsonb_build_object('id',v_row.id,'version',v_row.version),'memberships',v_row.id,jsonb_build_object('before',v_before,'after',jsonb_build_object('role',v_row.role,'active',v_row.active,'version',v_row.version)));
end $$;
create or replace function public.transfer_ownership(p_organization_id uuid,p_request_id uuid,p_new_owner_membership_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_target public.memberships; v_result jsonb; v_from public.memberships;
 v_payload jsonb:=jsonb_build_array(p_new_owner_membership_id,p_expected_version);
begin
 v_role:=private.authorize(p_organization_id);
 -- A previous owner (now ADMIN) can only replay an already committed transfer, never create another.
 if v_role not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'transfer_ownership',v_payload);
 if v_result is not null then return v_result; end if;
 if v_role<>'OWNER' then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into v_target from public.memberships where organization_id=p_organization_id and id=p_new_owner_membership_id and active and auth_user_id<>private.request_uid();
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if p_expected_version is null or v_target.version<>p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 select * into v_from from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid();
 update public.memberships set role='ADMIN',version=version+1 where organization_id=p_organization_id and auth_user_id=private.request_uid();
 update public.memberships set role='OWNER',version=version+1 where organization_id=p_organization_id and id=v_target.id;
 return private.receipt(p_organization_id,p_request_id,'transfer_ownership',v_payload,jsonb_build_object('id',v_target.id,'version',v_target.version+1),'memberships',v_target.id,jsonb_build_object('changes',jsonb_build_array(
 jsonb_build_object('membership_id',v_from.id,'before',jsonb_build_object('role',v_from.role,'active',v_from.active,'version',v_from.version),
 'after',jsonb_build_object('role','ADMIN','active',true,'version',v_from.version+1)),
 jsonb_build_object('membership_id',v_target.id,'before',jsonb_build_object('role',v_target.role,'active',v_target.active,'version',v_target.version),
 'after',jsonb_build_object('role','OWNER','active',true,'version',v_target.version+1)))));
end $$;
create or replace function public.create_invitation(p_organization_id uuid,p_request_id uuid,p_email text,p_role public.member_role,p_token_hash text)
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
 select id into v_actor from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid();
 insert into private.invitations(organization_id,email,role,token_hash,created_by)
 values(p_organization_id,p_email,p_role,p_token_hash,v_actor) returning id into v_id;
 return private.receipt(p_organization_id,p_request_id,'create_invitation',v_payload,jsonb_build_object('id',v_id),'invitations',v_id,jsonb_build_object('before',null,'after',jsonb_build_object('role',p_role)));
exception when unique_violation then raise exception using errcode='22023',message='INVALID_INPUT';
end $$;
create or replace function public.accept_invitation(p_organization_id uuid,p_request_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_inv private.invitations; v_email text; v_id uuid; v_result jsonb; v_payload jsonb;
begin
 if private.request_uid() is null then raise exception using errcode='42501',message='UNAUTHENTICATED'; end if;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.invitation_scope(p_organization_id,p_token);
 v_payload:=jsonb_build_array(encode(sha256(convert_to(p_token,'UTF8')),'hex'));
 select * into v_inv from private.invitations where organization_id=p_organization_id and token_hash=v_payload->>0;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform 1 from public.organizations where id=p_organization_id and status='ACTIVE' for update;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_email:=private.verified_auth_email(private.request_uid());
 if v_email is null or v_email<>v_inv.email then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 -- Re-read after serialization. A consumed token only permits same-user/same-request replay while active.
 select * into v_inv from private.invitations where id=v_inv.id and organization_id=p_organization_id;
 if v_inv.accepted_by is not null then
  if v_inv.accepted_by<>private.request_uid() or private.current_role(p_organization_id) is null
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
 if exists(select 1 from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid())
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 insert into public.memberships(organization_id,auth_user_id,role) values(p_organization_id,private.request_uid(),v_inv.role) returning id into v_id;
 update private.invitations set accepted_by=private.request_uid() where id=v_inv.id and organization_id=p_organization_id;
 return private.receipt(p_organization_id,p_request_id,'accept_invitation',v_payload,jsonb_build_object('id',v_id,'version',1),'memberships',v_id,jsonb_build_object('before',null,'after',jsonb_build_object('role',v_inv.role,'active',true,'version',1)));
end $$;
alter function public.accept_invitation(uuid,uuid,text) owner to fichaje_acceptor;
create or replace function private.bootstrap_organization(p_org uuid,p_name text,p_owner uuid,p_request uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_array(p_name,p_owner); v_old private.idempotency_records; v_member uuid;
begin
 if p_org is null or p_owner is null or p_request is null or p_name is null or length(btrim(p_name)) not between 1 and 200
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 perform private.bootstrap_scope(p_org,p_owner);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
 select * into v_old from private.idempotency_records where organization_id=p_org and principal_kind='SYSTEM'
 and principal_id=p_owner and operation='bootstrap' and key=p_request;
 if FOUND then
  if v_old.payload_sha256<>encode(sha256(convert_to(v_payload::text,'UTF8')),'hex')
  then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
  perform private.release_bootstrap_scope();
 return p_org;
 end if;
 if private.verified_auth_email(p_owner) is null
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 insert into public.organizations(id,name) values(p_org,btrim(p_name));
 insert into public.memberships(organization_id,auth_user_id,role) values(p_org,p_owner,'OWNER') returning id into v_member;
 insert into public.audit_log(organization_id,actor_kind,action,entity_type,entity_id,request_id,safe_details)
 values(p_org,'SYSTEM','bootstrap','memberships',v_member,p_request,jsonb_build_object('before',null,'after',jsonb_build_object('role','OWNER','active',true,'version',1)));
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response)
 values(p_org,'SYSTEM',p_owner,'bootstrap',p_request,encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'),jsonb_build_object('id',p_org));
 perform private.release_bootstrap_scope();
 return p_org;
end $$;
alter function private.bootstrap_organization(uuid,text,uuid,uuid) owner to fichaje_bootstrap;
revoke all on function private.bootstrap_organization(uuid,text,uuid,uuid) from fichaje_writer;
drop function private.receipt(uuid,uuid,text,jsonb,jsonb,text,uuid);
revoke create on schema public,private from fichaje_guard,fichaje_bootstrap,fichaje_acceptor;
revoke insert on public.organizations,public.memberships from fichaje_writer;
revoke update on public.organizations from fichaje_writer;
grant update(id) on public.organizations to fichaje_writer;
revoke execute on function private.verified_auth_email(uuid) from fichaje_writer;
