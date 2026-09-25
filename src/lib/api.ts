import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, asApiError, toApiError } from './errors';

export const TIMEOUT_MS = 15000;

interface Result { data: unknown; error: unknown; status: number }
interface Abortable { abortSignal(signal: AbortSignal): PromiseLike<Result> }

// Mutations are never retried automatically: a retry is an explicit user action
// that reuses the same request_id so the server returns the same receipt.
export async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  let result: Result;
  try {
    result = await client.rpc(name, args).retry(false).abortSignal(AbortSignal.timeout(timeoutMs));
  } catch (error) {
    throw asApiError(error);
  }
  if (result.error) throw toApiError(result.status, result.error);
  return result.data as T;
}

export async function select<T>(query: Abortable, timeoutMs = TIMEOUT_MS): Promise<T[]> {
  let result: Result;
  try {
    result = await query.abortSignal(AbortSignal.timeout(timeoutMs));
  } catch (error) {
    throw asApiError(error);
  }
  if (result.error) throw toApiError(result.status, result.error);
  return (result.data ?? []) as T[];
}

// Server-only functions (kiosk gateway, export signer). Never cached, no cookies,
// no referrer. A 2xx without a readable body is an unknown outcome, not success.
export async function postJson<T>(url: string, token: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
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
