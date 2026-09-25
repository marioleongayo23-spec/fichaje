"""KIO-H6-01 against the real Deno gateway, GoTrue, PostgREST and PostgreSQL.

Runs inside the H4 suite (same gateway process, helpers and KIO-07 leak scan),
on its own tenant so its failure buckets are independent of the H4 run.
"""
import concurrent.futures
import hashlib
import json
import time


def run(x):
    h, sql, uid, check, gw = x['h'], x['sql'], x['uid'], x['check'], x['gw']
    provision, employee, reset, record, version = x['provision'], x['employee'], x['reset'], x['record'], x['version']
    authenticate, offers, known_challenges = x['authenticate'], x['offers'], x['known_challenges']
    initial = h.checks
    org, other_org = uid(), uid()
    owner, other = h.account('kio6-owner'), h.account('kio6-foreign')
    for o, u in ((org, owner), (other_org, other)):
        sql(f"select private.bootstrap_organization('{o}','Synthetic KIO-H6-01','{u['id']}','{uid()}');")
    dev, dev2 = provision(org, owner), provision(org, owner)
    foreign_dev = provision(other_org, other)
    a, b = employee(org, owner), employee(org, owner)
    foreign_employee = employee(other_org, other)
    wrong = '0' * 8 if a['pin'] != '0' * 8 else '1' * 8

    def events(emp):
        return int(sql(f"select count(*) from public.time_events where organization_id='{emp['org']}' and employee_id='{emp['id']}';"))

    def row(request):
        return json.loads(sql(f"select to_jsonb(c) from private.kiosk_challenges c where request_id='{request}';"))

    def credential(emp):
        return int(sql(f"select credential_version from private.kiosk_credentials where organization_id='{emp['org']}' and employee_id='{emp['id']}';"))

    # 1. Authentication needs only code+PIN; the answer is state, version, legal actions, challenges.
    c, r, body = authenticate(a, dev)
    known_challenges.extend(o['challenge'] for o in r.get('challenges', []))
    check(c == 200 and sorted(body) == ['code', 'device_id', 'organization_id', 'pin'],
          'KIO-H6-01 authenticate needs only code+PIN: no action, version or request from the kiosk')
    check(sorted(r) == ['actions', 'challenges', 'state', 'version'], 'KIO-H6-01 response carries only state, version, actions and challenges')
    check(r['state'] == 'OUT' and r['actions'] == ['CLOCK_IN'] and [o['action'] for o in r['challenges']] == ['CLOCK_IN'],
          'KIO-H6-01 OUT offers only CLOCK_IN')
    check(r['version'] == version(a), 'KIO-H6-01 authoritative version returned')
    check(all(sorted(o) == ['action', 'challenge', 'request_id'] for o in r['challenges']), 'KIO-H6-01 each challenge exposes only action, secret and own request')
    text = json.dumps(r)
    check(a['id'] not in text and a['code'] not in text and 'Synthetic' not in text, 'KIO-H6-01 no employee id, code or name disclosed to the kiosk')
    offer = r['challenges'][0]
    stored = row(offer['request_id'])
    check(stored['organization_id'] == org and stored['device_id'] == dev['id'] and stored['employee_id'] == a['id']
          and stored['action'] == 'CLOCK_IN' and stored['expected_version'] == r['version'] and stored['credential_version'] == credential(a)
          and stored['grant_id'] and stored['used_at'] is None,
          'KIO-H6-01 challenge bound server-side to tenant, device, employee, action, version, own request and credential')
    check(sql(f"select expires_at>created_at and expires_at-created_at<=interval '60 seconds' and token_hash='{hashlib.sha256(offer['challenge'].encode()).hexdigest()}' "
              f"from private.kiosk_challenges where request_id='{offer['request_id']}';") == 't', 'KIO-H6-01 TTL <= 60 s and only the hash is stored')
    for legacy in (dict(body, action='CLOCK_IN'), dict(body, expected_version=0), dict(body, request_id=uid()), dict(body, employee_id=a['id'])):
        assert gw('authenticate', dev['token'], legacy) == (403, {'error': 'AUTH_FAILED'})
    check(True, 'KIO-H6-01 client-chosen action, version, request or employee rejected at authentication')
    clock_in = dict(organization_id=org, device_id=dev['id'], action='CLOCK_IN', expected_version=r['version'],
                    request_id=offer['request_id'], challenge=offer['challenge'])
    c, receipt = record(clock_in, dev)
    check(c == 200 and receipt['state'] == 'WORKING' and receipt['version'] == r['version'] + 1, 'KIO-H6-01 CLOCK_IN recorded only after ACK with the bound challenge')

    # 2. WORKING: two independent challenges on the same version.
    r, bodies = offers(a, dev)
    check(r['state'] == 'WORKING' and r['actions'] == ['BREAK_START', 'CLOCK_OUT'] and sorted(bodies) == ['BREAK_START', 'CLOCK_OUT'],
          'KIO-H6-01 WORKING offers BREAK_START and CLOCK_OUT')
    check(r['version'] == version(a) == receipt['version'], 'KIO-H6-01 WORKING version authoritative')
    rows = [row(o['request_id']) for o in bodies.values()]
    check(len({o['challenge'] for o in bodies.values()}) == 2 and len({o['request_id'] for o in bodies.values()}) == 2
          and len({x['token_hash'] for x in rows}) == 2 and len({x['grant_id'] for x in rows}) == 1
          and all(x['expected_version'] == r['version'] and x['action'] == k for x, k in zip(rows, bodies)),
          'KIO-H6-01 independent challenges: own secret, request and action per sibling')
    before = events(a)
    c, paused = record(bodies['BREAK_START'], dev)
    check(c == 200 and paused['state'] == 'PAUSED', 'KIO-H6-01 first sibling executes')
    check(record(bodies['CLOCK_OUT'], dev) == (403, {'error': 'AUTH_FAILED'}) and events(a) == before + 1 and version(a) == paused['version'],
          'KIO-H6-01 executing one challenge invalidates its sibling: no second event')
    check(record(bodies['BREAK_START'], dev) == (200, paused), 'KIO-H6-01 unknown ACK recovers the exact committed receipt')
    check(record(dict(bodies['BREAK_START'], request_id=uid()), dev)[0] == 403, 'KIO-H6-01 reused challenge cannot authorize a new request')

    # 3. PAUSED, then concurrent siblings (double click on both buttons).
    r, bodies = offers(a, dev)
    check(r['state'] == 'PAUSED' and r['actions'] == ['BREAK_END', 'CLOCK_OUT'] and r['version'] == version(a),
          'KIO-H6-01 PAUSED offers BREAK_END and CLOCK_OUT with authoritative version')
    before = events(a)
    batch = [bodies['BREAK_END']] * 4 + [bodies['CLOCK_OUT']] * 4
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda q: (q['action'], record(q, dev)), batch))
    winners = {action for action, (code, _) in results if code == 200}
    check(len(winners) == 1 and events(a) == before + 1, 'KIO-H6-01 concurrent siblings: exactly one action, exactly one event')
    winner = next(res for action, res in results if res[0] == 200)
    check(all(res == winner for action, res in results if action in winners)
          and all(res[0] == 403 for action, res in results if action not in winners), 'KIO-H6-01 losing sibling rejected, winner retries share one receipt')
    if winner[1]['state'] == 'WORKING':
        assert record(challenge_for(offers, a, dev, 'CLOCK_OUT'), dev)[0] == 200

    # 4. Expired, and every binding dimension.
    r, bodies = offers(a, dev)
    expired = bodies['CLOCK_IN']
    sql(f"update private.kiosk_challenges set created_at=statement_timestamp()-interval '62 seconds',expires_at=statement_timestamp()-interval '2 seconds' "
        f"where request_id='{expired['request_id']}';")
    count = events(a)
    check(record(expired, dev) == (403, {'error': 'AUTH_FAILED'}) and events(a) == count, 'KIO-H6-01 expired challenge rejected')
    r, bodies = offers(a, dev)
    live = bodies['CLOCK_IN']
    snapshot = sql(f"select jsonb_build_array((select to_jsonb(s) from private.employee_state s where employee_id='{a['id']}'),"
                   f"(select count(*) from public.time_events where employee_id='{a['id']}'),(select jsonb_agg(c order by id) from private.kiosk_challenges c where employee_id='{a['id']}'));")
    cases = [('action', dict(live, action='BREAK_START'), dev), ('version', dict(live, expected_version=live['expected_version'] + 1), dev),
             ('request', dict(live, request_id=uid()), dev), ('device', dict(live, device_id=dev2['id']), dev2),
             ('device body', dict(live, device_id=dev2['id']), dev), ('tenant', dict(live, organization_id=other_org), dev),
             ('foreign device', dict(live, organization_id=other_org, device_id=foreign_dev['id']), foreign_dev),
             ('employee field', dict(live, employee_id=b['id']), dev), ('timestamp field', dict(live, server_at='2000-01-01T00:00:00Z'), dev)]
    for label, payload, device in cases:
        check(record(payload, device) == (403, {'error': 'AUTH_FAILED'}), 'KIO-H6-01 challenge rejects different ' + label)
    check(sql(f"select jsonb_build_array((select to_jsonb(s) from private.employee_state s where employee_id='{a['id']}'),"
              f"(select count(*) from public.time_events where employee_id='{a['id']}'),(select jsonb_agg(c order by id) from private.kiosk_challenges c where employee_id='{a['id']}'));") == snapshot,
          'KIO-H6-01 rejected challenges leave state, events and challenges untouched')
    # A different employee can never be named: the writer rejects the tuple even from inside the database.
    token_hash = hashlib.sha256(live['challenge'].encode()).hexdigest()
    sql("begin; select set_config('request.jwt.claims','" + json.dumps({'sub': dev['auth_id'], 'role': 'authenticated'}) + "',true);"
        f" do $$ begin perform private.kiosk_record_event('{org}','{dev['id']}','{b['id']}','CLOCK_IN',{live['expected_version']},'{live['request_id']}','{token_hash}');"
        " raise exception 'KIO_H6_UNEXPECTED'; exception when insufficient_privilege then null; end $$; rollback;")
    check(events(b) == 0, 'KIO-H6-01 challenge rejects different employee')
    c, receipt = record(live, dev)
    check(c == 200 and sql(f"select employee_id from public.time_events where id='{receipt['event_id']}';") == a['id'],
          'KIO-H6-01 event always belongs to the PIN holder bound in the challenge')
    assert record(challenge_for(offers, a, dev, 'CLOCK_OUT'), dev)[0] == 200

    # 5. Generic failures: wrong PIN and unknown code are indistinguishable.
    started = time.monotonic(); c1 = authenticate(a, dev, pin=wrong)[:2]; t1 = time.monotonic() - started
    started = time.monotonic(); c2 = authenticate(a, dev, code='missing-' + uid()[:8], pin=wrong)[:2]; t2 = time.monotonic() - started
    started = time.monotonic(); c3 = authenticate(a, dev, code='missing-' + uid()[:8], pin=a['pin'])[:2]; t3 = time.monotonic() - started
    check(c1 == c2 == c3 == (403, {'error': 'AUTH_FAILED'}), 'KIO-H6-01 wrong PIN and nonexistent code return the same generic error')
    check(min(t1, t2, t3) >= 0.29, 'KIO-H6-01 generic failures honour the response time floor')
    check(authenticate(foreign_employee, dev, o=org)[:2] == (403, {'error': 'AUTH_FAILED'}), 'KIO-H6-01 foreign employee code unknown in this tenant')
    check(authenticate(a, dev, o=other_org)[:2] == authenticate(a, dev, o=uid())[:2] == (403, {'error': 'AUTH_FAILED'}),
          'KIO-H6-01 foreign and nonexistent tenant indistinguishable')

    # 6. Revocations: device, employee and credential.
    temporary = provision(org, owner)
    pending = challenge_for(offers, a, temporary, 'CLOCK_IN')
    assert gw('revoke', owner['token'], dict(organization_id=org, request_id=uid(), device_id=temporary['id']))[0] == 200
    count = events(a)
    check(authenticate(a, temporary)[0] == 403 and record(pending, temporary)[0] == 403 and events(a) == count,
          'KIO-H6-01 revoked device can neither authenticate nor use a pending challenge')
    leaving = employee(org, owner)
    pending = challenge_for(offers, leaving, dev, 'CLOCK_IN')
    current = int(sql(f"select version from public.employees where id='{leaving['id']}';"))
    code, _ = h.rpc('manage_employee', owner['token'], dict(p_organization_id=org, p_request_id=uid(), p_employee_id=leaving['id'],
                    p_expected_version=current, p_code=leaving['code'], p_display_name='Synthetic employee', p_membership_id=None, p_active=False))
    check(code == 200 and authenticate(leaving, dev)[0] == 403 and record(pending, dev)[0] == 403 and events(leaving) == 0,
          'KIO-H6-01 deactivated employee can neither authenticate nor use a pending challenge')
    pending = challenge_for(offers, b, dev, 'CLOCK_IN')
    previous = b['pin']
    reset(b, owner, org)
    check(record(pending, dev)[0] == 403 and events(b) == 0, 'KIO-H6-01 credential reset invalidates pending challenges')
    check(authenticate(b, dev, pin=previous)[0] == 403 and authenticate(b, dev)[0] == 200, 'KIO-H6-01 reset: old PIN rejected, new PIN accepted')

    # 7. Rate limits unchanged (employee 5, device 30; network 60 is SEC-H4-01 in H4).
    limited = employee(org, owner)
    for _ in range(5):
        assert authenticate(limited, dev2, pin=wrong)[0] == 403
    check(authenticate(limited, dev2)[0] == 403 and authenticate(limited, dev)[0] == 403, 'KIO-H6-01 employee limit still blocks a correct PIN on every device')
    locked = provision(org, owner)
    for _ in range(30):
        assert authenticate(a, locked, code='missing-' + uid()[:8], pin=wrong)[0] == 403
    check(authenticate(a, locked)[0] == 403 and authenticate(a, dev)[0] == 200, 'KIO-H6-01 device limit still blocks a correct PIN on that device only')

    # 8. The device identity has no general query surface.
    for table in ['employees', 'memberships', 'time_events', 'work_sessions', 'correction_requests', 'audit_log', 'employee_policy_assignments', 'work_policies']:
        code, rows_ = h.api('/rest/v1/' + table + '?select=*', dev['token'])
        check(code == 200 and rows_ == [], 'KIO-H6-01 device cannot enumerate ' + table)
    for path in ['/rest/v1/employee_state?select=*', '/rest/v1/kiosk_challenges?select=*', '/rest/v1/rpc/kiosk_auth_grant', '/rest/v1/rpc/kiosk_record']:
        check(h.api(path, dev['token'], {} if 'rpc' in path else None)[0] >= 400, 'KIO-H6-01 private objects not exposed: ' + path.split('/')[-1].split('?')[0])
    for name, args in [('get_employee_state', {'p_organization_id': org, 'p_employee_id': a['id']}),
                       ('record_time_event', {'p_organization_id': org, 'p_request_id': uid(), 'p_employee_id': a['id'], 'p_action': 'CLOCK_IN', 'p_expected_version': version(a)}),
                       ('manage_employee', h.employee_args(org))]:
        check(h.rpc(name, dev['token'], args)[0] >= 400, 'KIO-H6-01 device cannot call human RPC ' + name)
    for route in ['state', 'employees', 'history', 'challenge']:
        check(gw(route, dev['token'], {'organization_id': org, 'device_id': dev['id']}) == (403, {'error': 'AUTH_FAILED'}), 'KIO-H6-01 gateway has no ' + route + ' route')
    check(sql(f"select count(*) from private.kiosk_challenges where organization_id='{org}' and grant_id is null;") == '0', 'KIO-H6-01 every issued challenge belongs to a grant')
    print(f'KIO-H6-01 real checks: {h.checks - initial}')


def challenge_for(offers, emp, dev, action):
    _, bodies = offers(emp, dev)
    assert action in bodies, 'legal action offered'
    return bodies[action]
