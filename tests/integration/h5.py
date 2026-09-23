"""H1-H5 against disposable Auth/REST/Storage/PostgreSQL and external journal.
No production endpoint, simulated RLS, or JavaScript-only restore is accepted.
"""
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile

import psycopg
from psycopg.types.json import Jsonb

runpy.run_module('h4', run_name='__main__')
import h1 as h
from journal_init import APP, ARCHIVE
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import export_worker
from export_package import package
from recovery_journal import reconcile, replay, committed_entries

check, uid, rpc, sql = h.check, h.uid, h.rpc, h.sql
initial = h.checks
org, foreign = uid(), uid()
owner, admin, employee, other = [h.account('h5-'+s) for s in ('owner','admin','employee','foreign')]
for o, u in ((org, owner), (foreign, other)):
    sql(f"select private.bootstrap_organization('{o}','Synthetic H5','{u['id']}','{uid()}');")
    u['membership'] = sql(f"select id from public.memberships where organization_id='{o}' and auth_user_id='{u['id']}';")
for u, role in ((admin, 'ADMIN'), (employee, 'EMPLOYEE')):
    token, _, _ = h.invite(org, owner, u, role)
    code, result = h.accept(org, u, token)
    assert code == 200
    u['membership'] = result['id']
for o, u, manager in ((org, employee, owner), (foreign, other, other)):
    args = h.employee_args(o, u['membership'])
    code, _ = rpc('manage_employee', manager['token'], args)
    assert code == 200
    u['employee'] = args['p_employee_id']
    u['employee_args'] = args
    code, policy = rpc('create_work_policy', manager['token'], dict(p_organization_id=o,
        p_request_id=uid(), p_timezone='Europe/Madrid', p_break_counts_as_work=False))
    assert code == 200
    u['policy'] = policy['id']
    code, _ = rpc('assign_work_policy', manager['token'], dict(p_organization_id=o,
        p_request_id=uid(), p_employee_id=u['employee'], p_policy_id=u['policy']))
    assert code == 200


def request_export(user=employee, tenant=org, subject=None, start=None, end=None):
    day = sql("select (clock_timestamp() at time zone 'Europe/Madrid')::date;")
    return rpc('request_export', user['token'], dict(p_organization_id=tenant,p_request_id=uid(),
        p_employee_id=subject,p_start=start or day,p_end=end or day,p_timezone='Europe/Madrid'))


def dbone(query, params=()):
    with psycopg.connect(APP) as c:
        return c.execute(query, params).fetchone()[0]


def offline(query, params=()):
    with psycopg.connect(APP) as c:
        c.execute('set local role fichaje_retention')
        return c.execute(query, params).fetchone()[0]


def expect_db_error(query, params, message):
    try:
        offline(query, params)
    except psycopg.Error as error:
        check(message in str(error), message)
    else:
        raise AssertionError('expected database rejection: '+message)


# Real correction committed while the worker transaction is rendering an older
# materialized job. The barrier controls scheduling, never query results.
events = []
for version, action in enumerate(('CLOCK_IN', 'CLOCK_OUT')):
    code, result = rpc('record_time_event', employee['token'], dict(p_organization_id=org,
        p_request_id=uid(),p_employee_id=employee['employee'],p_action=action,p_expected_version=version))
    assert code == 200
    events.append(result)
code, proposal = rpc('submit_correction', employee['token'], dict(p_organization_id=org,
    p_request_id=uid(),p_employee_id=employee['employee'],p_base_version=2,p_reason='Synthetic concurrent correction',
    p_operations=[dict(operation='REPLACE',session_id=events[0]['session_id'],target_event_id=events[1]['event_id'],
      event_type='CLOCK_OUT',effective_at=events[0]['server_at'],ordinal=2,timezone='Europe/Madrid')]))
assert code == 200
code, before_job = request_export()
assert code == 200
entered, release = threading.Event(), threading.Event()
renderer = export_worker.package


def paused_renderer(snapshot):
    if snapshot['employee_id'] == employee['employee']:
        entered.set()
        if not release.wait(30):
            raise AssertionError('concurrency barrier timeout')
    return renderer(snapshot)


export_worker.package = paused_renderer
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(export_worker.run, APP, h.URL, h.SERVICE)
        assert entered.wait(30)
        code, decision = rpc('decide_correction', admin['token'], dict(p_organization_id=org,
            p_request_id=uid(),p_correction_request_id=proposal['correction_request_id'],
            p_decision='APPROVE',p_reason='Synthetic independent approval'))
        check(code == 200, 'EXP-02 correction commits while export worker transaction is open')
        release.set()
        assert future.result(timeout=30) == 1
finally:
    release.set()
    export_worker.package = renderer
before = dbone('select snapshot from private.export_jobs where id=%s', (before_job['job_id'],))
code, after_job = request_export()
assert code == 200
after = dbone('select snapshot from private.export_jobs where id=%s', (after_job['job_id'],))
before_session = before['employees'][0]['sessions'][0]
after_session = after['employees'][0]['sessions'][0]
check(not before_session['adjustments'] and all(e['source']=='WEB' for e in before_session['effective']),
      'EXP-02 old materialized snapshot wholly precedes concurrent correction')
check(len(after_session['adjustments'])==1 and after_session['effective'][-1]['source']=='CORRECTION',
      'EXP-02 subsequent snapshot wholly includes committed adjustment and effective result')
path = f"{org}/{before_job['job_id']}.zip"
archive = export_worker.storage('GET',h.URL+'/storage/v1/object/fichaje-evidence/'+path,h.SERVICE)
check(archive == package(before)[0], 'EXP-02 all delivered files come from exactly the same pre-correction snapshot')
check(hashlib.sha256(archive).hexdigest()==dbone('select checksum from private.export_jobs where id=%s',(before_job['job_id'],)),
      'EXP-03 stored package SHA-256 matches downloaded bytes')
with zipfile.ZipFile(io.BytesIO(archive)) as z:
    check(json.loads(z.read('evidence.json'))==before and z.read('summary.pdf').startswith(b'%PDF-'),
          'EXP-03 actual private package contains canonical evidence and generated PDF')

code, err = request_export(subject=other['employee'])
code2, err2 = request_export(subject=uid())
check(code==code2==403 and err==err2, 'EXP-01 foreign employee UUID indistinguishable from nonexistent UUID')
check(request_export(tenant=foreign)[0]==403, 'EXP-01 employee cannot export foreign tenant')
for manager in (owner,admin):
    check(request_export(manager,foreign)[0]==403, 'EXP-01 manager cannot export foreign tenant')
    check(request_export(manager,subject=employee['employee'])[0]==200, 'EXP-01 authorized manager exports own tenant')
check({e['id'] for e in before['employees']}=={employee['employee']}, 'EXP-01 employee export contains exclusively own evidence')

# Force a real Storage authorization failure. No mock storage implementation.
try:
    export_worker.run(APP,h.URL,h.ANON)
except urllib.error.HTTPError:
    pass
else:
    raise AssertionError('Storage must reject anonymous upload')
check(dbone('select status from private.export_jobs where id=%s',(after_job['job_id'],))=='PENDING',
      'ATOMIC Storage failure never commits READY')
export_worker.run(APP,h.URL,h.SERVICE)
check(dbone('select status from private.export_jobs where id=%s',(after_job['job_id'],))=='READY',
      'ATOMIC retry produces verified complete package')

code, manager_job = request_export(owner,subject=employee['employee'])
assert code==200
export_worker.run(APP,h.URL,h.SERVICE)
delivery_args=dict(p_org=org,p_job=manager_job['job_id'],p_recipient_kind='INSPECTION',
                   p_receipt_ref='SYNTHETIC-RECEIPT-1',p_purpose='Synthetic controlled inspection delivery')
code, receipt = rpc('record_evidence_delivery',owner['token'],delivery_args)
check(code==200, 'EXP controlled delivery records manager, receipt and explicit scope')
check(rpc('record_evidence_delivery',employee['token'],delivery_args)[0]==403,
      'EXP employee cannot create third-party delivery')
check(rpc('record_evidence_delivery',other['token'],delivery_args)[0]==403,
      'EXP third-party delivery cannot cross tenant')
check(dbone('select count(*) from public.audit_log where entity_id=%s and action=%s',(receipt,'record_delivery'))==1,
      'EXP controlled delivery audit is transactional')

# Real signer, real Auth check, real Storage signed URL and expiry rejection.
with tempfile.TemporaryDirectory(prefix='h5-signer-') as temp:
    with open(Path(temp)/'server.log','wb') as log:
        proc=subprocess.Popen(['deno','run','--allow-env','--allow-net','supabase/functions/export-link/index.ts'],
            env=dict(os.environ,SUPABASE_URL=h.URL,SUPABASE_ANON_KEY=h.ANON,SUPABASE_SERVICE_ROLE_KEY=h.SERVICE),stdout=log,stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen('http://127.0.0.1:8000',timeout=1)
                except urllib.error.HTTPError:
                    break
                except OSError:
                    time.sleep(.1)
            def sign(user,job):
                req=urllib.request.Request('http://127.0.0.1:8000',data=json.dumps(dict(organization_id=org,job_id=job)).encode(),
                    headers={'Content-Type':'application/json','Authorization':'Bearer '+user['token']})
                try:
                    response=urllib.request.urlopen(req,timeout=10)
                except urllib.error.HTTPError as e:
                    response=e
                with response:
                    assert response.headers.get('Cache-Control')=='no-store'
                    return response.status,json.loads(response.read())
            status, link = sign(employee,before_job['job_id'])
            check(status==200 and 0<link['expires_in']<=300,'EXP-05 signer revalidates real Auth and caps link to five minutes')
            with urllib.request.urlopen(link['url'],timeout=10) as response:
                check(response.read()==archive,'EXP-05 signed URL downloads complete private package')
            with psycopg.connect(APP) as c:
                c.execute("update private.export_jobs set expires_at=clock_timestamp()+interval '3 seconds' where id=%s",(before_job['job_id'],))
            status, short = sign(employee,before_job['job_id'])
            assert status==200 and short['expires_in']<=3
            time.sleep(4)
            try:
                urllib.request.urlopen(short['url'],timeout=10)
            except urllib.error.HTTPError as e:
                check(e.code>=400,'EXP-05 expired URL is rejected by real Storage')
            else:
                raise AssertionError('expired signed URL accepted')
            code,_=rpc('manage_employee',owner['token'],{**employee['employee_args'],
                'p_request_id':uid(),'p_expected_version':1,'p_active':False})
            assert code==200
            check(sign(employee,after_job['job_id'])[0]==403,'EXP-05 deactivated employee cannot get a fresh URL')
        finally:
            proc.terminate()
            proc.wait(timeout=10)
code, listing=h.api('/storage/v1/object/list/fichaje-evidence',data={'prefix':org})
check(code>=400 or listing==[],'EXP-05 anonymous object listing cannot reveal evidence')
check(h.api('/storage/v1/object/public/fichaje-evidence/'+path)[0]>=400,'EXP-05 public object URL impossible')

# Synthetic historical fixture with real constraints and an actual closed timeline.
historical=uid()
args=h.employee_args(org)
historical=args['p_employee_id']
code,_=rpc('manage_employee',owner['token'],args)
assert code==200
session=uid()
with psycopg.connect(APP) as c:
    c.execute('''insert into public.work_sessions(id,organization_id,employee_id,policy_id,timezone,created_at)
      values(%s,%s,%s,%s,'Europe/Madrid','2020-01-10 08:00+00')''',(session,org,historical,employee['policy']))
    for seq, action, at in ((1,'CLOCK_IN','2020-01-10 08:00+00'),(2,'CLOCK_OUT','2020-01-10 16:00+00')):
        c.execute('''insert into public.time_events(organization_id,employee_id,session_id,sequence,event_type,
          server_at,actor_membership_id,source,request_id) values(%s,%s,%s,%s,%s,%s,%s,'WEB',%s)''',
          (org,historical,session,seq,action,at,owner['membership'],uid()))
purge='select private.purge_labour(%s,%s,%s,%s,%s)'
purge_args=(org,historical,'2020-01-01','2024-01-31 23:00+00','SYNTHETIC-PURGE')

# Inject manifest and audit failures inside real PostgreSQL transactions.
for table in ('private.retention_runs','public.audit_log'):
    with psycopg.connect(APP) as c:
        c.execute("create function private.h5_fail() returns trigger language plpgsql as $$ begin raise exception 'FORCED_FAILURE'; end $$")
        c.execute(f'create trigger h5_fail before insert on {table} for each statement execute function private.h5_fail()')
    try:
        expect_db_error(purge,purge_args,'FORCED_FAILURE')
        check(dbone('select count(*) from public.time_events where session_id=%s',(session,))==2,
              'ATOMIC '+table+' failure rolls back entire evidence deletion')
        check(dbone('select count(*) from private.retention_runs where authorization_ref=%s',('SYNTHETIC-PURGE',))==0,
              'ATOMIC failed purge has no committed manifest')
    finally:
        with psycopg.connect(APP) as c:
            c.execute(f'drop trigger h5_fail on {table}')
            c.execute('drop function private.h5_fail()')

# Actual pg_dump/pg_restore of only the synthetic application schemas. The
# separate journal database is neither dumped nor restored with these schemas.
reconcile(APP,ARCHIVE)
dump=subprocess.check_output(['docker','exec',h.CONTAINER,'pg_dump','-U','postgres','-d','postgres',
    '-Fc','-n','public','-n','private'])
foreign_before=dbone('select to_jsonb(e) from public.employees e where id=%s',(other['employee'],))
code,_=rpc('manage_employee',owner['token'],{**args,'p_request_id':uid(),'p_expected_version':1,'p_active':False})
assert code==200
hold=offline('select private.record_legal_hold(%s,%s,%s,%s)',(org,None,'Synthetic hold','SYN-HOLD'))
expect_db_error(purge,purge_args,'LEGAL_HOLD')
offline('select private.record_legal_hold(%s,%s,%s,%s,%s)',(org,None,'Synthetic release','SYN-RELEASE',hold))
offline('select private.record_legal_hold(%s,%s,%s,%s)',(foreign,other['employee'],'Foreign hold','SYN-FOREIGN-HOLD'))
offline(purge,purge_args)
active_hold=offline('select private.record_legal_hold(%s,%s,%s,%s)',(org,historical,'Later active hold','SYN-LATER-HOLD'))
check(dbone('select count(*) from public.work_sessions where id=%s',(session,))==0,'RET authorized purge removed exact historical session')
reconcile(APP,ARCHIVE)
subprocess.run(['docker','exec','-i',h.CONTAINER,'pg_restore','-U','postgres','-d','postgres',
    '--clean','--if-exists','--exit-on-error'],input=dump,check=True,stdout=subprocess.DEVNULL)
check(dbone('select count(*) from public.work_sessions where id=%s',(session,))==1,
      'RET-04 real pg_restore actually restores the older synthetic evidence')
check(dbone('select active from public.employees where id=%s',(historical,)),
      'RET-04 old backup really predates the deactivation')
check(replay(APP,ARCHIVE)>=5,'RET-04 external committed journal replay executes on restored PostgreSQL')
check(not dbone('select active from public.employees where id=%s',(historical,)), 'RET-04 deactivation remains applied after replay')
check(dbone('select count(*) from public.work_sessions where id=%s',(session,))==0,'RET-04 purged evidence does not reappear after replay')
check(offline('select private.active_legal_hold(%s,%s)',(org,historical)), 'RET-04 later employee hold remains active')
check(not offline('select private.active_legal_hold(%s,%s)',(org,None)), 'RET-04 released organization hold stays released')
check(dbone('select to_jsonb(e) from public.employees e where id=%s',(other['employee'],))==foreign_before,
      'RET-04 other tenant identity unaffected by replay')
check(replay(APP,ARCHIVE)==0,'RET-04 replay idempotent')
check(dbone("select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('public.time_events'::regclass,'public.employees'::regclass,'private.legal_holds'::regclass)"),
      'RET-04 FORCE RLS survives real restore')
with psycopg.connect(APP) as c:
    c.execute('set local role authenticated')
    c.execute("select set_config('request.jwt.claims',%s,true)",(json.dumps({'sub':other['id'],'role':'authenticated'}),))
    check(c.execute('select count(*) from public.employees where organization_id=%s',(org,)).fetchone()[0]==0,
          'RET-04 real RLS after restore still denies cross-tenant reads')
print(f'PASS H5: {h.checks-initial} real integration checks; all H1-H4 executed.')
