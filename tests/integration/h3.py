"""COR-01..06 against real Supabase. Import executes all H1 and H2 first."""
import concurrent.futures
import json
import subprocess
import threading
from datetime import datetime, timedelta, timezone
import h2  # noqa: F401 -- mandatory H1 + H2 regression suite
import h1 as h

sql, rpc, api, uid, check = h.sql, h.rpc, h.api, h.uid, h.check
start_checks = h.checks
org, foreign = uid(), uid()
owner, admin, user, other = [h.account('h3-'+x) for x in ('owner','admin','worker','foreign')]
for o,u in [(org,owner),(foreign,other)]:
    sql(f"select private.bootstrap_organization('{o}','Synthetic H3','{u['id']}','{uid()}');")
    u['membership']=sql(f"select id from public.memberships where organization_id='{o}' and auth_user_id='{u['id']}';")
for u,role in [(admin,'ADMIN'),(user,'EMPLOYEE')]:
    token,_,_=h.invite(org,owner,u,role)
    code,r=h.accept(org,u,token); assert code==200,r
    u['membership']=r['id']
for o,u,manager in [(org,owner,owner),(org,admin,owner),(org,user,admin),(foreign,other,other)]:
    args=h.employee_args(o,u['membership'])
    code,r=rpc('manage_employee',manager['token'],args); assert code==200,r
    u['employee']=args['p_employee_id']
    code,p=rpc('create_work_policy',manager['token'],dict(p_organization_id=o,p_request_id=uid(),p_timezone='Europe/Madrid',p_break_counts_as_work=False)); assert code==200,p
    code,r=rpc('assign_work_policy',manager['token'],dict(p_organization_id=o,p_request_id=uid(),p_employee_id=u['employee'],p_policy_id=p['id'])); assert code==200,r


def state(u=user,o=org):
    code,r=rpc('get_employee_state',u['token'],dict(p_organization_id=o,p_employee_id=u['employee']))
    assert code==200,r
    return r


def clock(action,u=user,o=org):
    code,r=rpc('record_time_event',u['token'],dict(p_organization_id=o,p_request_id=uid(),p_employee_id=u['employee'],p_action=action,p_expected_version=state(u,o)['version']))
    assert code==200,(code,r)
    return r


def now():
    return sql("select clock_timestamp();")


def iso(t):
    return datetime.fromisoformat(t.replace('Z','+00:00')).isoformat()


def op(action,session,t=None,kind='ADD',target=None,previous=None,ordinal=1):
    x=dict(operation=kind,session_id=session)
    if target: x['target_event_id']=target
    if previous: x['supersedes_adjustment_id']=previous
    if kind!='VOID':
        x.update(event_type=action,effective_at=iso(t),ordinal=ordinal,timezone='Europe/Madrid')
    return x


def submit_args(ops,u=user,version=None):
    return dict(p_organization_id=org,p_request_id=uid(),p_employee_id=u['employee'],
                p_base_version=state(u)['version'] if version is None else version,p_reason='Synthetic correction evidence',p_operations=ops)


def submit(ops,u=user,by=None,version=None):
    args=submit_args(ops,u,version)
    code,r=rpc('submit_correction',(by or u)['token'],args)
    assert code==200,('submit',code,r,ops)
    return r['correction_request_id'],args


def decide_args(request,decision='APPROVE'):
    return dict(p_organization_id=org,p_request_id=uid(),p_correction_request_id=request,p_decision=decision,p_reason='Independent review')


def decide(request,by=admin,decision='APPROVE',args=None):
    return rpc('decide_correction',by['token'],args or decide_args(request,decision))


def approved(ops,u=user,by=None,reviewer=admin):
    request,args=submit(ops,u,by)
    code,r=decide(request,reviewer)
    assert code==200,('approve',code,r,ops)
    return r


def timeline(u=user,o=org,cutoff=None,token=None):
    args=dict(p_organization_id=o,p_employee_id=u['employee'])
    if cutoff: args['p_cutoff']=cutoff
    code,r=rpc('get_effective_timeline',token or u['token'],args)
    assert code==200,(code,r)
    return r


def snapshot():
    return sql(f"select jsonb_build_array((select jsonb_agg(s order by employee_id) from private.employee_state s where organization_id='{org}'),(select count(*) from public.correction_requests where organization_id='{org}'),(select count(*) from public.correction_decisions where organization_id='{org}'),(select count(*) from public.event_adjustments where organization_id='{org}'),(select count(*) from public.work_sessions where organization_id='{org}'),(select count(*) from public.audit_log where organization_id='{org}'),(select count(*) from private.idempotency_records where organization_id='{org}'));")


def rejected_approval(ops,message):
    request,_=submit(ops)
    before=snapshot()
    code,r=decide(request)
    check(code==400 and r.get('message')==message and snapshot()==before,f'COR-04 {message}: candidate rolled back ({code}, {r})')


entry=clock('CLOCK_IN'); exit_event=clock('CLOCK_OUT')
foreign_entry=clock('CLOCK_IN',other,foreign)
originals=sql(f"select jsonb_agg(e order by sequence) from public.time_events e where employee_id='{user['employee']}';")
cutoff=now()
# REPLACE same legal instant; evidence keeps source/author and original server_at.
replace=op('CLOCK_OUT',entry['session_id'],entry['server_at'],kind='REPLACE',target=exit_event['event_id'],ordinal=2)
r=approved([replace]); leaf=r['adjustment_ids'][0]
check(state()['version']==3 and state()['state']=='OUT','COR-05 approval increments version and reconstructs projection')
rows=timeline()
check(len(rows)==2 and rows[1]['source']=='CORRECTION' and rows[1]['actor_membership_id']==admin['membership'] and rows[1]['server_at']==exit_event['server_at'] and rows[1]['effective_at']==entry['server_at'],'COR-06 original time separated from corrected time and decision author')
check(all(x['source']=='WEB' for x in timeline(cutoff=iso(cutoff))),'COR-06 historical cutoff reconstructs before correction')
# Several corrections on original lineage and on an ADD lineage.
r=approved([op('CLOCK_OUT',entry['session_id'],exit_event['server_at'],kind='REPLACE',target=exit_event['event_id'],previous=leaf,ordinal=2)])
leaf=r['adjustment_ids'][0]
check(timeline()[1]['adjustment_id']==leaf,'COR-01 latest chain revision alone is effective')
args=submit_args([replace]); code,err=rpc('submit_correction',user['token'],args)
check(code==409 and err['message']=='VERSION_CONFLICT','COR-01 stale adjustment reference rejected even with current base_version')
r=approved([op(None,entry['session_id'],kind='VOID',target=exit_event['event_id'],previous=leaf)])
check(state()['state']=='WORKING' and state()['open_session_id']==entry['session_id'],'COR-01 VOID reopens real session without touching originals')
close_time=now()
r=approved([op('CLOCK_OUT',entry['session_id'],close_time,ordinal=10)])
added=r['adjustment_ids'][0]
check(state()['state']=='OUT','COR-01 ADD closes corrected session')
r=approved([op('CLOCK_OUT',entry['session_id'],close_time,kind='REPLACE',previous=added,ordinal=11)])
added_leaf=r['adjustment_ids'][0]
check(timeline()[-1]['adjustment_id']==added_leaf and timeline()[-1]['server_at'] is None,'COR-01 ADD chain has no fabricated original timestamp')
check(sql(f"select jsonb_agg(e order by sequence) from public.time_events e where employee_id='{user['employee']}';")==originals,'COR-06 originals byte-for-byte intact after REPLACE/VOID/ADD/chain')
# New session only from ADD entry and applicable pinned policy; zero interval legal.
new_session=uid(); t=now()
r=approved([op('CLOCK_IN',new_session,t,ordinal=20),op('CLOCK_OUT',new_session,t,ordinal=21)])
check(len(timeline())==4 and state()['state']=='OUT','COR-01 ADD creates a new pinned session with explicit zero interval')
new_in,new_out=r['adjustment_ids']
# REJECT and unique decisions: receipt replay identical, new key cannot decide twice.
request,args=submit([op('BREAK_START',entry['session_id'],close_time,ordinal=12)])
before=state(); before_timeline=timeline(); adjustments=sql(f"select count(*) from public.event_adjustments where organization_id='{org}';")
dargs=decide_args(request,'REJECT'); code,r=decide(request,args=dargs)
check(code==200 and r['adjustment_ids']==[] and state()==before and timeline()==before_timeline,'COR-05 rejection leaves timeline/projection/version untouched')
check(sql(f"select count(*) from public.event_adjustments where organization_id='{org}';")==adjustments,'COR-01 rejection creates no adjustments')
check(decide(request,args=dargs)==(code,r),'COR-01 same decision request id recovers exact receipt')
code,err=decide(request)
check(code==409 and err['message']=='ALREADY_DECIDED','COR-01 second decision key rejected')
changed={**dargs,'p_reason':'Changed'}; code,err=decide(request,args=changed)
check(code==400 and err['message']=='IDEMPOTENCY_CONFLICT','decision receipt binds full payload')
check(rpc('submit_correction',user['token'],args)[0]==200,'submission replay remains valid after decision')
# Independence: requester manager / affected manager / worker / tenant.
request,_=submit([op(None,new_session,kind='VOID',previous=new_out)],by=admin)
code,_=decide(request,admin)
check(code==403,'COR-02 manager requester cannot approve own request')
code,_=decide(request,user)
check(code==403,'COR-02 EMPLOYEE cannot decide')
code,_=decide(request,other)
check(code==403,'COR-02 foreign manager cannot decide')
code,_=decide(request,owner,decision='REJECT'); check(code==200,'independent OWNER can reject manager request')
aentry=clock('CLOCK_IN',admin)
request,_=submit([op('CLOCK_OUT',aentry['session_id'],now())],u=admin,by=owner)
code,_=decide(request,admin)
check(code==403,'COR-02 affected manager cannot approve another manager request')
code,_=decide(request,owner)
check(code==403,'COR-02 sole other manager cannot approve own submission: no exception')
# Owner submits own -> other admin can decide.
oentry=clock('CLOCK_IN',owner)
request,_=submit([op('CLOCK_OUT',oentry['session_id'],now())],u=owner)
code,_=decide(request,owner); check(code==403,'COR-02 affected OWNER cannot approve')
code,_=decide(request,admin); check(code==200,'COR-02 independent ADMIN may approve OWNER timeline')
# Invalid metadata and reference safety at submit, no partial writes.
valid=op('CLOCK_OUT',new_session,t,kind='REPLACE',previous=new_out,ordinal=21)
for change in [dict(p_reason='  '),dict(p_reason='x'*1001),dict(p_base_version=0),dict(p_operations=[]),dict(p_operations=[{**valid,'ordinal':None}]),dict(p_operations=[{**valid,'ordinal':0}]),dict(p_operations=[{**valid,'ordinal':1.5}]),dict(p_operations=[{**valid,'effective_at':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}]),dict(p_operations=[{**valid,'surprise':'x'}]),dict(p_operations=[{**valid,'timezone':'CET'}])]:
    args={**submit_args([valid]),**change}; before=snapshot(); code,_=rpc('submit_correction',user['token'],args)
    check(code>=400 and snapshot()==before,'invalid reason/base/proposal/ordinal/future/zone rejected without effects')
for bad in [op('CLOCK_OUT',foreign_entry['session_id'],foreign_entry['server_at'],kind='REPLACE',target=foreign_entry['event_id']),op('CLOCK_OUT',foreign_entry['session_id'],t),{**valid,'supersedes_adjustment_id':uid()}]:
    before=snapshot(); code,_=rpc('submit_correction',user['token'],submit_args([bad]))
    check(code==403 and snapshot()==before,'cross-tenant/unknown event, session or adjustment denied')
# A real foreign adjustment for cross-tenant reference test, made using independent
# synthetic manager in the other tenant (no test bypass of production RPC).
foreign_admin=h.account('h3-foreign-admin')
token,_,_=h.invite(foreign,other,foreign_admin,'ADMIN'); code,ar=h.accept(foreign,foreign_admin,token); assert code==200
fa=dict(p_organization_id=foreign,p_request_id=uid(),p_employee_id=other['employee'],p_base_version=1,p_reason='Synthetic',p_operations=[op('CLOCK_OUT',foreign_entry['session_id'],now())])
code,fr=rpc('submit_correction',other['token'],fa); assert code==200,fr
fd={**decide_args(fr['correction_request_id']),'p_organization_id':foreign}
code,fr=rpc('decide_correction',foreign_admin['token'],fd); assert code==200,fr
code,_=rpc('submit_correction',user['token'],submit_args([{**valid,'supersedes_adjustment_id':fr['adjustment_ids'][0]}]))
check(code==403,'real adjustment belonging to another tenant denied')
# Replay validates entire history, not just edited pair.
rejected_approval([op(None,new_session,kind='VOID',previous=new_in)],'INVALID_TIMELINE')
early=(datetime.fromisoformat(iso(entry['server_at']))-timedelta(seconds=1)).isoformat()
rejected_approval([op('CLOCK_OUT',new_session,early,kind='REPLACE',previous=new_out,ordinal=21)],'INVALID_TIMELINE')
rejected_approval([op('CLOCK_IN',new_session,entry['server_at'],kind='REPLACE',previous=new_in,ordinal=2)],'INVALID_TIMELINE')
rejected_approval([op('CLOCK_OUT',new_session,t,kind='REPLACE',previous=new_out,ordinal=20)],'INVALID_ORDINAL')
# Empty effective history and no sequence reuse; then H2 resumes safely.
r=approved([op(None,entry['session_id'],kind='VOID',target=entry['event_id']),op(None,entry['session_id'],kind='VOID',previous=added_leaf),op(None,new_session,kind='VOID',previous=new_in),op(None,new_session,kind='VOID',previous=new_out)])
check(timeline()==[] and state()['last_sequence']==2 and state()['last_event_at'] is None,'all VOID leaves empty OUT projection without recycling original sequences')
resume=clock('CLOCK_IN'); check(resume['sequence']==3,'H2 resumes at preserved original sequence after empty correction')
# Obsolete proposal both at submission and decision (including REJECT).
request,_=submit([op('CLOCK_OUT',resume['session_id'],now())])
clock('CLOCK_OUT')
for decision in ['APPROVE','REJECT']:
    before=snapshot(); code,err=decide(request,decision=decision)
    check(code==409 and err['message']=='VERSION_CONFLICT' and snapshot()==before,'COR-03 stale base at decision rejected: '+decision)
# Audit failure after all writes: rollback decision, adjustment, new session,
# projection and receipt, then retry same key after restoring audit.
new_session=uid(); t=now(); ops=[op('CLOCK_IN',new_session,t),op('CLOCK_OUT',new_session,t,ordinal=2)]
request,_=submit(ops); dargs=decide_args(request)
sql("create function private.h3_fail_audit() returns trigger language plpgsql as $$ begin if new.action in ('submit_correction','decide_correction') then raise exception 'H3_AUDIT_FAILURE'; end if; return new; end $$; create trigger h3_fail before insert on public.audit_log for each row execute function private.h3_fail_audit();")
before=snapshot(); code,err=decide(request,args=dargs)
check(code>=400 and err['message']=='H3_AUDIT_FAILURE' and snapshot()==before,'COR-05 audit failure rolls back decision/adjustments/new session/projection/receipt')
args=submit_args(ops); code,err=rpc('submit_correction',user['token'],args)
check(code>=400 and err['message']=='H3_AUDIT_FAILURE' and snapshot()==before,'submission audit failure rolls back request and receipt')
sql('drop trigger h3_fail on public.audit_log; drop function private.h3_fail_audit();')
code,r=decide(request,args=dargs); check(code==200,'approval retry succeeds after complete rollback')
# Concurrent independent HTTP transactions, synchronized start.
def parallel(fn,n=20):
    barrier=threading.Barrier(n)
    def run(i):
        barrier.wait(timeout=10)
        return fn(i)
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(run,range(n)))

session=uid(); t=now(); ops=[op('CLOCK_IN',session,t),op('CLOCK_OUT',session,t,ordinal=2)]
args=submit_args(ops)
results=parallel(lambda _: rpc('submit_correction',user['token'],args))
check(all(c==200 for c,r in results) and len({json.dumps(r,sort_keys=True) for c,r in results})==1,'20 simultaneous identical submissions persist one request/receipt')
request=results[0][1]['correction_request_id']; dargs=decide_args(request); successful_decision_args=dargs.copy()
results=parallel(lambda _:decide(request,args=dargs))
check(all(c==200 for c,r in results) and len({json.dumps(r,sort_keys=True) for c,r in results})==1,'20 simultaneous identical approvals persist one decision/receipt')
check(sql(f"select count(*) from public.event_adjustments a join public.correction_decisions d on d.id=a.decision_id where d.request_id='{request}';")=='2','same approval creates exactly the two intended adjustments')
# Different requests on same base: only one may approve. Equal instants explicit.
session=uid(); t=now(); ops=[op('CLOCK_IN',session,t),op('CLOCK_OUT',session,t,ordinal=2)]
requests=[submit(ops)[0] for _ in range(20)]
results=parallel(lambda i:decide(requests[i]))
check(sum(c==200 for c,r in results)==1 and sum(r.get('message')=='VERSION_CONFLICT' for c,r in results)==19,'COR-03 20 proposals same base leave one approval and 19 conflicts')
# Correction and ordinary clock share the same version/locks.
session=uid(); t=now(); request,_=submit([op('CLOCK_IN',session,t),op('CLOCK_OUT',session,t,ordinal=2)])
base=state()['version']
clock_args=dict(p_organization_id=org,p_request_id=uid(),p_employee_id=user['employee'],p_action='CLOCK_IN',p_expected_version=base)
results=parallel(lambda i:decide(request) if i==0 else rpc('record_time_event',user['token'],clock_args),2)
check(sum(c==200 for c,r in results)==1 and sum(r.get('message')=='VERSION_CONFLICT' for c,r in results)==1,'H2 clock versus H3 approval: one shared-version winner')
if state()['state']=='WORKING': clock('CLOCK_OUT')
# A timeline containing only corrections has sequence zero; H2 can continue it.
fresh_args=h.employee_args(org)
code,fresh=rpc('manage_employee',admin['token'],fresh_args); assert code==200,fresh
fresh_employee=fresh_args['p_employee_id']
policy_id=sql(f"select policy_id from public.employee_policy_assignments where employee_id='{user['employee']}' limit 1;")
code,r=rpc('assign_work_policy',admin['token'],dict(p_organization_id=org,p_request_id=uid(),p_employee_id=fresh_employee,p_policy_id=policy_id)); assert code==200,r
session=uid(); t=now()
fresh_submit=dict(p_organization_id=org,p_request_id=uid(),p_employee_id=fresh_employee,p_base_version=0,p_reason='Assisted synthetic request',p_operations=[op('CLOCK_IN',session,t)])
code,r=rpc('submit_correction',owner['token'],fresh_submit); assert code==200,r
code,r=decide(r['correction_request_id'],admin)
check(code==200 and sql(f"select state||':'||last_sequence from private.employee_state where employee_id='{fresh_employee}';")=='WORKING:0','ADD-only employee without Auth supported via independent managers, no kiosk implementation')
# RLS: all three evidence tables, raw writes, foreign and same-tenant private reads.
for table in ['correction_requests','correction_decisions','event_adjustments']:
    code,rows=api('/rest/v1/'+table+'?organization_id=eq.'+org,other['token'])
    check(code==200 and rows==[],'cross-tenant REST read denied '+table)
    code,rows=api('/rest/v1/'+table+'?employee_id=eq.'+owner['employee'],user['token'])
    check(code==200 and rows==[],'same tenant other employee read denied '+table)
    code,_=api('/rest/v1/'+table,None); check(code in (401,403),'anonymous read denied '+table)
    for method in ['POST','PATCH','DELETE']:
        code,_=api('/rest/v1/'+table,admin['token'],{} if method!='DELETE' else None,method)
        check(code==403,'direct '+method+' denied '+table)
check(timeline(token=other['token'])==[],'effective timeline RPC cannot leak foreign tenant')
check(timeline(u=owner,token=user['token'])==[],'effective timeline RPC cannot leak another employee')
# Revocation takes shared H1 tenant lock; waiting approval must recheck identity.
session=uid(); t=now(); request,_=submit([op('CLOCK_IN',session,t),op('CLOCK_OUT',session,t,ordinal=2)])
dargs=decide_args(request)
revoke_sql=fr'''begin;
select set_config('request.jwt.claims','{{"sub":"{owner['id']}","role":"authenticated"}}',true);
set local role authenticated;
select public.manage_membership('{org}','{uid()}','{admin['membership']}',1,'ADMIN',false);
\echo LOCKED
select pg_sleep(2);
commit;
'''
proc=subprocess.Popen(['docker','exec','-i',h.CONTAINER,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
proc.stdin.write(revoke_sql);proc.stdin.close()
while True:
    line=proc.stdout.readline()
    if line.strip()=='LOCKED': break
    assert line,'revocation failed to lock'
code,_=decide(request,args=dargs); assert proc.wait(timeout=15)==0
check(code==403,'waiting approval revalidates permissions after concurrent H1 revocation')
check(sql(f"select count(*) from public.correction_decisions where request_id='{request}';")=='0','revoked queued decision leaves no partial decision')
code,_=decide(successful_decision_args['p_correction_request_id'],args=successful_decision_args); check(code==403,'revoked JWT cannot decide or obtain previous receipt')
print(f'PASS H3: {h.checks-start_checks} real integration checks; all H1 + H2 also passed.',flush=True)
