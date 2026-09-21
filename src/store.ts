/**
 * The retained side of the boundary.
 *
 * A line-delimited JSON file standing in for whatever actually holds the health
 * answers in production: a database inside the covered entity's own systems, or
 * a vendor that has signed a business associate agreement. It is deliberately
 * the least clever file in the repo. The point being demonstrated is where the
 * data goes, not how it is stored.
 *
 * Written outside the repository and ignored by git, because a demo that
 * commits intake answers would undercut its own argument.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DATA_DIR = process.env.PHI_STORE_DIR ?? join(process.cwd(), 'data');
const STORE_PATH = join(DATA_DIR, 'submissions.jsonl');

export interface RetainedRecord {
  eventId: string;
  submittedAt: string;
  retained: Record<string, string>;
  eligibility: { eligible: boolean; code?: string };
}

export async function retain(record: RetainedRecord): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await appendFile(STORE_PATH, JSON.stringify(record) + '\n', 'utf8');
}

export async function readAll(): Promise<RetainedRecord[]> {
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RetainedRecord);
  } catch {
    return [];
  }
}

export const storePath = STORE_PATH;
