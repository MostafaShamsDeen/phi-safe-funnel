/**
 * Meta Conversions API.
 *
 * Two things here are worth more attention than the HTTP call itself.
 *
 * 1. event_id. The browser pixel and this server both report the same lead.
 *    Meta collapses them into one event when both carry the same event_id and
 *    the same event_name. Get it wrong and every conversion is counted twice,
 *    which inflates reporting and misleads bidding. The id is generated once on
 *    the client and travels to both places; it is never generated here.
 *
 * 2. assertNoPhi. The payload is checked against the submission before it is
 *    sent, and the send throws rather than degrades if a retained value appears
 *    in it. A silent leak is worse than a failed conversion.
 */

import { hashField, META_KEYS, sha256 } from './hash.ts';
import type { SeenStore } from './idempotency.ts';
import { isAllowedEventName, partition, safeSourceUrl } from './phi.ts';

export interface CapiConfig {
  pixelId?: string;
  accessToken?: string;
  /** From Events Manager. Routes events to the test view instead of reporting. */
  testEventCode?: string;
  apiVersion?: string;
}

export interface BuildInput {
  eventId: string;
  eventName: string;
  answers: Record<string, string>;
  sourceUrl?: string;
  clientIp?: string;
  userAgent?: string;
  eventTime?: number;
}

export interface CapiPayload {
  data: Array<{
    event_name: string;
    event_time: number;
    event_id: string;
    action_source: 'website';
    event_source_url?: string;
    user_data: Record<string, string[] | string>;
  }>;
  test_event_code?: string;
}

export function buildPayload(input: BuildInput, config: CapiConfig = {}): CapiPayload {
  if (!isAllowedEventName(input.eventName)) {
    throw new Error(
      `Event name "${input.eventName}" is not on the allowlist. Outbound event names must be generic.`,
    );
  }

  const { matchable } = partition(input.answers);
  const user_data: Record<string, string[] | string> = {};

  for (const [field, value] of Object.entries(matchable)) {
    const hashed = hashField(field, value);
    if (!hashed) continue;
    const key = META_KEYS[field];
    if (key) user_data[key] = [hashed];
  }

  // Not hashed, by Meta's spec. Both are ordinary request metadata.
  if (input.clientIp) user_data.client_ip_address = input.clientIp;
  if (input.userAgent) user_data.client_user_agent = input.userAgent;

  const payload: CapiPayload = {
    data: [
      {
        event_name: input.eventName,
        event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
        event_id: input.eventId,
        action_source: 'website',
        event_source_url: safeSourceUrl(input.sourceUrl),
        user_data,
      },
    ],
  };

  if (config.testEventCode) payload.test_event_code = config.testEventCode;
  return payload;
}

/**
 * Fail closed.
 *
 * Walks the serialised payload looking for any retained value, and for the
 * SHA-256 of any retained value. The second check is the one that matters:
 * hashing a condition does not make it safe to send, it just makes the leak
 * harder to see in a network tab.
 */
export function assertNoPhi(payload: CapiPayload, answers: Record<string, string>): void {
  const { retained } = partition(answers);
  const serialised = JSON.stringify(payload).toLowerCase();

  for (const [field, value] of Object.entries(retained)) {
    if (!value) continue;
    const raw = String(value).toLowerCase();
    if (raw.length >= 3 && serialised.includes(raw)) {
      throw new Error(`Refusing to send: retained field "${field}" appears in the payload.`);
    }
    if (serialised.includes(sha256(String(value).trim().toLowerCase()))) {
      throw new Error(`Refusing to send: hash of retained field "${field}" appears in the payload.`);
    }
  }
}

export type SendResult =
  | { mode: 'dry-run'; payload: CapiPayload; reason: string }
  | { mode: 'duplicate'; payload: CapiPayload; reason: string }
  | { mode: 'sent'; payload: CapiPayload; status: number; attempts: number; body: unknown }
  | { mode: 'failed'; payload: CapiPayload; status?: number; attempts: number; error: string };

export interface SendOptions {
  seen?: SeenStore;
  attempts?: number;
  baseDelayMs?: number;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries on the failures that a retry can actually fix.
 *
 * 5xx, 429 and a dropped connection are worth trying again. A 400 means the
 * payload is wrong and will be just as wrong in two seconds, so retrying it
 * only delays the error and triples the log noise. Retry-After is honoured
 * when present, because guessing a backoff when the server has told you the
 * answer is rude.
 */
async function postWithRetry(
  url: string,
  payload: CapiPayload,
  options: Required<Pick<SendOptions, 'attempts' | 'baseDelayMs'>> & { fetchImpl: typeof fetch },
): Promise<{ status: number; body: unknown; attempts: number } | { error: string; status?: number; attempts: number }> {
  let lastError = 'unknown error';
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      const response = await options.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return { status: response.status, body: await response.json().catch(() => null), attempts: attempt };
      }

      lastStatus = response.status;
      lastError = `HTTP ${response.status}`;

      if (!RETRYABLE.has(response.status) || attempt === options.attempts) {
        return { error: lastError, status: response.status, attempts: attempt };
      }

      // Retry-After: 0 is a real instruction, not a missing value, so the
      // comparison is >= rather than >.
      const header = response.headers?.get?.('retry-after');
      const retryAfter = header === null || header === undefined ? NaN : Number(header);
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1000
        : options.baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    } catch (error) {
      lastError = (error as Error).message;
      if (attempt === options.attempts) return { error: lastError, attempts: attempt };
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }

  return { error: lastError, status: lastStatus, attempts: options.attempts };
}

/**
 * Sends when credentials are present, and otherwise returns exactly what it
 * would have sent. The dry run is not a stub for convenience: it means anyone
 * can clone this and see the real payload shape without a Meta account.
 */
export async function send(
  input: BuildInput,
  config: CapiConfig = {},
  options: SendOptions = {},
): Promise<SendResult> {
  const payload = buildPayload(input, config);
  assertNoPhi(payload, input.answers);

  if (options.seen && (await options.seen.has(input.eventId))) {
    return {
      mode: 'duplicate',
      payload,
      reason: `event_id ${input.eventId} has already been sent. Not sending again.`,
    };
  }

  if (!config.pixelId || !config.accessToken) {
    return {
      mode: 'dry-run',
      payload,
      reason: 'META_PIXEL_ID or META_ACCESS_TOKEN not set. Payload built and validated, not sent.',
    };
  }

  const version = config.apiVersion ?? 'v21.0';
  const url = `https://graph.facebook.com/${version}/${config.pixelId}/events?access_token=${encodeURIComponent(config.accessToken)}`;

  const result = await postWithRetry(url, payload, {
    attempts: options.attempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 200,
    fetchImpl: options.fetchImpl ?? fetch,
  });

  if ('error' in result) {
    return { mode: 'failed', payload, status: result.status, attempts: result.attempts, error: result.error };
  }

  // Recorded only after a confirmed send, so a failure can still be retried.
  if (options.seen) await options.seen.add(input.eventId);

  return { mode: 'sent', payload, status: result.status, attempts: result.attempts, body: result.body };
}

export function configFromEnv(): CapiConfig {
  return {
    pixelId: process.env.META_PIXEL_ID,
    accessToken: process.env.META_ACCESS_TOKEN,
    testEventCode: process.env.META_TEST_EVENT_CODE,
  };
}
