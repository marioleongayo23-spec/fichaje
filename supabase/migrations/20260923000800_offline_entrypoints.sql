-- The process assumes this entrypoint role, never the function-owner role.
-- It cannot mint delete guards, fabricate journal entries or issue raw DELETE.
create role fichaje_retention_operator nologin noinherit nobypassrls;
grant fichaje_retention_operator to postgres;
grant usage on schema private to fichaje_retention_operator;
grant execute on function private.purge_labour(uuid,uuid,date,timestamptz,text),
 private.purge_operational(uuid,timestamptz,text),private.record_legal_hold(uuid,uuid,text,text,uuid),
 private.active_legal_hold(uuid,uuid),private.replay_recovery(uuid,uuid,text,jsonb)
 to fichaje_retention_operator;
grant select(id,organization_id,employee_id,release_of) on private.legal_holds to fichaje_retention_operator;
grant select(id,organization_id,object_path,expires_at) on private.export_jobs to fichaje_retention_operator;
grant select on private.journal_source,private.recovery_outbox to fichaje_retention_operator;
create policy offline_process_holds on private.legal_holds for select to fichaje_retention_operator using(true);
create policy offline_process_exports on private.export_jobs for select to fichaje_retention_operator using(true);
create policy offline_process_source on private.journal_source for select to fichaje_retention_operator using(true);
create policy offline_process_outbox on private.recovery_outbox for select to fichaje_retention_operator using(true);
