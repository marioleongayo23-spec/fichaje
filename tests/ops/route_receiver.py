"""Loopback emulator of the PagerDuty Events API v2 and the GitHub Issues API
used by the H7 alert route tests and drills (never a real provider)."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROUTING_KEY = 'R' * 16 + '0123456789abcdef'
GITHUB_TOKEN = 'github_pat_' + 'S' * 40


class Receiver:
    """Loopback HTTP receiver emulating PagerDuty (/v2/enqueue) and GitHub (/repos/...)."""

    def __init__(self):
        self.events, self.issues, self.requests, self.fail_next = [], {}, [], []
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _reply(self, status, payload):
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self, method):
                raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                body = json.loads(raw) if raw else None
                receiver.requests.append({'method': method, 'path': self.path, 'headers': dict(self.headers), 'raw': raw, 'at': time.time()})
                if receiver.fail_next:
                    return self._reply(receiver.fail_next.pop(0), {'status': 'error'})
                if self.path == '/v2/enqueue':
                    valid = (method == 'POST' and body.get('routing_key') == ROUTING_KEY and body.get('event_action') in ('trigger', 'resolve')
                             and str(body.get('dedup_key', '')).startswith('fichaje-')
                             and (body['event_action'] == 'resolve' or (body['payload']['severity'] in ('critical', 'warning')
                                                                        and len(body['payload']['summary']) <= 1024)))
                    if not valid:
                        return self._reply(400, {'status': 'invalid event'})
                    receiver.events.append({**body, '_received_at': time.time()})
                    return self._reply(202, {'status': 'success', 'dedup_key': body['dedup_key']})
                if self.headers.get('Authorization') != 'Bearer ' + GITHUB_TOKEN:
                    return self._reply(401, {'message': 'Bad credentials'})
                parts = self.path.split('?')[0].strip('/').split('/')
                if method == 'GET' and parts[-1] == 'issues':
                    return self._reply(200, [i for i in receiver.issues.values() if i['state'] == 'open'])
                if method == 'POST' and parts[-1] == 'issues':
                    number = len(receiver.issues) + 1
                    receiver.issues[number] = {'number': number, 'title': body['title'], 'body': body['body'], 'labels': body['labels'],
                                               'state': 'open', 'comments': []}
                    return self._reply(201, receiver.issues[number])
                if method == 'POST' and parts[-1] == 'comments':
                    receiver.issues[int(parts[-2])]['comments'].append(body['body'])
                    return self._reply(201, {'id': 1})
                if method == 'PATCH':
                    receiver.issues[int(parts[-1])].update(state=body['state'], state_reason=body.get('state_reason'))
                    return self._reply(200, receiver.issues[int(parts[-1])])
                return self._reply(404, {'message': 'Not Found'})

            def do_GET(self):
                self._handle('GET')

            def do_POST(self):
                self._handle('POST')

            def do_PATCH(self):
                self._handle('PATCH')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
