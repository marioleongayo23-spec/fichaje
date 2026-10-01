begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at) values
 (md5('export-generator-owner')::uuid,'export-generator-owner@example.invalid',clock_timestamp()),
 (md5('export-generator-other')::uuid,'export-generator-other@example.invalid',clock_timestamp());
select private.bootstrap_organization(md5('export-generator-org')::uuid,'Export generator',
 md5('export-generator-owner')::uuid,gen_random_uuid());
insert into public.memberships(id,organization_id,auth_user_id,role)
 values(md5('export-generator-other-membership')::uuid,md5('export-generator-org')::uuid,
 md5('export-generator-other')::uuid,'ADMIN');

select set_config('request.jwt.claims',jsonb_build_object('sub',md5('export-generator-owner')::uuid,'role','authenticated')::text,true);
set local role authenticated;
create temporary table generated_job as
select (public.request_export(md5('export-generator-org')::uuid,gen_random_uuid(),null,
 current_date,current_date,'Europe/Madrid')->>'job_id')::uuid as id;
select is(
 (public.authorize_export_generation(md5('export-generator-org')::uuid,(select id from generated_job))->>'status'),
 'PENDING','requester can authorize generation of own pending job'
);
reset role;

delete from private.mutation_context;
select set_config('request.jwt.claims',jsonb_build_object('sub',md5('export-generator-other')::uuid,'role','authenticated')::text,true);
set local role authenticated;
select throws_ok(
 format('select public.authorize_export_generation(%L::uuid,%L::uuid)',
  md5('export-generator-org')::uuid,(select id from generated_job)),
 '42501','FORBIDDEN','another manager cannot generate a job they did not request'
);
reset role;

select ok((has_function_privilege('authenticated','public.authorize_export_generation(uuid,uuid)','EXECUTE')),
 'authenticated can call export generation authorization');
select ok((not has_function_privilege('anon','public.authorize_export_generation(uuid,uuid)','EXECUTE')),
 'anon cannot call export generation authorization');
select ok((not has_function_privilege('service_role','public.authorize_export_generation(uuid,uuid)','EXECUTE')),
 'service_role has no direct export generation authorization grant');

select * from finish();
rollback;
