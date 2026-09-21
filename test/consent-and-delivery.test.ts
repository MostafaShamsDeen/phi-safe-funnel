/**
 * Consent gating, send-once, and retrying only what a retry can fix.
 */

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { send } from '../src/capi.ts';
import { decideOutbound, evaluateEligibility } from '../src/funnel.ts';
import { memoryStore } from '../src/idempotency.ts';

const ELIGIBLE = { state: 'CA', over_18: 'yes', condition: 'sleep', email: 'a@b.com' };
const CONFIG = { pixelId: '123', accessToken: 'tok' };
const INPUT = { eventId: 'evt-consent', eventName: 'Lead', answers: ELIGIBLE };

function stubFetch(responses: Array<{ status: number; headers?: Record<string, string> }>) {
  let call = 0;
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const next = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (k: string) => next.headers?.[k.toLowerCase()] ?? null },
      json: async () => ({ events_received: 1 }),
    };
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

describe('consent gating', () => {
  test('no consent means no advertising event, whatever else is true', () => {
    const eligibility = evaluateEligibility(ELIGIBLE);
    assert.equal(eligibility.eligible, true);

    const decision = decideOutbound(eligibility, { ...ELIGIBLE, consent_marketing: 'no' });
    assert.deepEqual(decision, { send: false, reason: 'no_consent' });
  });

  test('a missing consent answer is treated as no', () => {
    const decision = decideOutbound(evaluateEligibility(ELIGIBLE), ELIGIBLE);
    assert.equal(decision.send, false);
  });

  test('consent is checked before eligibility', () => {
    const ineligible = { state: 'OTHER', over_18: 'yes', consent_marketing: 'no' };
    const decision = decideOutbound(evaluateEligibility(ineligible), ineligible);
    assert.deepEqual(decision, { send: false, reason: 'no_consent' });
  });

  test('consent plus eligibility sends a generic Lead', () => {
    const answers = { ...ELIGIBLE, consent_marketing: 'yes' };
    assert.deepEqual(decideOutbound(evaluateEligibility(answers), answers), {
      send: true,
      eventName: 'Lead',
    });
  });
});

describe('send once', () => {
  test('the same event_id is not sent twice', async () => {
    const seen = memoryStore();
    const { impl, calls } = stubFetch([{ status: 200 }]);

    const first = await send(INPUT, CONFIG, { seen, fetchImpl: impl });
    const second = await send(INPUT, CONFIG, { seen, fetchImpl: impl });

    assert.equal(first.mode, 'sent');
    assert.equal(second.mode, 'duplicate');
    assert.equal(calls().length, 1, 'the second call must not reach the network');
  });

  test('a failed send is not recorded, so it can be retried later', async () => {
    const seen = memoryStore();
    const failing = stubFetch([{ status: 400 }]);
    const failed = await send(INPUT, CONFIG, { seen, fetchImpl: failing.impl });
    assert.equal(failed.mode, 'failed');

    const succeeding = stubFetch([{ status: 200 }]);
    const retried = await send(INPUT, CONFIG, { seen, fetchImpl: succeeding.impl });
    assert.equal(retried.mode, 'sent');
  });
});

describe('retries', () => {
  test('retries a 500 and succeeds', async () => {
    const { impl, calls } = stubFetch([{ status: 500 }, { status: 500 }, { status: 200 }]);
    const result = await send(INPUT, CONFIG, { fetchImpl: impl, baseDelayMs: 1 });

    assert.equal(result.mode, 'sent');
    assert.equal(result.mode === 'sent' && result.attempts, 3);
    assert.equal(calls().length, 3);
  });

  test('does not retry a 400, because it will be just as wrong next time', async () => {
    const { impl, calls } = stubFetch([{ status: 400 }]);
    const result = await send(INPUT, CONFIG, { fetchImpl: impl, baseDelayMs: 1 });

    assert.equal(result.mode, 'failed');
    assert.equal(calls().length, 1);
  });

  test('gives up after the configured number of attempts', async () => {
    const { impl, calls } = stubFetch([{ status: 503 }]);
    const result = await send(INPUT, CONFIG, { fetchImpl: impl, attempts: 2, baseDelayMs: 1 });

    assert.equal(result.mode, 'failed');
    assert.equal(result.mode === 'failed' && result.attempts, 2);
    assert.equal(calls().length, 2);
  });

  test('honours Retry-After instead of guessing', async () => {
    const { impl } = stubFetch([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }]);
    const started = Date.now();
    const result = await send(INPUT, CONFIG, { fetchImpl: impl, baseDelayMs: 5000 });

    assert.equal(result.mode, 'sent');
    assert.ok(Date.now() - started < 1000, 'should have used Retry-After, not the 5s backoff');
  });
});
