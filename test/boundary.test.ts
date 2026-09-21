/**
 * The tests that matter.
 *
 * Everything else in this repository is an argument. These are the part that
 * holds the argument up: if a health answer can reach the advertising payload,
 * one of these fails.
 */

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { assertNoPhi, buildPayload } from '../src/capi.ts';
import { classify, mayLeave, partition, safeSourceUrl } from '../src/phi.ts';
import { sha256 } from '../src/hash.ts';

const FULL_SUBMISSION = {
  email: 'Mostafa@Example.com ',
  phone: '+961 71 557 148',
  first_name: 'Mostafa',
  last_name: 'Shams El Deen',
  state: 'CA',
  zip: '90210',
  country: 'US',
  condition: 'sleep',
  symptoms: 'over_6_months',
  medications: 'zolpidem',
  date_of_birth: '1999-04-02',
  over_18: 'yes',
};

describe('the boundary', () => {
  test('health answers never reach the payload, in any form', () => {
    const payload = buildPayload({
      eventId: 'evt-1',
      eventName: 'Lead',
      answers: FULL_SUBMISSION,
    });

    const serialised = JSON.stringify(payload).toLowerCase();

    for (const value of ['sleep', 'over_6_months', 'zolpidem', '1999-04-02']) {
      assert.ok(!serialised.includes(value.toLowerCase()), `raw "${value}" leaked into the payload`);
      assert.ok(!serialised.includes(sha256(value)), `hashed "${value}" leaked into the payload`);
    }
  });

  test('assertNoPhi throws rather than degrading', () => {
    const payload = buildPayload({ eventId: 'evt-2', eventName: 'Lead', answers: FULL_SUBMISSION });
    // Simulate the mistake this whole module exists to prevent.
    payload.data[0].user_data.condition = [sha256('sleep')];

    assert.throws(
      () => assertNoPhi(payload, FULL_SUBMISSION),
      /hash of retained field "condition"/,
    );
  });

  test('a field nobody classified is retained, not sent', () => {
    // Someone adds a question to the funnel and forgets to classify it.
    const withNewField = { ...FULL_SUBMISSION, mental_health_history: 'yes' };

    assert.equal(classify('mental_health_history'), 'unclassified');
    assert.equal(mayLeave('mental_health_history'), false);

    const { retained, unclassified } = partition(withNewField);
    assert.ok('mental_health_history' in retained);
    assert.deepEqual(unclassified, ['mental_health_history']);

    const payload = buildPayload({ eventId: 'evt-3', eventName: 'Lead', answers: withNewField });
    assert.doesNotThrow(() => assertNoPhi(payload, withNewField));
  });

  test('condition-specific event names are refused', () => {
    assert.throws(
      () =>
        buildPayload({
          eventId: 'evt-4',
          eventName: 'SleepConsultBooked',
          answers: FULL_SUBMISSION,
        }),
      /not on the allowlist/,
    );
  });

  test('query strings are stripped from the event source url', () => {
    const url = 'https://clinic.example.com/intake?condition=sleep&email=a%40b.com#step3';
    assert.equal(safeSourceUrl(url), 'https://clinic.example.com/intake');
  });

  test('match keys that are allowed do appear, hashed', () => {
    const payload = buildPayload({ eventId: 'evt-5', eventName: 'Lead', answers: FULL_SUBMISSION });
    const userData = payload.data[0].user_data as Record<string, string[]>;

    assert.deepEqual(userData.em, [sha256('mostafa@example.com')]);
    assert.deepEqual(userData.ph, [sha256('96171557148')]);
    assert.deepEqual(userData.ln, [sha256('shamseldeen')]);
    assert.equal(userData.db, undefined, 'date of birth is deliberately not sent');
  });
});
