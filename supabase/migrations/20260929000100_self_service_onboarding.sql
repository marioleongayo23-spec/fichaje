-- H7 final product onboarding: verified Auth identity -> first organization OWNER.
-- The browser never chooses organization_id or role. The request is idempotent
-- across lost ACKs and no client receives access to the private bootstrap route.

create table private.onboarding_requests (
  principal_id uuid not null,
  request_id uuid not null,
  name_sha256 text not null check (name_sha256 ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (principal_id, request_id),
  unique (organization_id)
);
alter table private.onboarding_requests enable row level security;
alter table private.onboarding_requests force row level security;
revoke all on private.onboarding_requests from public,anon,authenticated,service_role,fichaje_writer,fichaje_guard,fichaje_acceptor;
grant select,insert on private.onboarding_requests to fichaje_bootstrap;
create policy onboarding_bootstrap_access on private.onboarding_requests
  to fichaje_bootstrap
  using (principal_id = private.request_uid())
  with check (principal_id = private.request_uid());

create function private.has_any_membership() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.memberships
    where auth_user_id = private.request_uid()
  )
$$;
grant create on schema private to fichaje_guard;
alter function private.has_any_membership() owner to fichaje_guard;
revoke create on schema private from fichaje_guard;
revoke all on function private.has_any_membership() from public,anon,authenticated,service_role,fichaje_writer,fichaje_acceptor;
grant execute on function private.has_any_membership() to fichaje_bootstrap;

create function public.create_organization(p_request_id uuid,p_name text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid := private.request_uid();
  v_org uuid;
  v_hash text;
  v_existing private.onboarding_requests;
begin
  if v_uid is null then
    raise exception using errcode='42501',message='UNAUTHENTICATED';
  end if;
  if p_request_id is null or p_name is null or length(btrim(p_name)) not between 1 and 200 then
    raise exception using errcode='22023',message='INVALID_INPUT';
  end if;
  if private.verified_auth_email(v_uid) is null then
    raise exception using errcode='22023',message='EMAIL_NOT_VERIFIED';
  end if;

  v_hash := encode(sha256(convert_to(btrim(p_name),'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_request_id::text,0));

  select * into v_existing
  from private.onboarding_requests
  where principal_id=v_uid and request_id=p_request_id;

  if FOUND then
    if v_existing.name_sha256<>v_hash then
      raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('id',v_existing.organization_id);
  end if;

  if private.has_any_membership() then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;

  v_org := gen_random_uuid();
  insert into private.onboarding_requests(principal_id,request_id,name_sha256,organization_id)
  values(v_uid,p_request_id,v_hash,v_org);

  perform private.bootstrap_organization(v_org,btrim(p_name),v_uid,p_request_id);
  return jsonb_build_object('id',v_org);
end $$;
grant create on schema public to fichaje_bootstrap;
alter function public.create_organization(uuid,text) owner to fichaje_bootstrap;
revoke create on schema public from fichaje_bootstrap;
revoke all on function public.create_organization(uuid,text) from public,anon,service_role;
grant execute on function public.create_organization(uuid,text) to authenticated;
