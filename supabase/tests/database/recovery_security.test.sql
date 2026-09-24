begin;
set local search_path=public,extensions;
select no_plan();
select ok(not exists(select 1 from pg_roles where rolname in ('fichaje_journal','fichaje_retention_operator')
 and (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreatedb or rolcreaterole)),
 'journal and offline process roles are NOLOGIN NOBYPASSRLS with no administrative capabilities');
select ok(not pg_has_role('fichaje_retention_operator','fichaje_retention','MEMBER'),
 'offline process cannot assume function-owner role');
select ok(not has_table_privilege('fichaje_retention_operator','public.time_events','DELETE'),
 'offline process cannot directly delete evidence');
select ok(not has_table_privilege('fichaje_retention_operator','private.retention_delete_guard','INSERT'),
 'offline process cannot mint deletion capability');
select ok(not has_function_privilege('fichaje_retention_operator','private.journal_prepare(uuid,text,jsonb)','EXECUTE'),
 'offline process cannot fabricate recovery tombstones');
select ok(not has_function_privilege('authenticated','private.replay_recovery(uuid,uuid,text,jsonb)','EXECUTE'),
 'authenticated cannot replay deletion tombstones');
select ok(not has_function_privilege('service_role','private.replay_recovery(uuid,uuid,text,jsonb)','EXECUTE'),
 'service role cannot use restore as purge bypass');
select ok(not has_table_privilege('authenticated','private.evidence_deliveries','SELECT'),
 'no third-party directory or raw delivery records exposed');
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in (
 'private.recovery_outbox'::regclass,'private.recovery_applied'::regclass,'private.evidence_deliveries'::regclass)),
 'recovery and delivery metadata FORCE RLS');
grant usage on schema extensions to fichaje_retention;
set local role fichaje_retention;
select is((select count(*)::int from public.time_events),0,'purge owner without protected transaction scope sees no labour');
reset role;
select * from finish();
rollback;
