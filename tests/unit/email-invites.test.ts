import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderInviteEmail } from '../../supabase/functions/send-invitation/email';
import { handleInvitation } from '../../supabase/functions/send-invitation/handler';

const org = '5f2b3c4d-1111-4222-8333-944455556666';
const requestId = '6f2b3c4d-1111-4222-8333-944455556666';
const actor = '7f2b3c4d-1111-4222-8333-944455556666';
const code = 'a'.repeat(64);
const origin = 'https://bundy.example';
const payload = { organization_id: org, request_id: requestId, token: code, email: 'employee@example.com', role: 'EMPLOYEE' };
const configuration: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_synthetic',
  RESEND_API_KEY: 'synthetic-provider-only',
  BUNDY_MAIL_FROM: 'hello@bundy.example',
  BUNDY_APP_ORIGIN: origin,
  BUNDY_INVITES_ENABLED: '1',
};
const environment = (overrides: Record<string,string> = {}) => (name: string) => ({ ...configuration, ...overrides })[name];
function request(body: unknown = payload, domain = origin) {
  return new Request('https://project.supabase.co/functions/v1/send-invitation', {
    method: 'POST',
    headers: { Origin: domain, 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-user-token' },
    body: JSON.stringify(body),
  });
}

describe('H15 Bundy email rendering', () => {
  it('escapes company names and keeps bearer invitation codes out of URLs', () => {
    const invite = renderInviteEmail(origin, 'Empresa <script>&', org + '.' + code);
    expect(invite.html).toContain('Empresa &lt;script&gt;&amp;');
    expect(invite.html).not.toContain('<script>');
    expect(invite.html).toContain('/icons/icon-192.png');
    expect(invite.html).toContain('#1F4A33');
    expect(invite.html).toContain('#F2C230');
    expect(invite.html).not.toContain('href="' + origin + '/?');
    expect(invite.text).toContain(org + '.' + code);
    expect(escapeHtml('"><')).toBe('&quot;&gt;&lt;');
  });

  it('all five Supabase Auth templates use official brand and GoTrue action placeholders', () => {
    for (const name of ['confirmation', 'recovery', 'magic_link', 'email_change', 'invite']) {
      const html = readFileSync('supabase/templates/' + name + '.html', 'utf8');
      expect(html, name).toContain('{{ .ConfirmationURL }}');
      expect(html, name).toContain('{{ .SiteURL }}/icons/icon-192.png');
      expect(html, name).toContain('#1F4A33');
      expect(html, name).toContain('#F2C230');
      expect(html, name).toContain('<html lang="es">');
      expect(html, name).not.toContain('style="display:none"');
    }
  });
});

describe('H15 invitation email handler: authorization, delivery and idempotency', () => {
  const calls: {url: string; init?: RequestInit}[] = [];
  const transport = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const route = String(url);
    calls.push({ url: route, init });
    if (route.endsWith('/auth/v1/user')) return Response.json({ id: actor, email_confirmed_at: '2026-10-11T12:00:00Z' });
    if (route.endsWith('/rest/v1/rpc/create_invitation')) return Response.json({ id: 'synthetic-invite-id' });
    if (route.includes('/rest/v1/organizations?')) return Response.json([{ name: 'Empresa <script>&' }]);
    if (route === 'https://api.resend.com/emails') return Response.json({ id: 'synthetic-message-id' });
    throw new Error('UNEXPECTED_REQUEST');
  }) as typeof fetch;

  it('rejects wrong origins, invalid bodies and disabled delivery without side effects', async () => {
    calls.length = 0;
    expect((await handleInvitation(request(payload, 'https://evil.example'), environment(), transport)).status).toBe(403);
    expect((await handleInvitation(request({ ...payload, role: 'OWNER' }), environment(), transport)).status).toBe(400);
    expect((await handleInvitation(request(), environment({ BUNDY_INVITES_ENABLED: '0' }), transport)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('sends only after server RPC authorization and uses provider idempotency', async () => {
    calls.length = 0;
    const response = await handleInvitation(request(), environment(), transport);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'accepted_for_delivery' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://project.supabase.co/auth/v1/user',
      'https://project.supabase.co/rest/v1/rpc/create_invitation',
      'https://project.supabase.co/rest/v1/organizations?id=eq.' + org + '&select=name',
      'https://api.resend.com/emails',
    ]);
    const rpc = JSON.parse(String(calls[1].init?.body));
    expect(rpc.p_email).toBe(payload.email);
    expect(rpc.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rpc.p_token_hash).not.toBe(code);
    const providerHeaders = calls[3].init?.headers as Record<string,string>;
    expect(providerHeaders['Idempotency-Key']).toBe('bundy-invite-' + org + '-' + requestId);
    const email = JSON.parse(String(calls[3].init?.body));
    expect(email.to).toEqual([payload.email]);
    expect(email.from).toBe('Bundy <hello@bundy.example>');
    expect(email.html).toContain('Empresa &lt;script&gt;&amp;');
    expect(email.text).toContain(org + '.' + code);
    expect(JSON.stringify(await response.clone().json())).not.toContain(code);
  });

  it('rejects non-manager RPC results and never reaches provider', async () => {
    calls.length = 0;
    const refused = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).endsWith('/rest/v1/rpc/create_invitation')) { calls.push({url: String(u), init}); return Response.json({ code: '42501' }, { status: 403 }); }
      return transport(u, init);
    }) as typeof fetch;
    const response = await handleInvitation(request(), environment(), refused);
    expect(response.status).toBe(403);
    expect(calls.some((x) => x.url === 'https://api.resend.com/emails')).toBe(false);
  });

  it('reports unknown delivery without exposing a token or claiming email receipt', async () => {
    const failed = (async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u) === 'https://api.resend.com/emails'
        ? Response.json({ error: 'provider rejected' }, { status: 429 })
        : transport(u, init)) as typeof fetch;
    const response = await handleInvitation(request(), environment(), failed);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'DELIVERY_NOT_CONFIRMED' });
  });
});
