/**
 * The boundary.
 *
 * Every field the funnel collects is classified here, and nothing reaches an
 * advertising platform unless it is named below. The list is an allowlist rather
 * than a blocklist on purpose: a field nobody has classified yet is treated as
 * protected health information, because the cost of guessing wrong in that
 * direction is a missing metric, and the cost of guessing wrong in the other
 * direction is a disclosure.
 *
 * The distinction that matters, and the one that is easy to get wrong:
 *
 *   A hashed email address is not PHI by itself. A hashed email address sent
 *   alongside an event called "Diabetes Consult Booked" is, because the event
 *   name reveals the condition. So this module controls two things, not one:
 *   which FIELDS may leave, and which EVENT NAMES may be used. Every outbound
 *   event is generic. The condition stays in the store and is never encoded in
 *   the event, the custom data, or the URL.
 */

/** Fields that may be hashed and sent as advertising match keys. */
export const MATCHABLE_FIELDS = [
  'email',
  'phone',
  'first_name',
  'last_name',
  'state',
  'zip',
  'country',
] as const;

/**
 * Fields that never leave the store, in any form, hashed or not.
 *
 * `date_of_birth` sits here deliberately even though Meta accepts `db` as a
 * match key and it would raise the match quality score. In a health intake the
 * combination of a date of birth with the fact that someone completed a
 * condition-specific funnel is identifying in a way an email is not, and the
 * extra match quality is not worth that trade.
 */
export const PHI_FIELDS = [
  'condition',
  'conditions',
  'medications',
  'symptoms',
  'diagnosis',
  'diagnosis_notes',
  'pregnancy_status',
  'height_cm',
  'weight_kg',
  'date_of_birth',
  'insurance_id',
  'provider_notes',
] as const;

/** Operational fields used for eligibility and routing, never sent outward. */
export const INTERNAL_FIELDS = ['over_18', 'consent_marketing', 'consent_treatment'] as const;

export type MatchableField = (typeof MATCHABLE_FIELDS)[number];
export type PhiField = (typeof PHI_FIELDS)[number];

/** Event names permitted on outbound advertising events. Generic by design. */
export const ALLOWED_EVENT_NAMES = ['Lead', 'CompleteRegistration', 'Schedule'] as const;
export type AllowedEventName = (typeof ALLOWED_EVENT_NAMES)[number];

export type Classification = 'matchable' | 'phi' | 'internal' | 'unclassified';

export function classify(field: string): Classification {
  if ((MATCHABLE_FIELDS as readonly string[]).includes(field)) return 'matchable';
  if ((PHI_FIELDS as readonly string[]).includes(field)) return 'phi';
  if ((INTERNAL_FIELDS as readonly string[]).includes(field)) return 'internal';
  return 'unclassified';
}

/** True only for fields explicitly cleared to leave. Unclassified fails closed. */
export function mayLeave(field: string): boolean {
  return classify(field) === 'matchable';
}

/**
 * Split a submission into the part that stays and the part that may go.
 *
 * Anything unclassified is grouped with the PHI, so adding a new question to the
 * funnel without classifying it cannot silently start leaking it.
 */
export function partition(answers: Record<string, string>): {
  matchable: Record<string, string>;
  retained: Record<string, string>;
  unclassified: string[];
} {
  const matchable: Record<string, string> = {};
  const retained: Record<string, string> = {};
  const unclassified: string[] = [];

  for (const [field, value] of Object.entries(answers)) {
    const kind = classify(field);
    if (kind === 'matchable') {
      matchable[field] = value;
    } else {
      retained[field] = value;
      if (kind === 'unclassified') unclassified.push(field);
    }
  }
  return { matchable, retained, unclassified };
}

/**
 * Strip query strings and fragments from a URL before it is sent as the event
 * source. Intake funnels routinely carry answers in the query string, and a URL
 * is the most common way health data reaches an analytics vendor by accident.
 */
export function safeSourceUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function isAllowedEventName(name: string): name is AllowedEventName {
  return (ALLOWED_EVENT_NAMES as readonly string[]).includes(name);
}
