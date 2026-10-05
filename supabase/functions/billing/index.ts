// Stripe billing adapter for Fichaje APP.
//
// Safe-by-default contract:
// - FICHAJE_BILLING_ENABLED must be exactly "1".
// - user routes are same-origin edge signed and revalidate the Supabase session;
// - Stripe webhook is the only direct public route and verifies Stripe-Signature
//   against the raw body before any database write;
// - Stripe secrets never reach the browser or logs;
// - no labour transaction performs external I/O.
import Stripe from 'stripe';
import { INGRESS_HEADER, ingressPolicy, readBounded, routeOf, verifyIngress } from '../_shared/ingress.ts';

const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error('CONFIG_REQUIRED');
  return value;
};
const endpoint = required('SUPABASE_URL');
const anonKey = required('SUPABASE_ANON_KEY');
const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');

const listenPort = Deno.env.get('BILLING_PORT');
const ingress = ingressPolicy(k => Deno.env.get(k), !listenPort);
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, max-age=0',
  'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const stripeId = (prefix: string, value: unknown): value is string =>
  typeof value === 'string' && new RegExp('^' + prefix + '[A-Za-z0-9]+$').test(value);

interface BillingConfig {
  stripe: any;
  webhookSecret: string;
  basePrice: string;
  employeePrice: string;
  appOrigin: string;
  proration: 'none' | 'create_prorations';
}
let cached: BillingConfig | null | undefined;

function config(): BillingConfig | null {
  if (Deno.env.get('FICHAJE_BILLING_ENABLED') !== '1') return null;
  if (cached !== undefined) return cached;
  try {
    const secret = required('STRIPE_SECRET_KEY');
    const webhookSecret = required('STRIPE_WEBHOOK_SECRET');
    const basePrice = required('STRIPE_PRICE_BASE_MONTHLY');
    const employeePrice = required('STRIPE_PRICE_EMPLOYEES_MONTHLY');
    if (!stripeId('price_', basePrice) || !stripeId('price_', employeePrice)) throw new Error('CONFIG_REQUIRED');
    const rawOrigin = required('FICHAJE_APP_ORIGIN');
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== rawOrigin.replace(/\/$/, '') || parsed.username || parsed.password) {
      throw new Error('CONFIG_REQUIRED');
    }
    const prorationRaw = Deno.env.get('FICHAJE_BILLING_PRORATION') ?? 'none';
    if (prorationRaw !== 'none' && prorationRaw !== 'create_prorations') throw new Error('CONFIG_REQUIRED');
    cached = {
      stripe: new Stripe(secret) as any,
      webhookSecret,
      basePrice,
      employeePrice,
      appOrigin: parsed.origin,
      proration: prorationRaw,
    };
  } catch {
    cached = null;
  }
  return cached;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
const unavailable = () => json(503, { error: 'BILLING_UNAVAILABLE' });
const denied = () => json(403, { error: 'FORBIDDEN' });

async function signedByEdge(request: Request, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return !ingress.required || await verifyIngress(
    ingress.secrets, request.headers.get(INGRESS_HEADER), request.method, 'billing',
    routeOf('billing', request.method, new URL(request.url).pathname), body, Date.now() / 1000,
  );
}

async function rpc(name: string, body: Record<string, unknown>, authorization: string): Promise<Response> {
  return await fetch(endpoint + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      apikey: authorization === serviceKey ? serviceKey : anonKey,
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function validUser(authorization: string): Promise<boolean> {
  if (!authorization.startsWith('Bearer ')) return false;
  const response = await fetch(endpoint + '/auth/v1/user', {
    headers: { apikey: anonKey, Authorization: authorization },
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  return response.ok;
}

async function authorizeHuman(authorization: string, organizationId: string, mode: 'owner' | 'manager'): Promise<boolean> {
  if (!await validUser(authorization)) return false;
  const name = mode === 'owner' ? 'get_billing_summary' : 'authorize_billing_sync';
  const response = await rpc(name, { p_organization_id: organizationId }, authorization);
  await response.body?.cancel();
  return response.ok;
}

async function serviceRpc(name: string, body: Record<string, unknown>): Promise<any> {
  const response = await rpc(name, body, 'Bearer ' + serviceKey);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.message === 'string' ? payload.message : 'RPC_FAILED');
  return payload;
}

interface ActionFields { organizationId: string; requestId: string; authorization: string }

async function actionFields(request: Request): Promise<ActionFields | null> {
  if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length') || 0) > 1024) return null;
  const authorization = request.headers.get('authorization') || '';
  const body = await readBounded(request, 1024);
  if (!body || !await signedByEdge(request, body)) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'organization_id,request_id' || !uuid(p.organization_id) || !uuid(p.request_id)) return null;
  return { organizationId: p.organization_id, requestId: p.request_id, authorization };
}

async function serverContext(organizationId: string): Promise<any> {
  return await serviceRpc('billing_server_context', { p_organization_id: organizationId });
}

function id(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
  return null;
}

async function ensureCustomer(cfg: BillingConfig, organizationId: string, context: any): Promise<string> {
  if (stripeId('cus_', context?.stripe_customer_id)) return context.stripe_customer_id;
  const customer = await cfg.stripe.customers.create(
    { metadata: { organization_id: organizationId } },
    { idempotencyKey: 'fichaje.customer.' + organizationId },
  );
  if (!stripeId('cus_', customer?.id)) throw new Error('STRIPE_INVALID_CUSTOMER');
  await serviceRpc('billing_attach_customer', {
    p_organization_id: organizationId,
    p_stripe_customer_id: customer.id,
  });
  return customer.id;
}

async function checkout(request: Request, cfg: BillingConfig): Promise<Response> {
  const fields = await actionFields(request);
  if (!fields || !await authorizeHuman(fields.authorization, fields.organizationId, 'owner')) return denied();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claim = await serviceRpc('billing_begin_checkout', {
      p_organization_id: fields.organizationId,
      p_request_id: fields.requestId,
    });
    const effectiveRequest = claim?.request_id;
    const generation = Number(claim?.generation);
    if (!uuid(effectiveRequest) || !Number.isSafeInteger(generation) || generation < 1) return unavailable();

    let context = await serverContext(fields.organizationId);
    const customer = await ensureCustomer(cfg, fields.organizationId, context);
    context = await serverContext(fields.organizationId);

    if (stripeId('cs_', claim?.session_id)) {
      const prior = await cfg.stripe.checkout.sessions.retrieve(claim.session_id);
      if (prior?.status === 'open' && typeof prior?.url === 'string') return json(200, { url: prior.url });
      if (prior?.status === 'complete') return json(409, { error: 'CHECKOUT_ALREADY_COMPLETED' });
      if (prior?.status === 'expired') {
        const reset = await serviceRpc('billing_reset_expired_checkout', {
          p_organization_id: fields.organizationId,
          p_request_id: effectiveRequest,
          p_generation: generation,
          p_session_id: claim.session_id,
        });
        if (reset?.reset === true) continue;
      }
      return json(409, { error: 'CHECKOUT_IN_PROGRESS' });
    }

    const activeEmployees = Number(context?.active_employees);
    if (!Number.isSafeInteger(activeEmployees) || activeEmployees < 0) return unavailable();
    const session = await cfg.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: fields.organizationId,
      line_items: [
        { price: cfg.basePrice, quantity: 1 },
        { price: cfg.employeePrice, quantity: Math.max(1, activeEmployees) },
      ],
      success_url: cfg.appOrigin + '/gestion/facturacion?checkout=success',
      cancel_url: cfg.appOrigin + '/gestion/facturacion?checkout=cancel',
      metadata: { organization_id: fields.organizationId },
      subscription_data: { metadata: { organization_id: fields.organizationId } },
    }, { idempotencyKey: 'fichaje.checkout.' + fields.organizationId + '.' + generation });

    if (!stripeId('cs_', session?.id) || typeof session?.url !== 'string' || !Number.isInteger(session?.expires_at)) {
      return unavailable();
    }
    await serviceRpc('billing_finish_checkout', {
      p_organization_id: fields.organizationId,
      p_request_id: effectiveRequest,
      p_generation: generation,
      p_session_id: session.id,
      p_expires_at: new Date(session.expires_at * 1000).toISOString(),
    });
    return json(200, { url: session.url });
  }
  return unavailable();
}

async function portal(request: Request, cfg: BillingConfig): Promise<Response> {
  const fields = await actionFields(request);
  if (!fields || !await authorizeHuman(fields.authorization, fields.organizationId, 'owner')) return denied();
  const context = await serverContext(fields.organizationId);
  if (!stripeId('cus_', context?.stripe_customer_id)) return json(409, { error: 'BILLING_NOT_CONFIGURED' });
  const session = await cfg.stripe.billingPortal.sessions.create({
    customer: context.stripe_customer_id,
    return_url: cfg.appOrigin + '/gestion/facturacion',
  }, { idempotencyKey: 'fichaje.portal.' + fields.organizationId + '.' + fields.requestId });
  if (typeof session?.url !== 'string') return unavailable();
  return json(200, { url: session.url });
}

async function syncSeats(request: Request, cfg: BillingConfig): Promise<Response> {
  const fields = await actionFields(request);
  if (!fields || !await authorizeHuman(fields.authorization, fields.organizationId, 'manager')) return denied();
  const context = await serverContext(fields.organizationId);
  const revision = context?.seat_revision == null ? null : Number(context.seat_revision);
  if (revision == null) return json(200, { status: 'IN_SYNC' });
  if (!Number.isSafeInteger(revision) || revision < 1) return unavailable();
  if (!stripeId('sub_', context?.stripe_subscription_id) || !stripeId('si_', context?.stripe_employee_item_id)) {
    return json(200, { status: 'NO_SUBSCRIPTION' });
  }
  const desired = Number(context?.desired_seat_quantity);
  if (!Number.isSafeInteger(desired) || desired < 0) return unavailable();
  const stripeQuantity = Math.max(1, desired);
  await cfg.stripe.subscriptionItems.update(context.stripe_employee_item_id, {
    quantity: stripeQuantity,
    proration_behavior: cfg.proration,
  }, { idempotencyKey: 'fichaje.seats.' + fields.organizationId + '.' + revision });
  const ack = await serviceRpc('billing_ack_seat_sync', {
    p_organization_id: fields.organizationId,
    p_revision: revision,
    p_quantity: stripeQuantity,
  });
  return json(200, { status: ack?.pending ? 'PENDING' : 'IN_SYNC' });
}

function subscriptionFromEvent(event: any): string | null {
  const object = event?.data?.object;
  if (!object) return null;
  if (typeof event.type === 'string' && event.type.startsWith('customer.subscription.')) return id(object.id);
  if (event.type === 'checkout.session.completed') return id(object.subscription);
  if (typeof event.type === 'string' && event.type.startsWith('invoice.')) {
    return id(object.subscription) || id(object.parent?.subscription_details?.subscription);
  }
  return null;
}

const EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

async function webhook(request: Request, cfg: BillingConfig): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
  if (Number(request.headers.get('content-length') || 0) > 65536) return json(413, { error: 'PAYLOAD_TOO_LARGE' });
  const bytes = await readBounded(request, 65536);
  if (!bytes) return json(413, { error: 'PAYLOAD_TOO_LARGE' });
  const signature = request.headers.get('stripe-signature') || '';
  let event: any;
  try {
    const cryptoProvider = Stripe.createSubtleCryptoProvider();
    event = await cfg.stripe.webhooks.constructEventAsync(
      new TextDecoder().decode(bytes), signature, cfg.webhookSecret, undefined, cryptoProvider,
    );
  } catch {
    return json(400, { error: 'INVALID_SIGNATURE' });
  }
  if (!EVENTS.has(event?.type)) return json(200, { received: true, ignored: true });

  const subscriptionId = subscriptionFromEvent(event);
  if (!stripeId('sub_', subscriptionId)) return json(500, { error: 'SUBSCRIPTION_UNRESOLVED' });
  const subscription = await cfg.stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
  const organizationId = subscription?.metadata?.organization_id;
  const customerId = id(subscription?.customer);
  if (!uuid(organizationId) || !stripeId('cus_', customerId)) return json(500, { error: 'SUBSCRIPTION_UNRESOLVED' });

  const employeeItem = subscription?.items?.data?.find((item: any) => id(item?.price) === cfg.employeePrice);
  if (!stripeId('si_', employeeItem?.id)) return json(500, { error: 'CATALOG_MISMATCH' });
  const quantity = Number(employeeItem?.quantity ?? 0);
  const periodEnd = Number(employeeItem?.current_period_end);
  const status = typeof subscription?.status === 'string' ? subscription.status.toUpperCase() : '';
  if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(periodEnd) || periodEnd <= 0 ||
      !['INCOMPLETE','INCOMPLETE_EXPIRED','TRIALING','ACTIVE','PAST_DUE','PAUSED','UNPAID','CANCELED'].includes(status)) {
    return json(500, { error: 'SUBSCRIPTION_INVALID' });
  }

  await serviceRpc('billing_record_subscription_snapshot', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_event_created: event.created,
    p_organization_id: organizationId,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: subscription.id,
    p_stripe_employee_item_id: employeeItem.id,
    p_status: status,
    p_seat_quantity: quantity,
    p_cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    p_current_period_end: new Date(periodEnd * 1000).toISOString(),
  });
  return json(200, { received: true });
}

async function health(request: Request, cfg: BillingConfig | null): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/\/health\/(live|ready)\/?$/.test(url.pathname)) return null;
  if (!await signedByEdge(request, new Uint8Array(0))) return denied();
  if (/\/health\/live\/?$/.test(url.pathname)) return json(200, { status: 'UP' });
  if (!cfg) return json(503, { status: 'DOWN', reason: 'BILLING_DISABLED' });
  try {
    const response = await fetch(endpoint + '/auth/v1/health', { headers: { apikey: anonKey }, signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.ok ? json(200, { status: 'UP' }) : json(503, { status: 'DOWN' });
  } catch {
    return json(503, { status: 'DOWN' });
  }
}

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cfg = config();

  if (/\/webhook\/?$/.test(url.pathname)) {
    if (!cfg) return unavailable();
    return await webhook(request, cfg);
  }

  if (request.method === 'GET') {
    const probe = await health(request, cfg);
    if (probe) return probe;
  }
  if (!cfg) return unavailable();
  if (/\/checkout\/?$/.test(url.pathname)) return await checkout(request, cfg);
  if (/\/portal\/?$/.test(url.pathname)) return await portal(request, cfg);
  if (/\/sync\/?$/.test(url.pathname)) return await syncSeats(request, cfg);
  return json(404, { error: 'NOT_FOUND' });
}

if (import.meta.main) {
  if (listenPort) Deno.serve({ hostname: '127.0.0.1', port: Number(listenPort), onListen: () => {} }, handler);
  else Deno.serve(handler);
}
