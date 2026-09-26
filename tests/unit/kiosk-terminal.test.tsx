// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpKioskGateway, parseIdentification, type Identification, type KioskChallenge, type KioskGateway } from '../../src/kiosk/gateway';
import { CLEAR_AFTER_MS, KioskTerminal, RECEIPT_MS } from '../../src/kiosk/KioskTerminal';
import { ApiError } from '../../src/lib/errors';
import type { ClockReceipt } from '../../src/domain/types';

// UI behaviour with a stub of the KIO-H6-01 gateway contract. The real
// gateway, database and browser are exercised in kio_h6.py and kiosk.e2e.ts.
const PIN = '48213975';
const R1 = '6f1f2c1e-8d4b-4c3a-9e2f-0a1b2c3d4e5f', R2 = '7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const identity: Identification = {
  state: 'WORKING', version: 3, actions: ['BREAK_START', 'CLOCK_OUT'],
  challenges: { BREAK_START: { action: 'BREAK_START', challenge: 'c'.repeat(64), requestId: R1 },
    CLOCK_OUT: { action: 'CLOCK_OUT', challenge: 'd'.repeat(64), requestId: R2 } },
};
const receipt: ClockReceipt = { event_id: 'ev', session_id: 's', server_at: '2026-09-22T15:00:07.123456+00:00', state: 'OUT', version: 4, sequence: 9, request_id: 'r2' };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class StubGateway implements KioskGateway {
  identifyCalls: [string, string][] = [];
  recordCalls: [number, KioskChallenge][] = [];
  identifyResult: () => Promise<Identification> = () => Promise.resolve(identity);
  recordResults: (() => Promise<ClockReceipt>)[] = [];
  identify(code: string, pin: string) { this.identifyCalls.push([code, pin]); return this.identifyResult(); }
  record(version: number, challenge: KioskChallenge) {
    this.recordCalls.push([version, challenge]);
    return (this.recordResults.shift() ?? (() => Promise.resolve(receipt)))();
  }
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

async function identify(gateway: StubGateway) {
  fireEvent.input(screen.getByLabelText('Código de empleado'), { target: { value: 'A-17' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  const pin = screen.getByLabelText('PIN (8 cifras)') as HTMLInputElement;
  fireEvent.input(pin, { target: { value: PIN } });
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(pin.value).toBe(''); // cleared before the network answers
  await flush();
  expect(gateway.identifyCalls).toEqual([['A-17', PIN]]);
}

let setItem: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  vi.useFakeTimers();
  setItem = vi.spyOn(Storage.prototype, 'setItem');
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
});
afterEach(() => {
  expect(document.body.innerHTML.includes(PIN)).toBe(false);
  cleanup();
  expect(setItem).not.toHaveBeenCalled(); // nothing persisted: no PIN, code or receipt
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('kiosk terminal flow (contract stub)', () => {
  it('uses non-autocompleting, masked inputs and never lists employees', () => {
    render(<KioskTerminal gateway={new StubGateway()} online />);
    const code = screen.getByLabelText('Código de empleado');
    expect(code.getAttribute('autocomplete')).toBe('off');
    expect(code.getAttribute('spellcheck')).toBe('false');
    expect(document.querySelectorAll('select, datalist, option, li')).toHaveLength(0);
    fireEvent.input(code, { target: { value: 'A-17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    const pin = screen.getByLabelText('PIN (8 cifras)');
    expect(pin.getAttribute('type')).toBe('password');
    expect(pin.getAttribute('autocomplete')).toBe('off');
    expect(pin.getAttribute('inputmode')).toBe('numeric');
  });

  it('offers only permitted actions and confirms only after the ACK; clears within 15 s', async () => {
    const gateway = new StubGateway();
    const ack = deferred<ClockReceipt>();
    gateway.recordResults = [() => ack.promise];
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    expect(screen.getByRole('heading', { name: 'Estado: Trabajando' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Entrada' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finalizar pausa' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Salida' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enviando…' })); // double tap ignored
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' })); // outcome cannot be hidden
    expect(gateway.recordCalls).toHaveLength(1);
    expect(gateway.recordCalls[0]).toEqual([3, identity.challenges.CLOCK_OUT]);
    expect(screen.queryByText('Salida registrada')).toBeNull();
    await act(async () => { ack.resolve(receipt); await ack.promise; });
    expect(screen.getByRole('heading', { name: 'Salida registrada' })).toBeTruthy();
    expect(screen.getByText(/Hora del servidor/).textContent).toMatch(/\d{2}:\d{2}:07/);
    act(() => { vi.advanceTimersByTime(RECEIPT_MS); });
    expect(screen.queryByText('Salida registrada')).toBeNull();
    expect(screen.getByLabelText('Código de empleado')).toBeTruthy();
    expect(RECEIPT_MS).toBeLessThan(15_000);
    expect(CLEAR_AFTER_MS).toBeLessThan(15_000);
  });

  it('shows an unknown result on a lost ACK and retries the same tuple', async () => {
    const gateway = new StubGateway();
    gateway.recordResults = [() => Promise.reject(new ApiError('network', 'NETWORK')), () => Promise.resolve(receipt)];
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    fireEvent.click(screen.getByRole('button', { name: 'Salida' }));
    await flush();
    expect(screen.getByRole('heading', { name: 'Resultado desconocido' })).toBeTruthy();
    expect(screen.queryByText('Salida registrada')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar' }));
    await flush();
    expect(gateway.recordCalls[1]).toEqual(gateway.recordCalls[0]);
    expect(screen.getByRole('heading', { name: 'Salida registrada' })).toBeTruthy();
  });

  it('never claims "not recorded" when a retry after an unknown outcome is refused', async () => {
    const gateway = new StubGateway();
    gateway.recordResults = [() => Promise.reject(new ApiError('timeout', 'TIMEOUT')), () => Promise.reject(new ApiError('forbidden', 'AUTH_FAILED', 403))];
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    fireEvent.click(screen.getByRole('button', { name: 'Salida' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/No se ha podido confirmar/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/No se ha registrado/);
    expect(screen.getByLabelText('Código de empleado')).toBeTruthy();
  });

  it('reports a refused first attempt as not recorded and returns to identification', async () => {
    const gateway = new StubGateway();
    gateway.recordResults = [() => Promise.reject(new ApiError('forbidden', 'AUTH_FAILED', 403))];
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar pausa' }));
    await flush();
    expect(gateway.recordCalls[0]).toEqual([3, identity.challenges.BREAK_START]);
    expect(screen.getByRole('alert').textContent).toMatch(/No se ha registrado el fichaje/);
    expect(screen.queryByText('Estado: Trabajando')).toBeNull();
  });

  it('shows only the actions the server offered', async () => {
    const gateway = new StubGateway();
    gateway.identifyResult = () => Promise.resolve({ state: 'OUT', version: 0, actions: ['CLOCK_IN'],
      challenges: { CLOCK_IN: { action: 'CLOCK_IN', challenge: 'e'.repeat(64), requestId: R1 } } });
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    expect(screen.getByRole('heading', { name: 'Estado: Fuera de jornada' })).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Entrada', 'Cancelar']);
  });

  it('answers identification failures generically and clears after inactivity', async () => {
    const gateway = new StubGateway();
    gateway.identifyResult = () => Promise.reject(new ApiError('forbidden', 'FORBIDDEN'));
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    expect(screen.getByRole('alert').textContent).toBe('No se ha podido identificar. Comprueba el código y el PIN o avisa a tu empresa.');
    act(() => { vi.advanceTimersByTime(CLEAR_AFTER_MS); });
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('drops the identified state and challenges before 15 s without interaction', async () => {
    const gateway = new StubGateway();
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    act(() => { vi.advanceTimersByTime(CLEAR_AFTER_MS - 1); });
    expect(screen.getByRole('heading', { name: 'Estado: Trabajando' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Estado: Trabajando')).toBeNull();
    expect(gateway.recordCalls).toHaveLength(0);
  });

  it('refuses to send anything offline', async () => {
    const gateway = new StubGateway();
    render(<KioskTerminal gateway={gateway} online={false} />);
    fireEvent.input(screen.getByLabelText('Código de empleado'), { target: { value: 'A-17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.input(screen.getByLabelText('PIN (8 cifras)'), { target: { value: PIN } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await flush();
    expect(gateway.identifyCalls).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/Sin conexión/);
  });
});

describe('KIO-H6-01 gateway adapter', () => {
  const valid = { state: 'WORKING', version: 7, actions: ['BREAK_START', 'CLOCK_OUT'], challenges: [
    { action: 'BREAK_START', challenge: 'a'.repeat(64), request_id: R1 }, { action: 'CLOCK_OUT', challenge: 'b'.repeat(64), request_id: R2 }] };

  it('parses state, version, legal actions and one challenge per action', () => {
    expect(parseIdentification(valid)).toEqual({ state: 'WORKING', version: 7, actions: ['BREAK_START', 'CLOCK_OUT'], challenges: {
      BREAK_START: { action: 'BREAK_START', challenge: 'a'.repeat(64), requestId: R1 },
      CLOCK_OUT: { action: 'CLOCK_OUT', challenge: 'b'.repeat(64), requestId: R2 } } });
  });

  it.each([
    ['unknown state', { ...valid, state: 'AWAY' }], ['negative version', { ...valid, version: -1 }], ['fractional version', { ...valid, version: 1.5 }],
    ['no actions', { ...valid, actions: [], challenges: [] }], ['action without challenge', { ...valid, actions: ['BREAK_START', 'BREAK_END'] }],
    ['duplicate challenge', { ...valid, challenges: [valid.challenges[0], valid.challenges[0]] }],
    ['malformed secret', { ...valid, challenges: [{ ...valid.challenges[0], challenge: 'x' }, valid.challenges[1]] }],
    ['malformed request', { ...valid, challenges: [{ ...valid.challenges[0], request_id: 'r1' }, valid.challenges[1]] }],
    ['unknown action', { ...valid, actions: ['BREAK_START', 'NAP'], challenges: [valid.challenges[0], { ...valid.challenges[1], action: 'NAP' }] }],
    ['not an object', null],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseIdentification(raw)).toThrow('INVALID_RESPONSE');
  });

  it('sends only code+PIN to authenticate and the bound tuple to record', async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const replies = [valid, { event_id: 'ev', session_id: 's', server_at: '2026-09-22T15:00:07Z', state: 'PAUSED', version: 8, sequence: 3, request_id: R1 }];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url); bodies.push(JSON.parse(String(init.body)));
      expect(init.cache).toBe('no-store');
      expect(init.credentials).toBe('omit');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer device-jwt');
      return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const gateway = new HttpKioskGateway('/gateway/kiosk', { organizationId: 'org', deviceId: 'dev' }, async () => 'device-jwt');
    const result = await gateway.identify('A-17', PIN);
    await gateway.record(result.version, result.challenges.BREAK_START!);
    expect(urls).toEqual(['/gateway/kiosk/authenticate', '/gateway/kiosk/record']);
    expect(bodies[0]).toEqual({ organization_id: 'org', device_id: 'dev', code: 'A-17', pin: PIN });
    expect(bodies[1]).toEqual({ organization_id: 'org', device_id: 'dev', request_id: R1, challenge: 'a'.repeat(64), action: 'BREAK_START', expected_version: 7 });
    expect(JSON.stringify(bodies[1])).not.toContain(PIN);
    vi.unstubAllGlobals();
  });
});
