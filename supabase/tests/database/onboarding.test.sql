begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at) values
 (md5('onboard-ok')::uuid,'onboard-ok@example.invalid',clock_timestamp()),
 (md5('onboard-unverified')::uuid,'onboard-unverified@example.invalid',null),
 (md5('onboard-other')::uuid,'onboard-other@example.invalid',clock_timestamp());

-- Anonymous callers never reach onboarding.
set local role anon;
select throws_ok(
  $test$select public.create_organization(gen_random_uuid(),'Anon')$test$,
  '42501',NULL,'onboarding anonymous denied'
);
reset role;

-- Email confirmation is enforced server-side, not by the UI.
delete from private.mutation_context;
select set_config('request.jwt.claims',jsonb_build_object('sub',md5('onboard-unverified')::uuid,'role','authenticated')::text,true);
set local role authenticated;
select throws_ok(
  $test$select public.create_organization(md5('unverified-request')::uuid,'Unverified')$test$,
  '22023','EMAIL_NOT_VERIFIED','onboarding requires verified email'
);
reset role;

-- A fresh verified identity creates exactly one organization and is OWNER.
delete from private.mutation_context;
select set_config('request.jwt.claims',jsonb_build_object('sub',md5('onboard-ok')::uuid,'role','authenticated')::text,true);
set local role authenticated;
create temporary table onboard_receipt as
select public.create_organization(md5('onboard-request')::uuid,'  Fichaje Demo  ') as value;
select ok(((select value->>'id' from onboard_receipt) is not null),'onboarding returns server organization id');
select is((select count(*)::int from public.organizations where name='Fichaje Demo'),1,'onboarding trims organization name');
select is((select count(*)::int from public.memberships where auth_user_id=md5('onboard-ok')::uuid and role='OWNER' and active),1,'onboarding grants one OWNER membership');
select is((select count(*)::int from public.audit_log where action='bootstrap' and actor_kind='SYSTEM'),1,'onboarding bootstrap audited');

-- Same request is a replay, not a second company.
select is(
  public.create_organization(md5('onboard-request')::uuid,'Fichaje Demo')->>'id',
  (select value->>'id' from onboard_receipt),
  'onboarding retry replays same organization'
);
select is((select count(*)::int from public.organizations where name='Fichaje Demo'),1,'onboarding retry no duplicate organization');
select throws_ok(
  $test$select public.create_organization(md5('onboard-request')::uuid,'Different name')$test$,
  '22023','IDEMPOTENCY_CONFLICT','onboarding request cannot change payload'
);
select throws_ok(
  $test$select public.create_organization(md5('second-company')::uuid,'Second company')$test$,
  '42501','FORBIDDEN','self-service only creates first organization'
);
reset role;

-- A different verified identity gets a different isolated tenant.
delete from private.mutation_context;
select set_config('request.jwt.claims',jsonb_build_object('sub',md5('onboard-other')::uuid,'role','authenticated')::text,true);
set local role authenticated;
select public.create_organization(md5('other-request')::uuid,'Other Demo');
select is((select count(*)::int from public.organizations),1,'RLS shows only caller organization after onboarding');
select is((select count(*)::int from public.memberships),1,'RLS shows only caller membership after onboarding');
reset role;

select ok((not has_function_privilege('anon','public.create_organization(uuid,text)','EXECUTE')),'anon cannot execute onboarding RPC');
select ok((has_function_privilege('authenticated','public.create_organization(uuid,text)','EXECUTE')),'authenticated can execute onboarding RPC');
select ok((not has_table_privilege('authenticated','private.onboarding_requests','SELECT')),'client cannot read onboarding idempotency');
select ok((not has_table_privilege('authenticated','private.onboarding_requests','INSERT')),'client cannot write onboarding idempotency');

select * from finish();
rollback;
