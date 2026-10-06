import { describe, expect, it } from 'vitest';
import { monthlyCents, stripeHostedUrl } from '../../src/billing/client';

describe('billing client guards', () => {
  it('matches the approved progressive monthly pricing', () => {
    expect(monthlyCents(0)).toBe(1299);
    expect(monthlyCents(5)).toBe(1299);
    expect(monthlyCents(10)).toBe(2294);
    expect(monthlyCents(20)).toBe(4284);
    expect(monthlyCents(25)).toBe(5029);
    expect(monthlyCents(100)).toBe(16204);
    expect(monthlyCents(250)).toBe(35554);
    expect(() => monthlyCents(-1)).toThrow('INVALID_EMPLOYEE_QUANTITY');
  });

  it('accepts only Stripe-hosted redirect destinations', () => {
    expect(stripeHostedUrl('https://checkout.stripe.com/c/pay/cs_test_123', 'checkout')).toMatch(/^https:\/\/checkout\.stripe\.com/);
    expect(stripeHostedUrl('https://billing.stripe.com/p/session/test_123', 'portal')).toMatch(/^https:\/\/billing\.stripe\.com/);
    for (const bad of [
      'https://evil.invalid/checkout.stripe.com',
      'https://checkout.stripe.com.evil.invalid/x',
      'http://checkout.stripe.com/x',
      'https://user:pass@checkout.stripe.com/x',
      'javascript:alert(1)',
    ]) expect(stripeHostedUrl(bad, 'checkout'), bad).toBeNull();
  });
});
