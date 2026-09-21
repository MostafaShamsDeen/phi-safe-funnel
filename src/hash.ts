/**
 * Normalisation and hashing of advertising match keys.
 *
 * Meta, Google and TikTok all expect SHA-256 of a *normalised* value, and they
 * each document normalisation slightly differently. Getting it wrong does not
 * throw an error anywhere. It silently lowers match quality, which is the kind
 * of defect that survives for months because nothing looks broken, so the rules
 * live in one place with test vectors against them.
 */

import { createHash } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Lowercase, trim. Meta does not want the plus-addressing stripped. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Digits only, no plus, no separators, country code included.
 *
 * A leading double zero is an international prefix rather than part of the
 * number, so it is dropped. A local Lebanese number written as 71 557 148 has
 * no country code and cannot be matched reliably, so callers are expected to
 * pass an international form; this function does not invent one.
 */
export function normalisePhone(raw: string): string {
  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits;
}

/** Lowercase, letters only. "New York" becomes "newyork". */
export function normaliseName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z]/g, '');
}

/** US-style handling: first five characters, lowercased. */
export function normaliseZip(raw: string): string {
  return raw.trim().toLowerCase().split('-')[0].slice(0, 5);
}

/** Two-letter ISO country code, lowercased. */
export function normaliseCountry(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 2);
}

/** Meta's short keys for user_data. */
export const META_KEYS: Record<string, string> = {
  email: 'em',
  phone: 'ph',
  first_name: 'fn',
  last_name: 'ln',
  state: 'st',
  zip: 'zp',
  country: 'country',
};

const NORMALISERS: Record<string, (raw: string) => string> = {
  email: normaliseEmail,
  phone: normalisePhone,
  first_name: normaliseName,
  last_name: normaliseName,
  state: normaliseName,
  zip: normaliseZip,
  country: normaliseCountry,
};

/**
 * Normalise then hash a single match key. Returns undefined for empty input so
 * that absent fields are omitted from the payload rather than sent as the hash
 * of an empty string, which is a real value and pollutes match quality.
 */
export function hashField(field: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const normalise = NORMALISERS[field];
  if (!normalise) return undefined;
  const normalised = normalise(raw);
  if (!normalised) return undefined;
  return sha256(normalised);
}
