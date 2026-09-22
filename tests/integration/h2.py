"""H2 real GoTrue + PostgREST + PostgreSQL; imports and runs ALL H1 checks first."""
import concurrent.futures
import json
import subprocess
import threading
import urllib.request
import h1 as h

api, sql, rpc, uid, check = h.api, h.sql, h.rpc, h.uid, h.check
start_checks = h.checks
org, foreign = uid(), uid()
owner, user, other = [h.account('h2-' + x) for x in ('owner', 'worker', 'foreign')]
for o, u in [(org, owner), (foreign, other)]:
    sql(f"select private.bootstrap_organization('{o}','Synthetic H2','{u['id']}','{uid()}');")
    u['membership'] = sql(f"select id from public.memberships where organization_id='{o}' and auth_user_id='{u['id']}';")
token, _, _ = h.invite(org, owner, user, 'EMPLOYEE')
code, receipt = h.accept(org, user, token)
assert code == 200
user['membership'] = receipt['id']
for o, u, manager in [(org,user,owner),(org,owner,owner),(foreign,other,other)]:
    args = h.employee_args(o,u['membership'])
    code, _ = rpc('manage_employee',manager['token'],args)
    assert code == 200
    u['employee'] = args['p_employee_id']
    check(sql(f"select state||':'||version from private.employee_state where employee_id='{u['employee']}';") == 'OUT:0', 'RACE-02 employee and initial state created atomically')


def call(action, version, request=None, employee=None, organization=None, token=None):
    return rpc('record_time_event',token or user['token'],dict(p_organization_id=organization or org,
        p_request_id=request or uid(),p_employee_id=employee or user['employee'],p_action=action,p_expected_version=version))


def policy(zone, paid=False, organization=org, manager=owner):
    args = dict(p_organization_id=organization,p_request_id=uid(),p_timezone=zone,p_break_counts_as_work=paid)
    code, p = rpc('create_work_policy',manager['token'],args)
    assert code == 200, ('create policy', p)
    check(rpc('create_work_policy',manager['token'],args) == (code,p), 'policy creation idempotent')
    return p['id']


def assign(p, employee=None):
    args = dict(p_organization_id=org,p_request_id=uid(),p_employee_id=employee or user['employee'],p_policy_id=p)
    code, r = rpc('assign_work_policy',owner['token'],args)
    assert code == 200, ('assign policy',r)
    check(rpc('assign_work_policy',owner['token'],args) == (code,r), 'policy assignment idempotent')


def snapshot():
    return sql(f"select jsonb_build_array((select to_jsonb(s) from private.employee_state s where employee_id='{user['employee']}'),(select count(*) from public.time_events where employee_id='{user['employee']}'),(select count(*) from public.work_sessions where employee_id='{user['employee']}'),(select count(*) from private.idempotency_records where operation='record_time_event' and organization_id='{org}'),(select count(*) from public.audit_log where action='record_time_event' and organization_id='{org}'));")

code, err = call('CLOCK_IN',0)
check(code == 400 and err['message']=='POLICY_REQUIRED', f'no invented default work policy: HTTP {code}, {err}')
for zone in ['Europe/Not_A_Zone','CET','+02:00',None]:
    code, _ = rpc('create_work_policy',owner['token'],dict(p_organization_id=org,p_request_id=uid(),p_timezone=zone,p_break_counts_as_work=False))
    check(code >= 400, 'invalid/non-IANA timezone rejected')
madrid = policy('Europe/Madrid')
assign(madrid)
assign(madrid,owner['employee'])
canary = policy('Atlantic/Canary',True)

# RACE-02 actual concurrent employee creation, including its initial projection.
new_employee=h.employee_args(org)
with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
    barrier=threading.Barrier(20)
    def create_same(_):
        barrier.wait(timeout=10)
        return rpc('manage_employee',owner['token'],new_employee)
    creates=list(pool.map(create_same,range(20)))
check(all(c==200 for c,r in creates) and len({r['id'] for c,r in creates})==1,
      'RACE-02 20 concurrent creates return one employee')
check(sql(f"select count(*) from private.employee_state where employee_id='{new_employee['p_employee_id']}';")=='1',
      'RACE-02 exactly one initial state after concurrent creation')
# TIME-01/04 effective time sampled AFTER waiting for the H1 tenant lock.
lock_sql=fr'''begin;
select 1 from public.organizations where id='{org}' for update;
\echo CLOCK_LOCKED
select pg_sleep(2);
select 'RELEASE_AT='||clock_timestamp()::text;
commit;
'''
proc=subprocess.Popen(['docker','exec','-i',h.CONTAINER,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
proc.stdin.write(lock_sql); proc.stdin.close()
while True:
    line=proc.stdout.readline()
    if line.strip()=='CLOCK_LOCKED': break
    assert line,'clock test failed to lock'
code, after_wait=call('CLOCK_IN',0)
assert code==200,(code,after_wait)
remaining=proc.stdout.read(); assert proc.wait(timeout=15)==0
release=next(line.split('=',1)[1] for line in remaining.splitlines() if line.startswith('RELEASE_AT='))
from datetime import datetime
check(datetime.fromisoformat(after_wait['server_at'])>=datetime.fromisoformat(release),
      'TIME-01 effective timestamp sampled after lock, not at request/transaction start')
code, closed=call('CLOCK_OUT',1); assert code==200

# STATE-01: each of the twelve entries tested through the real RPC with fresh
# expected_version. Legal prerequisites use the same production function.
version = 2
matrix = {'OUT':{'CLOCK_IN':'WORKING'}, 'WORKING':{'BREAK_START':'PAUSED','CLOCK_OUT':'OUT'},
          'PAUSED':{'BREAK_END':'WORKING','CLOCK_OUT':'OUT'}}
valid = invalid = 0
for initial in matrix:
    for action in ['CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT']:
        state = json.loads(sql(f"select to_jsonb(s) from private.employee_state s where employee_id='{user['employee']}';"))['state']
        if state != 'OUT':
            code, r = call('CLOCK_OUT',version); assert code == 200; version = r['version']
        for prep in ([] if initial=='OUT' else ['CLOCK_IN'] if initial=='WORKING' else ['CLOCK_IN','BREAK_START']):
            code, r = call(prep,version); assert code == 200; version = r['version']
        before = snapshot()
        code, r = call(action,version)
        if action in matrix[initial]:
            valid += 1
            check(code==200 and r['state']==matrix[initial][action] and r['version']==version+1, f'STATE-01 {initial}/{action} accepted')
            version = r['version']
        else:
            invalid += 1
            check(code==400 and r['message']=='INVALID_TRANSITION' and snapshot()==before,f'STATE-01 {initial}/{action} rejected atomically')
check((valid,invalid)==(5,7),'STATE-01 exactly five legal and seven illegal cells')
# Matrix ends OUT; no fabricated BREAK_END when PAUSED -> OUT.
check(sql(f"select string_agg(event_type::text,',' order by sequence) from public.time_events where session_id=(select session_id from public.time_events where employee_id='{user['employee']}' order by sequence desc limit 1);")=='CLOCK_IN,BREAK_START,CLOCK_OUT','paused exit preserves exact originals')
check(sql(f"select count(distinct session_id)>1 and count(*)=count(distinct sequence) from public.time_events where employee_id='{user['employee']}';")=='t','multiple same-day sessions and unique employee sequence')

# IDEM-01: browser double-click / two tabs same request, independent HTTP transactions.
request = uid()
with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
    barrier = threading.Barrier(20)
    def same(_):
        barrier.wait(timeout=10)
        return call('CLOCK_IN',version,request)
    results = list(pool.map(same,range(20)))
check(all(c==200 for c,r in results) and len({json.dumps(r,sort_keys=True) for c,r in results})==1,'IDEM-01 20 identical requests return one receipt')
r = results[0][1]; version = r['version']; first = r
check(sql(f"select count(*) from public.time_events where request_id='{request}';")=='1','double click creates one event')
check(sql(f"select count(*) from public.audit_log where request_id='{request}';")=='1','double click creates one audit')
code, err = call('CLOCK_OUT',version,request)
check(code==400 and err['message']=='IDEMPOTENCY_CONFLICT','IDEM-02 same UUID different action/version rejected')
# Same key against a different owned employee is also a conflict, never a new event.
owner_request = uid()
code, owner_r = call('CLOCK_IN',0,owner_request,owner['employee'],token=owner['token'])
assert code==200
code, err = call('CLOCK_OUT',0,owner_request,owner['employee'],token=owner['token'])
check(code==400 and err['message']=='IDEMPOTENCY_CONFLICT','IDEM payload binding covers full request')

# Policy update cannot rewrite an open session.
assign(canary)
check(sql(f"select timezone from public.work_sessions where id='{first['session_id']}';")=='Europe/Madrid','open session policy/timezone remain pinned')
code, r = call('CLOCK_OUT',version); assert code==200; version=r['version']
code, r = call('CLOCK_IN',version); assert code==200; version=r['version']
check(sql(f"select timezone from public.work_sessions where id='{r['session_id']}';")=='Atlantic/Canary','new session selects latest effective assignment')

# RACE-01/04: different requests, identical version (two tabs); one winner.
with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
    barrier = threading.Barrier(20)
    def race(_):
        barrier.wait(timeout=10)
        return call('BREAK_START',version)
    results = list(pool.map(race,range(20)))
check(sum(c==200 for c,r in results)==1 and sum(r.get('message')=='VERSION_CONFLICT' for c,r in results)==19,'RACE-01 20 distinct requests: one winner, 19 conflicts, no deadlock')
version += 1
code, r = call('CLOCK_OUT',version); assert code==200; version=r['version']
# TIME-01 no client time accepted at all by PostgREST signature.
code, _ = rpc('record_time_event',user['token'],dict(p_organization_id=org,p_request_id=uid(),p_employee_id=user['employee'],p_action='CLOCK_IN',p_expected_version=version,p_server_at='2000-01-01T00:00:00Z'))
check(code>=400,'TIME-01 forged client effective timestamp rejected')
# Single sampled time propagated into event, session, audit and receipt.
code, r = call('CLOCK_IN',version); assert code==200; version=r['version']
check(sql(f"select e.server_at=s.created_at and e.server_at=a.server_at and e.server_at=i.created_at from public.time_events e join public.work_sessions s on s.id=e.session_id join public.audit_log a on a.entity_id=e.id join private.idempotency_records i on i.key=e.request_id and i.operation='record_time_event' where e.id='{r['event_id']}';")=='t','one effective timestamp in event/session/audit/receipt')

# TIME-05 real PostgreSQL regression: future previous timestamp, untouched RPC.
last = sql(f"select last_event_at from private.employee_state where employee_id='{user['employee']}';")
sql(f"update private.employee_state set last_event_at=clock_timestamp()+interval '1 day' where employee_id='{user['employee']}';")
before = snapshot()
code, err = call('CLOCK_OUT',version)
check(code==400 and err['message']=='CLOCK_REGRESSION' and snapshot()==before,'TIME-05 regression fails without any partial write')
sql(f"update private.employee_state set last_event_at='{last}' where employee_id='{user['employee']}';")

# ATOM-01: fail audit AFTER state/event write; entire DB transaction must roll back.
sql("create function private.h2_fail_audit() returns trigger language plpgsql as $$ begin if new.action='record_time_event' then raise exception 'H2_AUDIT_FAILURE'; end if; return new; end $$; create trigger h2_fail before insert on public.audit_log for each row execute function private.h2_fail_audit();")
before = snapshot(); failed_request=uid()
code, err = call('CLOCK_OUT',version,failed_request)
check(code>=400 and err['message']=='H2_AUDIT_FAILURE' and snapshot()==before,'ATOM-01 audit failure rolls back event, state, session and idempotency')
sql('drop trigger h2_fail on public.audit_log; drop function private.h2_fail_audit();')
code, r = call('CLOCK_OUT',version,failed_request)
check(code==200,'ATOM-01 same failed request can succeed after rollback'); version=r['version']
# Also force failure while opening (must roll back the newly inserted session).
sql("create trigger h2_fail before insert on public.audit_log for each row execute function private.immutable_record();")
before=snapshot()
code, _ = call('CLOCK_IN',version)
check(code>=400 and snapshot()==before,'ATOM-01 failed CLOCK_IN leaves no orphan session')
sql('drop trigger h2_fail on public.audit_log;')

# IDEM-03 transport timeout AFTER commit, deterministic local proxy: forwards the
# request fully, drops the received ACK, reports TimeoutError to the caller.
# SQL is untouched. The retry goes directly to real PostgREST with the same UUID.
request=uid()
args=dict(p_organization_id=org,p_request_id=request,p_employee_id=user['employee'],p_action='CLOCK_IN',p_expected_version=version)
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
committed=threading.Event()
class LoseAck(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        code, result=rpc('record_time_event',user['token'],body)
        assert code==200
        self.server.result=result
        committed.set()
        self.server.release.wait(5)
server=ThreadingHTTPServer(('127.0.0.1',0),LoseAck)
server.release=threading.Event()
thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
try:
    req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/',data=json.dumps(args).encode(),headers={'Content-Type':'application/json'})
    try:
        urllib.request.urlopen(req,timeout=1)
        raise AssertionError('expected transport timeout')
    except TimeoutError:
        check(committed.wait(5),'IDEM-03 real commit occurred before lost-ACK timeout')
    code, r=rpc('record_time_event',user['token'],args)
    check(code==200 and r==server.result,'IDEM-03 retry after timeout recovers identical committed receipt')
    version=r['version']
finally:
    server.release.set(); server.shutdown(); server.server_close(); thread.join()

# RLS with real JWT: own history only, cross tenant RPC/REST/embedded join.
for table in ['work_policies','employee_policy_assignments','work_sessions','time_events']:
    code, rows=api('/rest/v1/'+table+'?organization_id=eq.'+org,other['token'])
    check(code==200 and rows==[], 'cross-tenant REST denied '+table)
    code, _=api('/rest/v1/'+table,None)
    check(code in (401,403),'anon denied '+table)
code, rows=api('/rest/v1/time_events?select=*,work_sessions!time_events_organization_id_employee_id_session_id_fkey(*)&employee_id=eq.'+owner['employee'],user['token'])
check(code==200 and rows==[],'own-only embedded session/event join')
code, _=call('CLOCK_OUT',version,organization=foreign,employee=other['employee'])
check(code==403,'cross tenant clock denied')
code, _=call('CLOCK_OUT',1,employee=owner['employee'])
check(code==403,'cannot clock on behalf of another employee')
code, _=call('CLOCK_OUT',version,token=owner['token'])
check(code==403,'OWNER also cannot clock for another employee')
for method in ['PATCH','DELETE']:
    code, _=api('/rest/v1/time_events?id=eq.'+first['event_id'],user['token'],{'event_type':'CLOCK_OUT'} if method=='PATCH' else None,method)
    check(code==403,'IMM-01 direct '+method+' denied')
code, state=rpc('get_employee_state',user['token'],dict(p_organization_id=org,p_employee_id=user['employee']))
check(code==200 and state['incident']=='OPEN_SESSION' and state['state']=='WORKING','open session explicitly incomplete without invented hours')
code, _=rpc('get_employee_state',user['token'],dict(p_organization_id=org,p_employee_id=owner['employee']))
check(code==403,'state read own-only')

# RACE-03 H1 revocation wins tenant lock first, waiting clock/replay must fail.
revoke_sql=fr'''begin;
select set_config('request.jwt.claims','{{"sub":"{owner['id']}","role":"authenticated"}}',true);
set local role authenticated;
select public.manage_membership('{org}','{uid()}','{user['membership']}',1,'EMPLOYEE',false);
\echo LOCKED
select pg_sleep(2);
commit;
'''
proc=subprocess.Popen(['docker','exec','-i',h.CONTAINER,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
proc.stdin.write(revoke_sql); proc.stdin.close()
while True:
    line=proc.stdout.readline()
    if line.strip()=='LOCKED': break
    assert line,'revocation did not lock'
code, _=call('CLOCK_OUT',version)
assert proc.wait(timeout=15)==0
check(code==403,'RACE-03 queued clock denied after revocation; no deadlock')
code, _=rpc('record_time_event',user['token'],args)
check(code==403,'IDEM-04 old JWT cannot recover committed receipt after revocation')
code, rows=api('/rest/v1/time_events',user['token'])
check(code==200 and rows==[],'revoked JWT cannot read originals')
print(f'PASS H2: {h.checks-start_checks} real integration checks; H1 also passed. No production data.',flush=True)
