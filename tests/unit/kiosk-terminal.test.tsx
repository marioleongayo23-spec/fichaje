// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { H4KioskGateway, IDENTIFICATION_UNAVAILABLE, type Identification, type KioskChallenge, type KioskGateway } from '../../src/kiosk/gateway';
import { CLEAR_AFTER_MS, KioskTerminal, RECEIPT_MS } from '../../src/kiosk/KioskTerminal';
import { ApiError } from '../../src/lib/errors';
import type { ClockReceipt, TimeAction } from '../../src/domain/types';

// The terminal flow is exercised with a contract stub of the identification
// step that H4 lacks (documented blocker). This proves UI behaviour only; it is
// NOT evidence against the real backend.
const PIN = '48213975';
const identity: Identification = {
  employeeId: 'e1', state: 'WORKING', version: 3, expiresIn: 60,
  challenges: { BREAK_START: { challenge: 'c'.repeat(64), requestId: 'r1' }, CLOCK_OUT: { challenge: 'd'.repeat(64), requestId: 'r2' } },
};
const receipt: ClockReceipt = { event_id: 'ev', session_id: 's', server_at: '2026-09-22T15:00:07.123456+00:00', state: 'OUT', version: 4, sequence: 9, request_id: 'r2' };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class StubGateway implements KioskGateway {
  readonly supportsIdentification = true;
  identifyCalls: [string, string][] = [];
  recordCalls: [string, TimeAction, number, KioskChallenge][] = [];
  identifyResult: () => Promise<Identification> = () => Promise.resolve(identity);
  recordResults: (() => Promise<ClockReceipt>)[] = [];
  identify(code: string, pin: string) { this.identifyCalls.push([code, pin]); return this.identifyResult(); }
  record(employee: string, action: TimeAction, version: number, challenge: KioskChallenge) {
    this.recordCalls.push([employee, action, version, challenge]);
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
    expect(gateway.recordCalls[0]).toEqual(['e1', 'CLOCK_OUT', 3, identity.challenges.CLOCK_OUT]);
    expect(screen.queryByText('Salida registrada')).toBeNull();
    await act(async () => { ack.resolve(receipt); await ack.promise; });
    expect(screen.getByRole('heading', { name: 'Salida registrada' })).toBeTruthy();
    expect(screen.getByText(/Hora del servidor/).textContent).toMatch(/\d{2}:\d{2}:07/);
    act(() => { vi.advanceTimersByTime(RECEIPT_MS); });
    expect(screen.queryByText('Salida registrada')).toBeNull();
    expect(screen.getByLabelText('Código de empleado')).toBeTruthy();
    expect(RECEIPT_MS).toBeLessThanOrEqual(15_000);
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

  it('answers identification failures generically and clears after inactivity', async () => {
    const gateway = new StubGateway();
    gateway.identifyResult = () => Promise.reject(new ApiError('forbidden', 'FORBIDDEN'));
    render(<KioskTerminal gateway={gateway} online />);
    await identify(gateway);
    expect(screen.getByRole('alert').textContent).toBe('No se ha podido identificar. Comprueba el código y el PIN o avisa a tu empresa.');
    act(() => { vi.advanceTimersByTime(CLEAR_AFTER_MS); });
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('drops the identified state and challenges after 15 s without interaction', async () => {
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

describe('H4 gateway adapter', () => {
  it('declares that the approved H4 contract cannot identify an employee state', async () => {
    const gateway = new H4KioskGateway('/gateway/kiosk', { organizationId: 'o', deviceId: 'd' }, async () => 'token');
    expect(gateway.supportsIdentification).toBe(false);
    await expect(gateway.identify()).rejects.toMatchObject({ code: IDENTIFICATION_UNAVAILABLE });
  });
});
