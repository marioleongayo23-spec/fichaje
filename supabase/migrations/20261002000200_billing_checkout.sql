-- STRIPE-READY-02: checkout claim/finalization state.
-- A DB claim is taken before external Stripe I/O. Replays use the same generation
-- and Stripe idempotency key; a concurrent browser attempt receives the existing
-- claim instead of creating a second subscription.

alter table private.billing_accounts
  add column checkout_request_id uuid,
  add column checkout_generation bigint not null default 0 check(checkout_generation>=0),
  add column checkout_session_id text,
  add column checkout_started_at timestamptz,
  add column checkout_expires_at timestamptz,
  add constraint billing_checkout_session_format check(
    checkout_session_id is null or
    (length(checkout_session_id) between 8 and 255 and checkout_session_id ~ '^cs_(test_)?[A-Za-z0-9]+$')
  ),
  add constraint billing_checkout_shape check(
    (checkout_request_id is null and checkout_session_id is null and checkout_started_at is null and checkout_expires_at is null)
    or
    (checkout_request_id is not null and checkout_started_at is not null)
  );

create function public.billing_begin_checkout(p_organization_id uuid,p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare v private.billing_accounts; v_org_status text;
begin
  if p_organization_id is null or p_request_id is null then
    raise exception using errcode='22023',message='INVALID_INPUT';
  end if;
  select status into v_org_status from public.organizations where id=p_organization_id;
  if not found or v_org_status<>'ACTIVE' then
    raise exception using errcode='42501',message='ORGANIZATION_INACTIVE';
  end if;

  insert into private.billing_accounts(organization_id)
  values(p_organization_id)
  on conflict(organization_id) do nothing;

  select * into v from private.billing_accounts where organization_id=p_organization_id for update;

  if v.stripe_subscription_id is not null
     and v.status not in ('CANCELED','INCOMPLETE_EXPIRED') then
    raise exception using errcode='22023',message='SUBSCRIPTION_EXISTS';
  end if;

  if v.status='CHECKOUT_PENDING' and v.checkout_request_id is not null then
    return jsonb_build_object(
      'request_id',v.checkout_request_id,
      'generation',v.checkout_generation,
      'session_id',v.checkout_session_id,
      'expires_at',v.checkout_expires_at,
      'resumed',true
    );
  end if;

  update private.billing_accounts
     set status='CHECKOUT_PENDING',
         stripe_subscription_id=case when v.status in ('CANCELED','INCOMPLETE_EXPIRED') then null else stripe_subscription_id end,
         stripe_employee_item_id=case when v.status in ('CANCELED','INCOMPLETE_EXPIRED') then null else stripe_employee_item_id end,
         checkout_request_id=p_request_id,
         checkout_generation=checkout_generation+1,
         checkout_session_id=null,
         checkout_started_at=clock_timestamp(),
         checkout_expires_at=null,
         updated_at=clock_timestamp()
   where organization_id=p_organization_id
   returning * into v;

  return jsonb_build_object(
    'request_id',v.checkout_request_id,
    'generation',v.checkout_generation,
    'session_id',null,
    'expires_at',null,
    'resumed',false
  );
end $$;
grant create on schema public to fichaje_billing;
alter function public.billing_begin_checkout(uuid,uuid) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.billing_begin_checkout(uuid,uuid) from public,anon,authenticated;
grant execute on function public.billing_begin_checkout(uuid,uuid) to service_role;

create function public.billing_finish_checkout(
  p_organization_id uuid,p_request_id uuid,p_generation bigint,
  p_session_id text,p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v private.billing_accounts;
begin
  if p_organization_id is null or p_request_id is null or p_generation is null or p_generation<1
    or p_session_id is null or p_session_id !~ '^cs_(test_)?[A-Za-z0-9]+$'
    or p_expires_at is null
  then raise exception using errcode='22023',message='INVALID_INPUT'; end if;

  select * into v from private.billing_accounts
   where organization_id=p_organization_id for update;
  if not found or v.status<>'CHECKOUT_PENDING'
     or v.checkout_request_id is distinct from p_request_id
     or v.checkout_generation<>p_generation then
    raise exception using errcode='22023',message='CHECKOUT_CLAIM_MISMATCH';
  end if;
  if v.checkout_session_id is not null and v.checkout_session_id<>p_session_id then
    raise exception using errcode='22023',message='CHECKOUT_SESSION_CONFLICT';
  end if;

  update private.billing_accounts
     set checkout_session_id=p_session_id,
         checkout_expires_at=p_expires_at,
         updated_at=clock_timestamp()
   where organization_id=p_organization_id;

  return jsonb_build_object('stored',true);
end $$;
grant create on schema public to fichaje_billing;
alter function public.billing_finish_checkout(uuid,uuid,bigint,text,timestamptz) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.billing_finish_checkout(uuid,uuid,bigint,text,timestamptz) from public,anon,authenticated;
grant execute on function public.billing_finish_checkout(uuid,uuid,bigint,text,timestamptz) to service_role;

create function public.billing_reset_expired_checkout(
  p_organization_id uuid,p_request_id uuid,p_generation bigint,p_session_id text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v private.billing_accounts;
begin
  select * into v from private.billing_accounts
   where organization_id=p_organization_id for update;
  if not found or v.status<>'CHECKOUT_PENDING'
     or v.checkout_request_id is distinct from p_request_id
     or v.checkout_generation<>p_generation
     or v.checkout_session_id is distinct from p_session_id
     or v.checkout_expires_at is null
     or v.checkout_expires_at>clock_timestamp() then
    return jsonb_build_object('reset',false);
  end if;
  update private.billing_accounts
     set status='NOT_CONFIGURED',
         checkout_request_id=null,checkout_session_id=null,
         checkout_started_at=null,checkout_expires_at=null,
         updated_at=clock_timestamp()
   where organization_id=p_organization_id;
  return jsonb_build_object('reset',true);
end $$;
grant create on schema public to fichaje_billing;
alter function public.billing_reset_expired_checkout(uuid,uuid,bigint,text) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.billing_reset_expired_checkout(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.billing_reset_expired_checkout(uuid,uuid,bigint,text) to service_role;

create or replace function public.billing_record_subscription_snapshot(
  p_event_id text,p_event_type text,p_event_created bigint,p_organization_id uuid,
  p_stripe_customer_id text,p_stripe_subscription_id text,p_stripe_employee_item_id text,
  p_status text,p_seat_quantity integer,p_cancel_at_period_end boolean,p_current_period_end timestamptz
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_account private.billing_accounts;
  v_inserted text;
begin
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$'
    or p_event_type is null or length(p_event_type) not between 1 and 120
    or p_event_created is null or p_event_created<0
    or p_organization_id is null
    or p_stripe_customer_id is null or p_stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_stripe_subscription_id is null or p_stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_stripe_employee_item_id is null or p_stripe_employee_item_id !~ '^si_[A-Za-z0-9]+$'
    or p_status not in ('INCOMPLETE','INCOMPLETE_EXPIRED','TRIALING','ACTIVE','PAST_DUE','PAUSED','UNPAID','CANCELED')
    or p_seat_quantity is null or p_seat_quantity<0
    or p_cancel_at_period_end is null
  then raise exception using errcode='22023',message='INVALID_INPUT'; end if;

  select * into v_account
    from private.billing_accounts
    where organization_id=p_organization_id
    for update;
  if not found or v_account.stripe_customer_id is distinct from p_stripe_customer_id then
    raise exception using errcode='42501',message='STRIPE_MAPPING_MISMATCH';
  end if;
  if v_account.stripe_subscription_id is not null
    and v_account.stripe_subscription_id<>p_stripe_subscription_id
    and v_account.status not in ('CANCELED','INCOMPLETE_EXPIRED','CHECKOUT_PENDING') then
    raise exception using errcode='42501',message='STRIPE_MAPPING_MISMATCH';
  end if;

  insert into private.billing_events(stripe_event_id,event_type,event_created,organization_id)
  values(p_event_id,p_event_type,p_event_created,p_organization_id)
  on conflict(stripe_event_id) do nothing
  returning stripe_event_id into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('applied',false,'duplicate',true);
  end if;

  update private.billing_accounts
     set stripe_subscription_id=p_stripe_subscription_id,
         stripe_employee_item_id=p_stripe_employee_item_id,
         status=p_status,
         seat_quantity=p_seat_quantity,
         cancel_at_period_end=p_cancel_at_period_end,
         current_period_end=p_current_period_end,
         last_event_created=greatest(last_event_created,p_event_created),
         last_event_id=p_event_id,
         checkout_request_id=null,checkout_session_id=null,
         checkout_started_at=null,checkout_expires_at=null,
         updated_at=clock_timestamp()
   where organization_id=p_organization_id;

  return jsonb_build_object('applied',true,'duplicate',false);
end $$;
alter function public.billing_record_subscription_snapshot(text,text,bigint,uuid,text,text,text,text,integer,boolean,timestamptz)
  owner to fichaje_billing;
revoke all on function public.billing_record_subscription_snapshot(text,text,bigint,uuid,text,text,text,text,integer,boolean,timestamptz)
  from public,anon,authenticated;
grant execute on function public.billing_record_subscription_snapshot(text,text,bigint,uuid,text,text,text,text,integer,boolean,timestamptz)
  to service_role;
