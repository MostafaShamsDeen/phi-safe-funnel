/**
 * Deduplication, normalisation and branching.
 *
 * The dedup contract is the part of a Conversions API integration that is most
 * often got wrong and least often noticed, because double counting looks like
 * good news on a dashboard.
 */

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { buildPayload } from '../src/capi.ts';
import { hashField, normaliseEmail, normalisePhone, normaliseZip, sha256 } from '../src/hash.ts';
import { STEPS, decideOutbound, evaluateEligibility, nextStep } from '../src/funnel.ts';

const CONTACT = { email: 'a@b.com', state: 'CA', over_18: 'yes' };

describe('deduplication', () => {
  test('the server event carries the id the browser generated, unchanged', () => {
    const eventIdFromBrowser = 'a3f1c9de-7b21-4a0e-9f55-2c6d8e4b1a77';
    const payload = buildPayload({
      eventId: eventIdFromBrowser,
      eventName: 'Lead',
      answers: CONTACT,
    });

    assert.equal(payload.data[0].event_id, eventIdFromBrowser);
    assert.equal(payload.data[0].event_name, 'Lead', 'must match the pixel event name to dedup');
    assert.equal(payload.data[0].action_source, 'website');
  });

  test('test_event_code is attached only when configured', () => {
    const withCode = buildPayload(
      { eventId: 'e', eventName: 'Lead', answers: CONTACT },
      { testEventCode: 'TEST12345' },
    );
    const without = buildPayload({ eventId: 'e', eventName: 'Lead', answers: CONTACT });

    assert.equal(withCode.test_event_code, 'TEST12345');
    assert.equal(without.test_event_code, undefined);
  });

  test('absent fields are omitted rather than sent as the hash of empty string', () => {
    const payload = buildPayload({
      eventId: 'e',
      eventName: 'Lead',
      answers: { ...CONTACT, first_name: '' },
    });
    const userData = payload.data[0].user_data as Record<string, unknown>;

    assert.equal(userData.fn, undefined);
    assert.notEqual(sha256(''), undefined);
  });
});

describe('normalisation', () => {
  test('email is lowercased and trimmed, plus addressing kept', () => {
    assert.equal(normaliseEmail('  Mostafa+Jobs@Example.COM '), 'mostafa+jobs@example.com');
  });

  test('phone keeps the country code and drops everything else', () => {
    assert.equal(normalisePhone('+961 71 557 148'), '96171557148');
    assert.equal(normalisePhone('00961-71-557-148'), '96171557148');
  });

  test('zip takes the first five characters only', () => {
    assert.equal(normaliseZip('90210-1234'), '90210');
  });

  test('hashField returns undefined for empty input', () => {
    assert.equal(hashField('email', '   '), undefined);
    assert.equal(hashField('email', undefined), undefined);
  });
});

describe('funnel branching and eligibility', () => {
  test('the severity question is skipped when the condition is "other"', () => {
    const answers = { state: 'CA', over_18: 'yes', condition: 'other' };
    const step = nextStep(answers);
    assert.equal(step?.id, 'contact', 'should jump past severity');
  });

  test('the severity question is asked for a specific condition', () => {
    const answers = { state: 'CA', over_18: 'yes', condition: 'sleep' };
    assert.equal(nextStep(answers)?.id, 'severity');
  });

  test('out of area is refused, without clinical detail in the message', () => {
    const result = evaluateEligibility({ state: 'OTHER', over_18: 'yes', condition: 'sleep' });
    assert.equal(result.eligible, false);
    assert.equal(result.code, 'out_of_area');
    assert.ok(!/sleep/i.test(result.reason ?? ''));
  });

  test('under 18 is refused', () => {
    const result = evaluateEligibility({ state: 'CA', over_18: 'no' });
    assert.equal(result.code, 'under_18');
  });

  test('no advertising event fires for an ineligible visitor', () => {
    const ineligible = { state: 'OTHER', over_18: 'yes', consent_marketing: 'yes' };
    const eligible = { state: 'CA', over_18: 'yes', consent_marketing: 'yes' };

    assert.deepEqual(decideOutbound(evaluateEligibility(ineligible), ineligible), {
      send: false,
      reason: 'not_eligible',
    });
    assert.deepEqual(decideOutbound(evaluateEligibility(eligible), eligible), {
      send: true,
      eventName: 'Lead',
    });
  });

  test('every step field is classified in phi.ts', async () => {
    const { classify } = await import('../src/phi.ts');
    for (const step of STEPS) {
      if (step.kind === 'contact') continue;
      assert.notEqual(
        classify(step.field),
        'unclassified',
        `step "${step.id}" writes unclassified field "${step.field}"`,
      );
    }
  });
});
