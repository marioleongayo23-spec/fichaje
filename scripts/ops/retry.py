"""RES-01: automation retries only operations declared idempotent.

Rules enforced here (and tested):
- a non-idempotent operation runs exactly once;
- a mutation without a persistent key (request_id) runs exactly once;
- every attempt sends the SAME frozen payload bytes (same request_id);
- an unknown outcome is retried only with that same key, never a new one;
- only stable retryable classes are retried, with capped exponential backoff
  and jitter, a hard attempt limit and a per-target circuit breaker.
"""
from __future__ import annotations

import hashlib
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import CONTRACT, LOG, OpsError, Timer, classify_exception  # noqa: E402

RETRYABLE = frozenset(CONTRACT['retry']['retryable'])


@dataclass(frozen=True)
class Operation:
    component: str
    name: str                      # contract operation
    idempotent: bool
    mutation: bool
    payload: bytes = b''           # frozen request body (includes the request_id)
    key: str | None = None         # persistent idempotency key (request_id)

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.payload).hexdigest()


@dataclass
class RetryPolicy:
    max_attempts: int = CONTRACT['retry']['max_attempts']
    base_delay_ms: int = CONTRACT['retry']['base_delay_ms']
    max_delay_ms: int = CONTRACT['retry']['max_delay_ms']
    jitter: Callable[[], float] = field(default=lambda: random.uniform(0.5, 1.0))

    def delay_ms(self, attempt: int) -> float:
        """Delay after a failed attempt number `attempt` (1-based)."""
        return min(self.max_delay_ms, self.base_delay_ms * (2 ** (attempt - 1))) * self.jitter()


class CircuitBreaker:
    """Opens after N consecutive retryable failures; half-opens after cooldown."""

    def __init__(self, failures: int = CONTRACT['retry']['circuit_failures'],
                 cooldown_ms: int = CONTRACT['retry']['circuit_cooldown_ms'], clock: Callable[[], float] = time.monotonic):
        self.threshold = failures
        self.cooldown = cooldown_ms / 1000
        self.clock = clock
        self.consecutive = 0
        self.opened_at: float | None = None

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return 'CLOSED'
        return 'HALF_OPEN' if self.clock() - self.opened_at >= self.cooldown else 'OPEN'

    def allow(self) -> bool:
        return self.state != 'OPEN'

    def success(self) -> None:
        self.consecutive = 0
        self.opened_at = None

    def failure(self) -> None:
        self.consecutive += 1
        if self.consecutive >= self.threshold or self.state == 'HALF_OPEN':
            self.opened_at = self.clock()


class RetryExhausted(OpsError):
    def __init__(self, last_class: str, attempts: int):
        super().__init__('RETRY_EXHAUSTED', 'retry')
        self.last_class = last_class
        self.attempts = attempts
        # The caller must keep the key: the last attempt may have committed.
        self.unknown_outcome = last_class == 'UNKNOWN_OUTCOME'


class NotRetryable(OpsError):
    def __init__(self, error_class: str, attempts: int):
        super().__init__(error_class, 'retry')
        self.attempts = attempts


class CircuitOpen(OpsError):
    def __init__(self):
        super().__init__('CIRCUIT_OPEN', 'retry')


def execute(op: Operation, attempt: Callable[[bytes, int], object], policy: RetryPolicy | None = None,
            breaker: CircuitBreaker | None = None, sleep: Callable[[float], None] = time.sleep,
            classify: Callable[[BaseException], str] | None = None):
    """Run `attempt(payload, n)` under RES-01. `attempt` must send exactly `payload`."""
    policy = policy or RetryPolicy()
    classify = classify or (lambda error: classify_exception(error, sent=op.mutation))
    retry_allowed = op.idempotent and (not op.mutation or bool(op.key))
    limit = policy.max_attempts if retry_allowed else 1
    payload = op.payload
    frozen = op.digest
    last = 'INTERNAL'
    for n in range(1, limit + 1):
        if breaker is not None and not breaker.allow():
            LOG.emit(op.component, op.name, 'rejected', error_class='CIRCUIT_OPEN', attempt=n, request_id=op.key)
            raise CircuitOpen()
        if hashlib.sha256(payload).hexdigest() != frozen:
            raise OpsError('IDEMPOTENCY_CONFLICT', 'retry')      # defensive: payload must never change
        timer = Timer()
        try:
            result = attempt(payload, n)
        except Exception as error:  # noqa: BLE001 -- classified, never serialized
            last = classify(error)
            retryable = last in RETRYABLE
            outcome = 'unknown' if last == 'UNKNOWN_OUTCOME' else 'timeout' if last == 'TIMEOUT' else 'failure'
            if breaker is not None and retryable:
                breaker.failure()
            if not retryable or n == limit:
                LOG.emit(op.component, op.name, outcome if retryable else 'rejected', error_class=last, attempt=n,
                         duration_ms=timer.ms, request_id=op.key)
                if not retryable:
                    raise NotRetryable(last, n) from None
                if not retry_allowed:
                    # A single attempt of a non-retryable operation keeps its real class.
                    raise NotRetryable(last, n) from None
                raise RetryExhausted(last, n) from None
            delay = policy.delay_ms(n)
            LOG.emit(op.component, op.name, outcome, error_class=last, attempt=n, duration_ms=timer.ms,
                     delay_ms=delay, request_id=op.key)
            sleep(delay / 1000)
            continue
        if breaker is not None:
            breaker.success()
        LOG.emit(op.component, op.name, 'success', attempt=n, duration_ms=timer.ms, request_id=op.key)
        return result
    raise RetryExhausted(last, limit)
