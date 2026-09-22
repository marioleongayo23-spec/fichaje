"""Real local Supabase Auth/PostgREST/Storage + DB concurrency. No mocks or remote target."""
import concurrent.futures
import hashlib
import json
import secrets
import subprocess
import urllib.error
import urllib.request
import uuid

status = json.loads(subprocess.check_output(['supabase', 'status', '-o', 'json'], stderr=subprocess.DEVNULL))
URL = status['API_URL']
assert URL in ('http://127.0.0.1:54321', 'http://localhost:54321'), 'Local stack only'
ANON = status['ANON_KEY']
SERVICE = status['SERVICE_ROLE_KEY']
CONTAINER = 'supabase_db_fichaje-h1'
checks = 0


def check(condition, label):
    global checks
    assert condition, label
    checks += 1
    print(f'ok {checks} - {label}', flush=True)


def api(path, token=None, data=None, method=None, raw=None):
    headers = {'apikey': ANON, 'Authorization': 'Bearer ' + (token or ANON)}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    if raw is not None:
        body = raw
        headers['Content-Type'] = 'text/plain'
    req = urllib.request.Request(URL + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            result = res.read()
            return res.status, json.loads(result) if result else None
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read())
        except (ValueError, UnicodeError):
            payload = {}
        return err.code, payload


def sql(query):
    return subprocess.check_output(['docker', 'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], input=query.encode()).decode().strip()


def rpc(name, token, data):
    return api('/rest/v1/rpc/' + name, token, data)


def uid():
    return str(uuid.uuid4())


def account(label, verified=True):
    email = f'{label}-{uuid.uuid4().hex}@example.invalid'
    password = secrets.token_urlsafe(32)
    code, user = api('/auth/v1/admin/users', SERVICE, {'email': email, 'password': password, 'email_confirm': verified})
    assert code in (200, 201), 'Auth admin create failed'
    if not verified:
        return {'id': user['id'], 'email': email}
    code, session = api('/auth/v1/token?grant_type=password', data={'email': email, 'password': password})
    assert code == 200, f"Real password sign-in failed: HTTP {code}, code={session.get('error_code', 'unknown')}"
    return {'id': user['id'], 'email': email, 'token': session['access_token']}


def invite(org, issuer, target, role):
    token = secrets.token_hex(32)
    request = uid()
    args = dict(p_organization_id=org, p_request_id=request, p_email=target['email'], p_role=role,
                p_token_hash=hashlib.sha256(token.encode()).hexdigest())
    code, receipt = rpc('create_invitation', issuer['token'], args)
    assert code == 200, 'Create invitation failed'
    return token, receipt, args


def accept(org, user, token, request=None):
    return rpc('accept_invitation', user['token'], dict(p_organization_id=org, p_request_id=request or uid(), p_token=token))


def employee_args(org, membership=None):
    return dict(p_organization_id=org, p_request_id=uid(), p_employee_id=uid(), p_expected_version=0,
                p_code=uuid.uuid4().hex[:12], p_display_name='Synthetic employee', p_membership_id=membership, p_active=True)


# No public self-enrolment. GoTrue, not a JavaScript Auth stand-in.
code, _ = api('/auth/v1/signup', data={'email': 'denied@example.invalid', 'password': secrets.token_urlsafe(32)})
check(code >= 400, 'public Auth signup disabled')
orgs = [uid(), uid()]
teams = []
for n, org in enumerate(orgs):
    team = [account(f'{n}-{role}') for role in ('owner', 'admin', 'employee')]
    sql(f"select private.bootstrap_organization('{org}','Synthetic {n}','{team[0]['id']}','{uid()}');")
    team[0]['membership'] = sql(f"select id from public.memberships where organization_id='{org}' and auth_user_id='{team[0]['id']}';")
    for user, role in zip(team[1:], ['ADMIN', 'EMPLOYEE']):
        token, _, _ = invite(org, team[0], user, role)
        request = uid()
        code, receipt = accept(org, user, token, request)
        check(code == 200, f'Auth verified invitation {n} {role}')
        user['membership'] = receipt['id']
        code, replay = accept(org, user, token, request)
        check(code == 200 and replay == receipt, 'invitation same request replays')
        code, _ = accept(org, user, token)
        check(code == 403, 'invitation token consumed once')
    for user in team:
        args = employee_args(org, user['membership'])
        code, _ = rpc('manage_employee', team[0]['token'], args)
        assert code == 200, 'Create linked employee failed'
        user['employee'] = args['p_employee_id']
    code, _ = rpc('manage_employee', team[1]['token'], employee_args(org))
    check(code == 200, 'ADMIN creates employee without email or Auth')
    teams.append(team)

for n, team in enumerate(teams):
    for i, user in enumerate(team):
        for table, count in [('organizations', 1), ('memberships', 1 if i == 2 else 3), ('employees', 1 if i == 2 else 4)]:
            code, rows = api('/rest/v1/' + table + '?select=*', user['token'])
            check(code == 200 and len(rows) == count, f'REST RLS {n}/{i}/{table}')
        code, rows = api('/rest/v1/employees?select=*,memberships!employees_organization_id_membership_id_fkey(*)&organization_id=eq.' + orgs[1-n], user['token'])
        check(code == 200 and rows == [], 'REST cross-tenant embedded join empty')
        code, _ = rpc('manage_employee', user['token'], employee_args(orgs[1-n]))
        check(code == 403, 'cross-tenant RPC denied with real JWT')
        code, _ = api('/rest/v1/memberships?id=eq.' + user['membership'], user['token'], {'role': 'OWNER'}, 'PATCH')
        check(code == 403, 'direct role escalation denied')

owner, admin, employee = teams[0]
org = orgs[0]
# Storage enabled but no business policy grants exist in H1. Exercise actual private object.
bucket = 'h1-' + uuid.uuid4().hex
code, _ = api('/storage/v1/bucket', SERVICE, {'id': bucket, 'name': bucket, 'public': False})
assert code in (200, 201), 'Storage fixture bucket failed'
code, _ = api('/storage/v1/object/' + bucket + '/fixture.txt', SERVICE, raw=b'Synthetic fixture', method='POST')
assert code in (200, 201), 'Storage fixture upload failed'
for token in [None] + [u['token'] for team in teams for u in team]:
    code, rows = api('/storage/v1/object/list/' + bucket, token, {'prefix': ''})
    check((code == 200 and rows == []) or code in (400, 401, 403), 'Storage listing denied/empty')
    code, _ = api('/storage/v1/object/' + bucket + '/fixture.txt', token)
    check(code in (400, 401, 403, 404), 'Storage private download denied')
for table in ['organizations', 'memberships', 'employees']:
    code, _ = api('/rest/v1/' + table, None)
    check(code in (401, 403), 'anon denied ' + table)
code, _ = rpc('manage_employee', None, employee_args(org))
check(code in (401, 403), 'anon denied RPC')
# Invitation destination/tenant/role/TTL bound to verified identity.
new = account('invitee')
token, receipt, args = invite(org, admin, new, 'EMPLOYEE')
code, _ = accept(org, employee, token)
check(code == 403, 'invitation rejects different identity/email')
code, _ = accept(orgs[1], new, token)
check(code == 403, 'invitation rejects wrong tenant')
code, _ = rpc('create_invitation', admin['token'], {**args, 'p_request_id': uid(), 'p_role': 'ADMIN'})
check(code == 403, 'ADMIN cannot invite ADMIN')
code, _ = rpc('create_invitation', owner['token'], {**args, 'p_request_id': uid(), 'p_role': 'OWNER'})
check(code == 403, 'cannot invite OWNER')
sql(f"update private.invitations set expires_at=clock_timestamp()-interval '1 second' where id='{receipt['id']}';")
code, _ = accept(org, new, token)
check(code == 403, 'expired invitation denied')
# A real unverified Auth account cannot sign in; direct SQL gate is additionally covered below.
unverified = account('unverified', False)
token_u, _, _ = invite(org, owner, unverified, 'EMPLOYEE')
result = sql(f"begin; set local role authenticated; select set_config('request.jwt.claims','{{\"sub\":\"{unverified['id']}\",\"role\":\"authenticated\"}}',true); do $$ begin perform public.accept_invitation('{org}','{uid()}','{token_u}'); raise exception 'unexpected acceptance'; exception when insufficient_privilege then null; end $$; rollback;")
check('ROLLBACK' in result, 'unverified identity rejected inside PostgreSQL')
# Same Auth identity can have independent roles in two tenants.
token2, _, _ = invite(orgs[1], teams[1][0], owner, 'EMPLOYEE')
code, _ = accept(orgs[1], owner, token2)
check(code == 200, 'same Auth identity joins second organization')
code, _ = rpc('manage_employee', owner['token'], employee_args(orgs[1]))
check(code == 403, 'OWNER in A remains EMPLOYEE in B')
# Concurrent idempotent writes, real independent HTTP/DB transactions.
args = employee_args(org)
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    results = list(pool.map(lambda _: rpc('manage_employee', admin['token'], args), range(12)))
check(all(c == 200 and x == results[0][1] for c, x in results), '12 simultaneous same requests return same receipt')
check(sql(f"select count(*) from public.audit_log where request_id='{args['p_request_id']}';") == '1', 'exactly one concurrent audit')
code, _ = rpc('manage_employee', admin['token'], {**args, 'p_display_name': 'Changed payload'})
check(code == 400, 'same request different payload conflicts')
version_args = {**args, 'p_expected_version': 1}
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    results = list(pool.map(lambda _: rpc('manage_employee', admin['token'], {**version_args, 'p_request_id': uid()}), range(12)))
check(sum(c == 200 for c, _ in results) == 1 and sum(x.get('code') == '40001' for c, x in results if c != 200) == 11,
      'concurrent versions: one winner and eleven VERSION_CONFLICT')
# Audit failure rolls back the business row and idempotency record.
sql("create function private.test_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_FAILURE'; end $$; create trigger test_fail_audit before insert on public.audit_log for each row execute function private.test_fail_audit();")
failed = employee_args(org)
code, _ = rpc('manage_employee', admin['token'], failed)
check(code >= 400, 'audit failure rejects mutation')
check(sql(f"select count(*) from public.employees where id='{failed['p_employee_id']}';") == '0', 'audit failure rolls back employee')
check(sql(f"select count(*) from private.idempotency_records where key='{failed['p_request_id']}';") == '0', 'audit failure rolls back receipt')
sql('drop trigger test_fail_audit on public.audit_log; drop function private.test_fail_audit();')
# Revocation obtains tenant lock first; queued writer must revalidate after waiting.
pending, _, _ = invite(org, admin, new, 'EMPLOYEE')
revoke_request = uid()
revoke_sql = fr"""begin;
select set_config('request.jwt.claims','{{"sub":"{owner['id']}","role":"authenticated"}}',true);
set local role authenticated;
select public.manage_membership('{org}','{revoke_request}','{admin['membership']}',1,'ADMIN',false);
\echo REVOCATION_LOCKED
select pg_sleep(3);
commit;
"""
proc = subprocess.Popen(['docker','exec','-i',CONTAINER,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
proc.stdin.write(revoke_sql)
proc.stdin.close()
while True:
    line = proc.stdout.readline()
    if line.strip() == 'REVOCATION_LOCKED':
        break
    assert line, 'revocation transaction did not acquire lock'
code, _ = rpc('manage_employee', admin['token'], employee_args(org))
assert proc.wait(timeout=15) == 0, 'revocation transaction failed'
check(code == 403, 'queued writer denied after concurrent revocation')
code, rows = api('/rest/v1/employees?select=*', admin['token'])
check(code == 200 and rows == [], 'previous JWT loses read access immediately')
code, _ = rpc('manage_employee', admin['token'], args)
check(code == 403, 'previous JWT cannot replay committed receipt')
code, _ = accept(org, new, pending)
check(code == 403, 'revoked issuer invitation invalid')
# Ownership transfer is atomic and retryable.
transfer = dict(p_organization_id=org,p_request_id=uid(),p_new_owner_membership_id=employee['membership'],p_expected_version=1)
code, response = rpc('transfer_ownership', owner['token'], transfer)
check(code == 200, 'atomic ownership transfer')
code, replay = rpc('transfer_ownership', owner['token'], transfer)
check(code == 200 and replay == response, 'previous owner can replay same transfer')
code, _ = rpc('transfer_ownership', owner['token'], {**transfer,'p_request_id':uid()})
check(code == 403, 'previous owner cannot transfer again')
code, _ = rpc('manage_membership', employee['token'], dict(p_organization_id=org,p_request_id=uid(),p_membership_id=employee['membership'],p_expected_version=2,p_role='EMPLOYEE',p_active=False))
check(code == 403, 'new OWNER cannot remove own ownership')
print(f'PASS: {checks} real integration checks. Synthetic data only; local stack destroyed by CI.', flush=True)
