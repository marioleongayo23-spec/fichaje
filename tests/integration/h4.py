"""Real gateway + GoTrue + PostgreSQL; full H1/H2/H3 run first. No RLS mocks."""
import base64
import concurrent.futures
import contextlib
import hashlib
import hmac
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes

# All output is buffered until the synthetic-PIN leak gate has inspected it.
output = io.StringIO()
known_pins = []
known_challenges = []
http_outputs = []
process = None
scratch = tempfile.TemporaryDirectory(prefix='kiosk-h4-')
root = Path(scratch.name)


def main():
    global process
    import h3  # noqa: F401 -- ALL previous real suites are mandatory.
    import h1 as h
    sql, rpc, uid, check = h.sql, h.rpc, h.uid, h.check
    initial = h.checks
    password = secrets.token_hex(32)
    # NOLOGIN gateway holds only entrypoint EXECUTE/USAGE. The ephemeral login
    # inherits that single role, with no table privileges or bypass. PG17 captures
    # INHERIT on the membership when GRANT runs; set it before the grant.
    sql(f"create role kiosk_ci login inherit password '{password}'; grant fichaje_gateway to kiosk_ci;")
    check(sql("select has_function_privilege('kiosk_ci','private.kiosk_admin_prepare(uuid,uuid,text,jsonb)','EXECUTE') and has_schema_privilege('kiosk_ci','private','USAGE');")=='t','ephemeral login inherits gateway entrypoints')
    check(sql("select has_table_privilege('kiosk_ci','public.employees','SELECT') or has_table_privilege('kiosk_ci','private.kiosk_credentials','SELECT');")=='f','ephemeral login inherits no data access')
    env = dict(os.environ, KIOSK_AUTH_URL=h.URL, KIOSK_ANON_KEY=h.ANON,
               KIOSK_NETWORK_SECRET=base64.b64encode(secrets.token_bytes(32)).decode(),
               KIOSK_AUTH_PROVISION_KEY=h.SERVICE, KIOSK_PEPPER=base64.b64encode(secrets.token_bytes(32)).decode(),
               KIOSK_DATABASE_URL=f'postgres://kiosk_ci:{password}@127.0.0.1:54322/postgres', KIOSK_PORT='8765')
    gateway_log = open(root/'gateway.log','wb')
    process = subprocess.Popen(['deno','run','--allow-env','--allow-net','--config','supabase/functions/kiosk/deno.json',
                                'supabase/functions/kiosk/index.ts'],env=env,stdout=gateway_log,stderr=gateway_log)
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError('gateway startup failed')
        try:
            urllib.request.urlopen('http://127.0.0.1:8765',timeout=1)
        except urllib.error.HTTPError:
            break
        except OSError:
            time.sleep(.1)
    else:
        raise AssertionError('gateway unavailable')

    def gw(route, token, body, source=None, extra_headers=None):
        if source:
            conn=http.client.HTTPConnection('127.0.0.1',8765,timeout=25,source_address=(source,0))
            conn.request('POST','/'+route,json.dumps(body),headers={'Content-Type':'application/json','Authorization':'Bearer '+token,**(extra_headers or {})})
            res=conn.getresponse(); data=res.read(); http_outputs.append(data)
            assert res.getheader('Cache-Control')=='no-store, max-age=0'
            status=res.status; conn.close(); return status,json.loads(data)
        req=urllib.request.Request('http://127.0.0.1:8765/'+route, data=json.dumps(body).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
        try:
            res=urllib.request.urlopen(req,timeout=25)
        except urllib.error.HTTPError as e:
            res=e
        with res:
            data=res.read()
            http_outputs.append(data)
            assert res.headers.get('Cache-Control')=='no-store, max-age=0','sensitive response must never cache'
            return res.status,json.loads(data)

    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    pub=key.public_key().public_numbers()
    def b64int(i):
        return base64.urlsafe_b64encode(i.to_bytes((i.bit_length()+7)//8,'big')).decode().rstrip('=')
    jwk={'kty':'RSA','n':b64int(pub.n),'e':b64int(pub.e),'alg':'RSA-OAEP-256','ext':True}
    def decrypt(cipher):
        return key.decrypt(base64.b64decode(cipher),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None)).decode()

    org,foreign=uid(),uid()
    owner,admin,worker,other=[h.account('h4-'+s) for s in ('owner','admin','worker','foreign')]
    for o,u in [(org,owner),(foreign,other)]:
        sql(f"select private.bootstrap_organization('{o}','Synthetic H4','{u['id']}','{uid()}');")
    for u,role in [(admin,'ADMIN'),(worker,'EMPLOYEE')]:
        token,_,_=h.invite(org,owner,u,role)
        assert h.accept(org,u,token)[0]==200

    def provision(o=org,manager=owner):
        body=dict(organization_id=o,request_id=uid(),device_id=uid(),name='Synthetic kiosk',expires_at='2099-01-01T00:00:00Z',delivery_key=jwk)
        code,r=gw('provision',manager['token'],body)
        assert code==200,'manager provisions real technical Auth device'
        access=json.loads(decrypt(r['delivery']))
        code,session=h.api('/auth/v1/token?grant_type=password',data=access)
        assert code==200,'real device Auth login'
        device={'id':body['device_id'],'token':session['access_token'],'auth_id':session['user']['id'],'body':body,'receipt':r}
        return device

    d=provision(); d2=provision(manager=admin); foreign_d=provision(foreign,other)
    check(sql(f"select count(*) from public.memberships where auth_user_id='{d['auth_id']}';")=='0','KIO-01 technical identity has no human membership')
    check(gw('provision',owner['token'],d['body'])==(200,d['receipt']),'device provisioning replay returns one encrypted delivery')
    concurrent_body=dict(d['body'],request_id=uid(),device_id=uid())
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        provision_results=list(pool.map(lambda _:gw('provision',owner['token'],concurrent_body),range(2)))
    check(provision_results[0]==provision_results[1] and provision_results[0][0]==200,'concurrent provisioning returns one persistent encrypted receipt')
    check(sql("select count(*) from auth.users u where u.raw_app_meta_data->>'identity_kind'='KIOSK' and not exists(select 1 from private.kiosk_devices d where d.auth_user_id=u.id);")=='0','concurrent provisioning compensates unused Auth identity')
    denied_body=dict(d['body'],request_id=uid(),device_id=uid())
    check(gw('provision',worker['token'],denied_body)[0]==403,'EMPLOYEE cannot provision')
    check(gw('provision',other['token'],denied_body)[0]==403,'foreign manager cannot provision')

    def reset(e,manager=owner,o=org):
        body=dict(organization_id=o,request_id=uid(),employee_id=e['id'],delivery_key=jwk)
        code,r=gw('reset',manager['token'],body)
        assert code==200,'PIN reset succeeds'
        pin=decrypt(r['delivery']); known_pins.append(pin)
        assert len(pin)==8 and pin.isdigit(),'random PIN minimum eight digits'
        e['pin']=pin
        return body,r

    def employee(o=org,manager=owner,policy=True):
        a=h.employee_args(o)
        assert rpc('manage_employee',manager['token'],a)[0]==200
        e={'id':a['p_employee_id'],'code':a['p_code'],'org':o}
        if policy:
            c,p=rpc('create_work_policy',manager['token'],dict(p_organization_id=o,p_request_id=uid(),p_timezone='Europe/Madrid',p_break_counts_as_work=False)); assert c==200
            c,_=rpc('assign_work_policy',manager['token'],dict(p_organization_id=o,p_request_id=uid(),p_employee_id=e['id'],p_policy_id=p['id'])); assert c==200
        reset(e,manager,o)
        return e

    e=employee(); e2=employee(); fe=employee(foreign,other)
    check(sql(f"select membership_id is null from public.employees where id='{e['id']}';")=='t','employee has neither email nor Auth membership')
    hashes_saved=sql(f"select pin_hash from private.kiosk_credentials where organization_id='{org}' order by employee_id;").splitlines()
    check(all(x.startswith('$argon2id$v=19$m=19456,t=2,p=1$') for x in hashes_saved),'Argon2id minimum parameters encoded in DB')
    check(len({x.split('$')[4] for x in hashes_saved})==len(hashes_saved),'independent random salts')

    def version(emp=e):
        return int(sql(f"select version from private.employee_state where organization_id='{emp['org']}' and employee_id='{emp['id']}';"))
    # KIO-H6-01 contract: code+PIN only; the server answers state, version and
    # one bound challenge per legal action. The kiosk never names the employee.
    def authenticate(emp=e,dev=d,pin=None,code=None,o=None):
        b=dict(organization_id=o or emp['org'],device_id=dev['id'],code=code or emp['code'],pin=pin or emp['pin'])
        c,r=gw('authenticate',dev['token'],b)
        return c,r,b
    def offers(emp=e,dev=d):
        c,r,b=authenticate(emp,dev)
        assert c==200,'correct PIN produces challenges'
        known_challenges.extend(x['challenge'] for x in r['challenges'])
        return r,{x['action']:dict(organization_id=b['organization_id'],device_id=dev['id'],action=x['action'],
                  expected_version=r['version'],request_id=x['request_id'],challenge=x['challenge']) for x in r['challenges']}
    def challenge(emp=e,dev=d,action='CLOCK_IN'):
        r,bodies=offers(emp,dev)
        assert action in bodies,'challenge offered only for a legal action'
        return bodies[action]
    def record(b,dev=d): return gw('record',dev['token'],b)
    def snap(emp=e):
        return sql(f"select jsonb_build_array((select to_jsonb(s) from private.employee_state s where employee_id='{emp['id']}'),(select count(*) from public.time_events where employee_id='{emp['id']}'),(select count(*) from public.audit_log where organization_id='{emp['org']}'),(select count(*) from private.idempotency_records where organization_id='{emp['org']}'),(select jsonb_agg(c order by id) from private.kiosk_challenges c where employee_id='{emp['id']}'));")

    wrong='0'*8 if e['pin']!='0'*8 else '1'*8
    c1,r1,_=authenticate(pin=wrong)
    c2,r2,_=authenticate(code='nonexistent-code',pin=wrong)
    check((c1,r1)==(c2,r2)==(403,{'error':'AUTH_FAILED'}),'KIO-02 unknown code and wrong PIN externally identical')
    b=challenge(); check(len(bytes.fromhex(b['challenge']))==32,'256-bit challenge')
    check(sql(f"select token_hash=encode(sha256(convert_to('{b['challenge']}','UTF8')),'hex') and expires_at-created_at=interval '60 seconds' from private.kiosk_challenges where request_id='{b['request_id']}';")=='t','hash only, exact server TTL 60 seconds')
    c,r=record(b);check(c==200 and r['state']=='WORKING','KIO-01 employee without email clocks in through real gateway')
    check(sql(f"select source='KIOSK' and actor_membership_id is null and kiosk_device_id='{d['id']}' from public.time_events where id='{r['event_id']}';")=='t','KIOSK original actor and device provenance')
    check(sql(f"select actor_kind='KIOSK' and actor_id='{d['auth_id']}' from public.audit_log where entity_id='{r['event_id']}' and action='kiosk_record_event';")=='t','atomic KIOSK audit actor')
    check(record(b)==(200,r),'same request retry returns exact committed receipt')
    sql(f"update private.kiosk_challenges set created_at=statement_timestamp()-interval '62 seconds',expires_at=statement_timestamp()-interval '2 seconds' where request_id='{b['request_id']}';")
    check(record(b)==(200,r),'consumed expired challenge only recovers same committed receipt')
    check(record(dict(b,request_id=uid()))[0]==403,'consumed challenge cannot authorize new request')
    check(record(dict(b,action='BREAK_START',expected_version=b['expected_version']+1))[0]==403,'consumed challenge cannot authorize a different payload')

    b=challenge(action='BREAK_START')
    cases=[('device',dict(b,device_id=d2['id']),d2),('employee field',dict(b,employee_id=e2['id']),d),
           ('tenant',dict(b,organization_id=foreign),d),('action',dict(b,action='CLOCK_OUT'),d),
           ('version',dict(b,expected_version=b['expected_version']+1),d),('request',dict(b,request_id=uid()),d)]
    before=snap()
    for label,body,dev in cases:
        check(record(body,dev)[0]==403,'KIO-05 bound challenge rejects different '+label)
    check(snap()==before,'all mismatched challenges preserve projection/events/challenge/receipt')
    results=list(concurrent.futures.ThreadPoolExecutor(12).map(lambda _:record(b),range(12)))
    check(all(x==results[0] and x[0]==200 for x in results),'concurrent double click recovers same receipt')
    check(sql(f"select count(*) from public.time_events where request_id='{b['request_id']}';")=='1','concurrent consumption creates exactly one event')
    for action,state in [('BREAK_END','WORKING'),('CLOCK_OUT','OUT')]:
        c,r=record(challenge(action=action));check(c==200 and r['state']==state,'shared H2 engine '+action)

    expired=challenge()
    sql(f"update private.kiosk_challenges set created_at=statement_timestamp()-interval '62 seconds',expires_at=statement_timestamp()-interval '2 seconds' where request_id='{expired['request_id']}';")
    check(record(expired)[0]==403,'expired challenge rejected')
    r,bodies=offers(); before=snap()
    check(sorted(bodies)==['CLOCK_IN'] and r['state']=='OUT','illegal transitions are never offered')
    check(record(dict(bodies['CLOCK_IN'],action='BREAK_START'))[0]==403 and snap()==before,'challenge cannot be redirected to an illegal action')
    # Audit insertion failure must roll back everything including challenge consumption.
    audit_challenge=challenge(); before=snap()
    sql("create function private.h4_fail_audit() returns trigger language plpgsql as $$ begin if new.actor_kind='KIOSK' then raise exception 'H4_AUDIT_FAILURE'; end if; return new; end $$; create trigger h4_fail before insert on public.audit_log for each row execute function private.h4_fail_audit();")
    check(record(audit_challenge)[0]>=400 and snap()==before,'audit failure rolls back event/state/session/challenge/receipt')
    sql('drop trigger h4_fail on public.audit_log; drop function private.h4_fail_audit();')
    check(record(audit_challenge)[0]==200,'same challenge/request retries after audit rollback')
    record(challenge(action='CLOCK_OUT'))

    # Real proxy commits upstream, then drops the downstream ACK.
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    committed=[]
    timeout_body=challenge()
    class DropACK(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            committed.append(record(timeout_body))
            self.connection.shutdown(2); self.connection.close()
        def log_message(self,*args): pass
    proxy=ThreadingHTTPServer(('127.0.0.1',0),DropACK)
    threading.Thread(target=proxy.serve_forever,daemon=True).start()
    lost=False
    try: urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{proxy.server_port}',data=b'{}'),timeout=20)
    except (OSError,Exception): lost=True
    proxy.shutdown();proxy.server_close()
    check(lost and committed and committed[0][0]==200 and record(timeout_body)==committed[0],'timeout after real commit recovers same receipt')
    record(challenge(action='CLOCK_OUT'))

    # Full H2 state matrix through the actual PIN/challenge gateway: exactly the
    # legal actions are offered; each executes; nothing else can be authorized.
    transitions={('OUT','CLOCK_IN'):'WORKING',('WORKING','BREAK_START'):'PAUSED',
                 ('WORKING','CLOCK_OUT'):'OUT',('PAUSED','BREAK_END'):'WORKING',('PAUSED','CLOCK_OUT'):'OUT'}
    for initial_state in ['OUT','WORKING','PAUSED']:
        for action in ['CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT']:
            matrix=employee()
            if initial_state!='OUT':assert record(challenge(matrix))[0]==200
            if initial_state=='PAUSED':assert record(challenge(matrix,action='BREAK_START'))[0]==200
            r,bodies=offers(matrix);before=snap(matrix)
            legal=sorted(a for (st,a) in transitions if st==initial_state)
            check(r['state']==initial_state and r['version']==version(matrix) and sorted(bodies)==legal,'kiosk offers exactly legal actions '+initial_state+'/'+action)
            if (initial_state,action) in transitions:
                c,res=record(bodies[action])
                check(c==200 and res['state']==transitions[(initial_state,action)],'kiosk state matrix '+initial_state+'/'+action)
            else:
                any_body=next(iter(bodies.values()))
                check(record(dict(any_body,action=action))[0]==403 and snap(matrix)==before,'kiosk illegal transition atomic '+initial_state+'/'+action)
    no_policy=employee(policy=False)
    check(record(challenge(no_policy))==(400,{'error':'POLICY_REQUIRED'}),'kiosk uses H2 policy gate')
    # Two independent grants at the same version: the first wins, the second hits the H2 gate.
    first_grant=challenge(); stale=challenge()
    check(record(first_grant)[0]==200 and record(stale)==(409,{'error':'VERSION_CONFLICT'}),'kiosk uses H2 expected_version gate')
    record(challenge(action='CLOCK_OUT'))
    clock_worker=employee()
    first=record(challenge(clock_worker))[1]
    regression=challenge(clock_worker,action='CLOCK_OUT')
    sql(f"update private.employee_state set last_event_at=clock_timestamp()+interval '1 day' where employee_id='{clock_worker['id']}';")
    before=snap(clock_worker)
    check(record(regression)==(400,{'error':'CLOCK_REGRESSION'}) and snap(clock_worker)==before,'kiosk rejects clock regression atomically')
    sql(f"update private.employee_state set last_event_at='{first['server_at']}' where employee_id='{clock_worker['id']}';")
    check(record(regression)[0]==200,'same request valid after clock recovers')
    forged=dict(challenge(clock_worker),server_at='2000-01-01T00:00:00Z')
    check(record(forged)[0]==403,'gateway rejects client-provided timestamp')
    disabled=employee(); disabled_challenge=challenge(disabled)
    sql(f"update public.employees set active=false where id='{disabled['id']}';")
    check(authenticate(disabled)[0]==403 and record(disabled_challenge)[0]==403,'inactive employee cannot authenticate or record')

    # Employee limit is shared across devices and persists across gateway requests.
    limited=employee()
    for i in range(5): check(authenticate(limited,d if i%2 else d2,pin=wrong)[0]==403,'persistent employee failure '+str(i+1))
    check(authenticate(limited,d)[0]==403 and authenticate(limited,d2)[0]==403,'correct PIN cannot bypass active employee lock on either device')
    old=limited['pin'];reset(limited)
    check(authenticate(limited)[0]==403,'manager reset does not clear active brute-force lock')
    sql(f"update private.kiosk_credentials set locked_until=clock_timestamp()-interval '1 second',window_start=clock_timestamp()-interval '16 minutes' where employee_id='{limited['id']}';")
    check(authenticate(limited,pin=old)[0]==403 and authenticate(limited)[0]==200,'PIN reset invalidates old secret and accepts replacement after lock expiry')
    # Device limit survives unknown codes and a correct credential.
    blocked_d=provision()
    for _ in range(30): assert authenticate(e,blocked_d,code=uid(),pin=wrong)[0]==403
    check(sql(f"select failures from private.auth_attempt_buckets where device_id='{blocked_d['id']}';")=='30','30 unknown codes persistently lock device')
    # Restart gateway: a process restart cannot clear the database lock.
    process.terminate();process.wait(timeout=10)
    process=subprocess.Popen(['deno','run','--allow-env','--allow-net','--config','supabase/functions/kiosk/deno.json','supabase/functions/kiosk/index.ts'],env=env,stdout=gateway_log,stderr=gateway_log)
    for _ in range(50):
        try:urllib.request.urlopen('http://127.0.0.1:8765',timeout=1)
        except urllib.error.HTTPError:break
        except OSError:time.sleep(.1)
    check(authenticate(e,blocked_d)[0]==403,'correct PIN cannot bypass active device lock')

    pending=challenge(e2,d2); previous=e2['pin']; rb,rr=reset(e2)
    check(record(pending,d2)[0]==403,'reset invalidates previously issued challenge')
    check(gw('reset',owner['token'],rb)==(200,rr),'PIN reset idempotent encrypted receipt')
    check(authenticate(e2,d2,pin=previous)[0]==403,'previous PIN cannot authenticate after reset')
    check(gw('reset',worker['token'],dict(rb,request_id=uid()))[0]==403,'EMPLOYEE cannot reset PIN')

    # No directory, data, reports, corrections, memberships or admin RPC from JWT.
    for table in ['employees','memberships','time_events','work_sessions','correction_requests','audit_log']:
        code,rows=h.api('/rest/v1/'+table+'?select=*',d['token']);check(code==200 and rows==[],'kiosk JWT cannot enumerate '+table)
    for name,args in [('manage_employee',h.employee_args(org)),('get_employee_state',{'p_organization_id':org,'p_employee_id':e['id']}),
                     ('create_work_policy',{'p_organization_id':org,'p_request_id':uid(),'p_timezone':'Europe/Madrid','p_break_counts_as_work':False}),
                     ('submit_correction',{'p_organization_id':org,'p_request_id':uid(),'p_employee_id':e['id'],'p_base_version':version(),'p_reason':'Synthetic','p_operations':[]})]:
        check(rpc(name,d['token'],args)[0]>=400,'kiosk cannot execute human RPC '+name)
    check(h.api('/rest/v1/kiosk_credentials?select=*',d['token'])[0]>=400,'private credentials not exposed by API')
    c1,r1,_=authenticate(o=foreign); c2,r2,_=authenticate(o=uid())
    check((c1,r1)==(c2,r2)==(403,{'error':'AUTH_FAILED'}),'foreign and nonexistent tenant indistinguishable')
    check(record(dict(pending,employee_id=fe['id']),d2)==record(dict(pending,employee_id=uid()),d2),'foreign and nonexistent employee UUID indistinguishable')

    check(rpc('record_time_event',d['token'],dict(p_organization_id=org,p_request_id=uid(),p_employee_id=e['id'],p_action='CLOCK_IN',p_expected_version=version()))[0]==403,'kiosk JWT cannot use human clock RPC without PIN')
    check(gw('revoke',d['token'],dict(organization_id=org,request_id=uid(),device_id=d2['id']))[0]==403,'kiosk cannot revoke devices')
    original=sql(f"select to_jsonb(t) from public.time_events t where id='{first['event_id']}';")
    for method,payload in [('PATCH',{'server_at':'2000-01-01T00:00:00Z'}),('DELETE',None)]:
        check(h.api('/rest/v1/time_events?id=eq.'+first['event_id'],d['token'],payload,method)[0]==403,'kiosk REST '+method+' original denied')
    check(sql(f"select to_jsonb(t) from public.time_events t where id='{first['event_id']}';")==original,'original event byte representation unchanged after attempts')

    # Revocation after device login denies authentication, pending event and receipt replay.
    rev=provision(); pending=challenge(e2,rev)
    revoke=dict(organization_id=org,request_id=uid(),device_id=rev['id'])
    check(gw('revoke',admin['token'],revoke)[0]==200,'ADMIN revokes device')
    check(authenticate(e2,rev)[0]==403 and record(pending,rev)[0]==403,'revoked device old JWT fails both authentication and event')
    # Revocation obtains the exact H1/H2 organization lock before event request starts.
    race=provision(); rb=challenge(e2,race)
    proc=subprocess.Popen(['docker','exec','-i',h.CONTAINER,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
    q=f"begin; select set_config('request.jwt.claim.sub','{owner['id']}',true); select private.kiosk_admin_apply('{org}','{uid()}','kiosk_revoke','{{\"target\":\"{race['id']}\"}}','{{}}'); select 'H4_LOCKED';\n"
    proc.stdin.write(q);proc.stdin.flush()
    while True:
        line=proc.stdout.readline();assert line,'revocation lock not acquired'
        if line.strip()=='H4_LOCKED':break
    pool=concurrent.futures.ThreadPoolExecutor(1); waiting=pool.submit(record,rb,race)
    time.sleep(.5); proc.stdin.write('commit;\n');proc.stdin.close();proc.wait(timeout=10)
    check(waiting.result()[0]==403,'revocation wins when it acquires shared organization lock first')
    pool.shutdown()

    # Revocation also denies old committed receipts.
    gw('revoke',owner['token'],dict(organization_id=org,request_id=uid(),device_id=d['id']))
    check(record(timeout_body)[0]==403,'revoked JWT cannot recover a previous receipt')
    check(sql("select count(*) from pg_roles where rolname in ('fichaje_kiosk','fichaje_gateway') and (rolsuper or rolbypassrls or rolcanlogin or rolinherit);")=='0','technical roles have no login/inheritance/bypass')
    check(sql("select has_table_privilege('fichaje_gateway','public.time_events','INSERT') or has_table_privilege('fichaje_gateway','private.kiosk_credentials','SELECT');")=='f','gateway SQL login has no direct table access')

    # SEC-H4-01: real TCP source, never forwarded/JSON client assertions.
    net_ip='127.81.82.83'; second_ip='127.81.82.84'
    net_employee=employee(); net_devices=[provision() for _ in range(3)]
    net_body=dict(organization_id=org,device_id=net_devices[0]['id'],code='missing-network-code',pin='0'*8)
    network_hash=hmac.new(base64.b64decode(env['KIOSK_NETWORK_SECRET']),f'kiosk-network-v1\n{org}\n{net_ip}'.encode(),hashlib.sha256).hexdigest()
    for i in range(60):
        dev=net_devices[i//20]
        status,result=gw('authenticate',dev['token'],dict(net_body,device_id=dev['id']),source=net_ip,
            extra_headers={'X-Forwarded-For':f'198.51.100.{i+1}','X-Real-IP':second_ip,'CF-Connecting-IP':second_ip,'Forwarded':f'for={second_ip}'})
        assert (status,result)==(403,{'error':'AUTH_FAILED'}),'network failures stay generic'
    check(sql(f"select failures=60 and locked_until>clock_timestamp() from private.kiosk_network_buckets where organization_id='{org}' and subject_hash='{network_hash}';")=='t','network bucket persists across devices despite arbitrary forwarded headers')
    check(sql(f"select count(*) from private.kiosk_network_buckets where organization_id='{org}' and subject_hash='{network_hash}';")=='1','normalized peer stored only as tenant HMAC')
    process.terminate();process.wait(timeout=10)
    process=subprocess.Popen(['deno','run','--allow-env','--allow-net','--config','supabase/functions/kiosk/deno.json','supabase/functions/kiosk/index.ts'],env=env,stdout=gateway_log,stderr=gateway_log)
    for _ in range(50):
        try:urllib.request.urlopen('http://127.0.0.1:8765',timeout=1)
        except urllib.error.HTTPError:break
        except OSError:time.sleep(.1)
    valid_body=dict(net_body,code=net_employee['code'],pin=net_employee['pin'])
    check(gw('authenticate',net_devices[0]['token'],valid_body,source=net_ip)==(403,{'error':'AUTH_FAILED'}),'correct PIN does not clear active network lock')
    check(gw('authenticate',net_devices[0]['token'],valid_body,source=second_ip)[0]==200,'separate actual connection peer has independent additional bucket')
    check(gw('authenticate',foreign_d['token'],dict(valid_body,organization_id=foreign,device_id=foreign_d['id'],code=fe['code'],pin=fe['pin']),source=net_ip)[0]==200,'network lock isolated from another tenant at same peer')
    check(gw('authenticate',net_devices[0]['token'],dict(valid_body,ip=second_ip),source=net_ip)[0]==403,'JSON cannot choose trusted network signal')
    check(sql(f"select bool_and(failures=20) from private.auth_attempt_buckets where device_id in ({','.join(chr(39)+dev['id']+chr(39) for dev in net_devices)});")=='t','additional limiter preserves per-device failure counters')
    check(sql("select has_table_privilege('fichaje_gateway','private.kiosk_network_buckets','SELECT') or has_table_privilege('authenticated','private.kiosk_network_buckets','SELECT');")=='f','network hashes inaccessible to clients and gateway login')
    # Expiry uses server time; no success can unlock early.
    sql(f"update private.kiosk_network_buckets set window_start=clock_timestamp()-interval '31 minutes',locked_until=clock_timestamp()-interval '1 second' where organization_id='{org}' and subject_hash='{network_hash}';")
    check(gw('authenticate',net_devices[0]['token'],valid_body,source=net_ip)[0]==200,'expired network lock resets using server clock')

    # KIO-H6-01 identification contract on its own tenant, before the leak gate.
    import kio_h6
    kio_h6.run(dict(locals(),known_challenges=known_challenges))

    # Entire database serialization plus ALL actual Docker logs, gateway output,
    # captured HTTP responses and generated build/test artifacts are scanned in memory.
    database=sql("select string_agg(row_to_json(t)::text,E'\\n') from (select 'placeholder' as value) t;")
    for schema in ['public','private','auth']:
        tables=sql(f"select tablename from pg_tables where schemaname='{schema}';").splitlines()
        for table in tables:
            database+=sql(f'select coalesce(string_agg(row_to_json(t)::text,chr(10)),\'\') from "{schema}"."{table}" t;')
    containers=subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
    logs=b''.join(subprocess.run(['docker','logs',c],capture_output=True).stdout+subprocess.run(['docker','logs',c],capture_output=True).stderr for c in containers if c.startswith('supabase_'))
    gateway_log.flush()
    buffers=[database.encode(),logs,(root/'gateway.log').read_bytes(),output.getvalue().encode(),*http_outputs]
    for base in [root,Path('dist')]:
        if base.exists():buffers.extend(p.read_bytes() for p in base.rglob('*') if p.is_file())
    for pin in known_pins:
        assert all(pin.encode() not in blob for blob in buffers),'PIN_LEAK_DETECTED'
    # Challenge secrets exist only in the kiosk's HTTP responses; the database keeps hashes.
    stored=[b for b in buffers if all(b is not out for out in http_outputs)]
    for token in known_challenges:
        assert all(token.encode() not in blob for blob in stored),'CHALLENGE_LEAK_DETECTED'
    for address in [net_ip,second_ip]:
        assert all(address.encode() not in blob for blob in buffers),'NETWORK_PLAINTEXT_LEAK_DETECTED'
    audit=sql("select coalesce(string_agg(row_to_json(t)::text,chr(10)),'') from public.audit_log t;")
    for digest in sql("select subject_hash from private.kiosk_network_buckets;").splitlines():
        assert all(digest.encode() not in blob for blob in buffers[1:]) and digest not in audit,'NETWORK_DIGEST_LEAK_DETECTED'
    check(True,'KIO-07 network plaintext absent from DB/logs/responses/artifacts; hashes absent outside private buckets')
    check(len(known_pins)>0,'KIO-07 known synthetic PIN absent from DB/logs/responses/cacheable responses/generated artifacts')
    check(len(known_challenges)>0,'KIO-07 raw challenge secrets absent from DB/logs/gateway output/artifacts (hash only)')
    print(f'H4 real gateway checks: {h.checks-initial}; full H1+H2+H3 retained.')


if __name__=='__main__':
    try:
        with contextlib.redirect_stdout(output),contextlib.redirect_stderr(output):main()
    except BaseException:
        # Safe trace gives source lines and exception type but never values/SQL/HTTP bodies.
        import sys,traceback
        kind,_,tb=sys.exc_info()
        import re
        if (root/'gateway.log').exists():
            # OPS-02 structured events: only stage and stable class are printed.
            for line in (root/'gateway.log').read_text().splitlines():
                try:
                    event = json.loads(line) if line.startswith('{') else {}
                except ValueError:
                    continue
                if event.get('outcome') in ('failure','unknown'):
                    print('Gateway failure stage/class:',event.get('stage'),event.get('error_class'))
        print('H4 suite failed:',kind.__name__)
        for frame in traceback.extract_tb(tb):print(f'{frame.filename}:{frame.lineno} in {frame.name}')
        raise SystemExit(1)
    else:
        assert all(pin not in output.getvalue() for pin in known_pins),'PIN_LEAK_DETECTED'
        print(output.getvalue(),end='')
    finally:
        if process:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill()
        scratch.cleanup()
