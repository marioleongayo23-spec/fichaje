import type { ClockReceipt, ClockState, TimeAction } from '../domain/types';
import { postJson } from '../lib/api';
import { ApiError } from '../lib/errors';

export interface KioskIdentity { organizationId: string; deviceId: string }
export interface KioskChallenge { challenge: string; requestId: string }
export interface Identification {
  employeeId: string; state: ClockState; version: number;
  challenges: Partial<Record<TimeAction, KioskChallenge>>; expiresIn: number;
}

// The terminal needs, after verifying code+PIN, the employee's state and a
// challenge per permitted action. The approved H4 contract binds the challenge
// to an action and expected_version chosen BEFORE verification and offers no
// way to learn them, so `identify` is unavailable until H4 is extended.
export interface KioskGateway {
  readonly supportsIdentification: boolean;
  identify(code: string, pin: string): Promise<Identification>;
  record(employeeId: string, action: TimeAction, expectedVersion: number, challenge: KioskChallenge): Promise<ClockReceipt>;
}

export const IDENTIFICATION_UNAVAILABLE = 'KIOSK_IDENTIFICATION_UNAVAILABLE';

// Client of the existing H4 gateway routes. Requests carry the device JWT only;
// PIN and challenge travel in the body, are never logged or stored.
export class H4KioskGateway implements KioskGateway {
  readonly supportsIdentification = false;

  constructor(private readonly baseUrl: string, private readonly identity: KioskIdentity, private readonly token: () => Promise<string | null>) {}

  identify(): Promise<Identification> {
    return Promise.reject(new ApiError('server', IDENTIFICATION_UNAVAILABLE));
  }

  // Existing H4 route: challenge bound to tenant, device, employee, action,
  // expected_version and request_id. Failures are generic by design.
  async authenticate(code: string, pin: string, action: TimeAction, expectedVersion: number, requestId: string) {
    return this.post<{ challenge: string; employee_id: string; request_id: string; expires_in: number }>('authenticate', {
      device_id: this.identity.deviceId, request_id: requestId, code, pin, action, expected_version: expectedVersion,
    });
  }

  // Receipt only after COMMIT. Retrying the same tuple recovers the same receipt.
  record(employeeId: string, action: TimeAction, expectedVersion: number, challenge: KioskChallenge): Promise<ClockReceipt> {
    return this.post<ClockReceipt>('record', {
      device_id: this.identity.deviceId, request_id: challenge.requestId, employee_id: employeeId,
      challenge: challenge.challenge, action, expected_version: expectedVersion,
    });
  }

  private async post<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.token();
    if (!token) throw new ApiError('unauthenticated', 'UNAUTHENTICATED');
    return postJson<T>(`${this.baseUrl}/${route}`, token, { organization_id: this.identity.organizationId, ...body });
  }
}
