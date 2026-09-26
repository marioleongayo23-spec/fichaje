import type { ClockReceipt, ClockState, TimeAction } from '../domain/types';
import { postJson } from '../lib/api';
import { ApiError } from '../lib/errors';

export interface KioskIdentity { organizationId: string; deviceId: string }
export interface KioskChallenge { action: TimeAction; challenge: string; requestId: string }
// KIO-H6-01: after code+PIN the gateway answers the authoritative state and
// version, the legal actions and one bound challenge per action. It never
// discloses who the employee is; the challenge identifies them server-side.
export interface Identification {
  state: ClockState; version: number; actions: TimeAction[];
  challenges: Partial<Record<TimeAction, KioskChallenge>>;
}

export interface KioskGateway {
  identify(code: string, pin: string): Promise<Identification>;
  record(expectedVersion: number, challenge: KioskChallenge): Promise<ClockReceipt>;
}

const STATES: readonly ClockState[] = ['OUT', 'WORKING', 'PAUSED'];
const ACTIONS: readonly TimeAction[] = ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new ApiError('server', 'INVALID_RESPONSE');

// Strict shape check: anything unexpected is treated as a failed identification,
// never as permission to show actions.
export function parseIdentification(raw: unknown): Identification {
  if (!raw || typeof raw !== 'object') throw invalid();
  const { state, version, actions, challenges } = raw as Record<string, unknown>;
  if (!STATES.includes(state as ClockState) || !Number.isSafeInteger(version) || (version as number) < 0) throw invalid();
  if (!Array.isArray(actions) || !Array.isArray(challenges) || actions.length !== challenges.length || actions.length === 0) throw invalid();
  const byAction: Partial<Record<TimeAction, KioskChallenge>> = {};
  for (const item of challenges as unknown[]) {
    if (!item || typeof item !== 'object') throw invalid();
    const { action, challenge, request_id: requestId } = item as Record<string, unknown>;
    if (!ACTIONS.includes(action as TimeAction) || byAction[action as TimeAction] || typeof challenge !== 'string'
      || !/^[0-9a-f]{64}$/.test(challenge) || typeof requestId !== 'string' || !UUID.test(requestId)) throw invalid();
    byAction[action as TimeAction] = { action: action as TimeAction, challenge, requestId };
  }
  if (!(actions as unknown[]).every((a) => byAction[a as TimeAction])) throw invalid();
  return { state: state as ClockState, version: version as number, actions: actions as TimeAction[], challenges: byAction };
}

// Client of the kiosk gateway. Requests carry the device JWT only; code, PIN
// and challenge travel in the body and are never logged, stored or put in URLs.
export class HttpKioskGateway implements KioskGateway {
  constructor(private readonly baseUrl: string, private readonly identity: KioskIdentity, private readonly token: () => Promise<string | null>) {}

  async identify(code: string, pin: string): Promise<Identification> {
    return parseIdentification(await this.post<unknown>('authenticate', { device_id: this.identity.deviceId, code, pin }));
  }

  // Receipt only after COMMIT. Retrying the same tuple recovers the same receipt;
  // a challenge is bound to its action, version and request on the server.
  record(expectedVersion: number, challenge: KioskChallenge): Promise<ClockReceipt> {
    return this.post<ClockReceipt>('record', {
      device_id: this.identity.deviceId, request_id: challenge.requestId, challenge: challenge.challenge,
      action: challenge.action, expected_version: expectedVersion,
    });
  }

  private async post<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.token();
    if (!token) throw new ApiError('unauthenticated', 'UNAUTHENTICATED');
    return postJson<T>(`${this.baseUrl}/${route}`, token, { organization_id: this.identity.organizationId, ...body });
  }
}
