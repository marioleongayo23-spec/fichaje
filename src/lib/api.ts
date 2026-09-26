import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, asApiError, toApiError } from './errors';
import { isMutation, operationFor, recordRequest, type ClientOperation } from './telemetry';

export const TIMEOUT_MS = 15000;

interface Result { data: unknown; error: unknown; status: number }
interface Abortable { abortSignal(signal: AbortSignal): PromiseLike<Result> }

// OPS-02: every call is measured into aggregated, identity-free telemetry.
async function measure<T>(operation: ClientOperation, mutation: boolean, call: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const value = await call();
    recordRequest(operation, null, mutation, performance.now() - started);
    return value;
  } catch (error) {
    recordRequest(operation, asApiError(error), mutation, performance.now() - started);
    throw error;
  }
}

// Mutations are never retried automatically: a retry is an explicit user action
// that reuses the same request_id so the server returns the same receipt.
export async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  return measure(operationFor(name, args), isMutation(name), async () => {
    let result: Result;
    try {
      result = await client.rpc(name, args).retry(false).abortSignal(AbortSignal.timeout(timeoutMs));
    } catch (error) {
      throw asApiError(error);
    }
    if (result.error) throw toApiError(result.status, result.error);
    return result.data as T;
  });
}

export async function select<T>(query: Abortable, timeoutMs = TIMEOUT_MS): Promise<T[]> {
  return measure('select', false, async () => {
    let result: Result;
    try {
      result = await query.abortSignal(AbortSignal.timeout(timeoutMs));
    } catch (error) {
      throw asApiError(error);
    }
    if (result.error) throw toApiError(result.status, result.error);
    return (result.data ?? []) as T[];
  });
}

// Server-only functions (kiosk gateway, export signer). Never cached, no cookies,
// no referrer. A 2xx without a readable body is an unknown outcome, not success.
export async function postJson<T>(url: string, token: string, body: Record<string, unknown>,
  operation: ClientOperation = 'rpc.other', mutation = true, timeoutMs = TIMEOUT_MS): Promise<T> {
  return measure(operation, mutation, () => post<T>(url, token, body, timeoutMs));
}

async function post<T>(url: string, token: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw asApiError(error);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new ApiError('network', 'NETWORK', response.status);
  }
  if (!response.ok) throw toApiError(response.status, payload);
  return payload as T;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
