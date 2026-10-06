import type { AppConfig } from '../config';
import { newRequestId, postJson } from '../lib/api';

export type BillingStatus =
  | 'NOT_CONFIGURED' | 'CHECKOUT_PENDING' | 'INCOMPLETE' | 'INCOMPLETE_EXPIRED'
  | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'UNPAID' | 'CANCELED';

export interface BillingSummary {
  status: BillingStatus;
  active_employees: number;
  stripe_seat_quantity: number;
  seat_sync_pending: boolean;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
}

interface UrlResponse { url: string }
export interface SyncResponse { status: 'IN_SYNC' | 'PENDING' | 'NO_SUBSCRIPTION' }

function endpoint(config: AppConfig, action: 'checkout' | 'portal' | 'sync'): string {
  return config.billingGatewayUrl + '/' + action;
}

export function monthlyCents(employees: number): number {
  if (!Number.isSafeInteger(employees) || employees < 0) throw new Error('INVALID_EMPLOYEE_QUANTITY');
  let remaining = employees;
  let cents = 1299;
  for (const [width, amount] of [[5, 0], [15, 199], [80, 149], [Number.POSITIVE_INFINITY, 129]] as const) {
    const units = Math.min(remaining, width);
    cents += units * amount;
    remaining -= units;
    if (remaining <= 0) break;
  }
  return cents;
}

export function stripeHostedUrl(value: unknown, kind: 'checkout' | 'portal'): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function beginCheckout(config: AppConfig, token: string, organizationId: string): Promise<string> {
  const result = await postJson<UrlResponse>(endpoint(config, 'checkout'), token, {
    organization_id: organizationId,
    request_id: newRequestId(),
  });
  const url = stripeHostedUrl(result.url, 'checkout');
  if (!url) throw new Error('INVALID_STRIPE_URL');
  return url;
}

export async function openPortal(config: AppConfig, token: string, organizationId: string): Promise<string> {
  const result = await postJson<UrlResponse>(endpoint(config, 'portal'), token, {
    organization_id: organizationId,
    request_id: newRequestId(),
  });
  const url = stripeHostedUrl(result.url, 'portal');
  if (!url) throw new Error('INVALID_STRIPE_URL');
  return url;
}

export async function syncSeats(config: AppConfig, token: string, organizationId: string): Promise<SyncResponse> {
  return postJson<SyncResponse>(endpoint(config, 'sync'), token, {
    organization_id: organizationId,
    request_id: newRequestId(),
  });
}
