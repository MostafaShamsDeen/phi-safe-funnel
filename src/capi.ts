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
  | { mode: 'sent'; payload: CapiPayload; status: number; body: unknown };

/**
 * Sends when credentials are present, and otherwise returns exactly what it
 * would have sent. The dry run is not a stub for convenience: it means anyone
 * can clone this and see the real payload shape without a Meta account.
 */
export async function send(
  input: BuildInput,
  config: CapiConfig = {},
): Promise<SendResult> {
  const payload = buildPayload(input, config);
  assertNoPhi(payload, input.answers);

  if (!config.pixelId || !config.accessToken) {
    return {
      mode: 'dry-run',
      payload,
      reason: 'META_PIXEL_ID or META_ACCESS_TOKEN not set. Payload built and validated, not sent.',
    };
  }

  const version = config.apiVersion ?? 'v21.0';
  const url = `https://graph.facebook.com/${version}/${config.pixelId}/events?access_token=${encodeURIComponent(config.accessToken)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return {
    mode: 'sent',
    payload,
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

export function configFromEnv(): CapiConfig {
  return {
    pixelId: process.env.META_PIXEL_ID,
    accessToken: process.env.META_ACCESS_TOKEN,
    testEventCode: process.env.META_TEST_EVENT_CODE,
  };
}
