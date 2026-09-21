# phi-safe-funnel

A telehealth-style eligibility funnel with a hard boundary between protected health
information and advertising conversion data.

Health answers stay on the server. The advertising platform receives a hashed
identifier, a generic event name, and nothing else. A test suite fails if that
ever stops being true.

No dependencies, no build step, no `npm install`.

```bash
node src/server.ts          # http://127.0.0.1:3210
node --test "test/**/*.test.ts"
```

Node 22.6 or newer, because the TypeScript runs directly.

---

## What this is

Three things sit together here that are usually written about separately:

1. **A multi-step funnel with branching and an eligibility gate.** State, age, reason
   for visit, duration, contact. The duration question is skipped when the reason is
   "something else", which is the branching most funnel tools exist to provide.
2. **Meta Conversions API from the server**, with normalisation, SHA-256 hashing, and
   `event_id` deduplication against the browser pixel.
3. **A field-level PHI boundary** that decides, per field, what is allowed to leave.

The third is the reason the first two are interesting. Server-side tracking in a
regulated setting is not hard because of the HTTP call. It is hard because the
default posture of every analytics integration is to send everything it can, and in
a health context that default is a disclosure.

## The boundary

`src/phi.ts` holds one allowlist and one denylist, and **anything unclassified is
treated as PHI**. Adding a question to the funnel without classifying it cannot
silently start leaking it. There is a test for exactly that.

| | |
|---|---|
| **May leave, hashed** | email, phone, first name, last name, state, zip, country |
| **Never leaves** | condition, symptoms, medications, diagnosis, pregnancy status, height, weight, date of birth, insurance id |

Two decisions in there are worth explaining.

**Date of birth is on the deny list even though Meta accepts it** and it would raise
the match quality score. In a health intake, a date of birth combined with the fact
that someone completed a condition-specific funnel is identifying in a way an email
address is not. The extra match quality is not worth that trade.

**Event names are controlled, not just fields.** A hashed email is not PHI. A hashed
email attached to an event called `SleepConsultBooked` is, because the event name
carries the condition. Outbound event names are restricted to a generic allowlist,
and `buildPayload` throws on anything else. This is the mistake that turns a
compliant stack into a non-compliant one, and it is one line of code to make.

**URLs are stripped of query strings** before being sent as `event_source_url`.
Intake funnels routinely carry answers in the query string, and a URL is the most
common way health data reaches a vendor by accident.

## Deduplication

The browser pixel and the server both report the same lead. Meta collapses them into
one conversion when both carry the same `event_id` and the same `event_name`.

The id is generated **once, in the browser**, and travels to both places. It is never
generated on the server, because two ids means two conversions, which inflates
reporting and misleads bidding while looking like good news on a dashboard.

`test/dedup-and-funnel.test.ts` pins that contract.

## Normalisation

Each platform documents normalisation slightly differently, and getting it wrong
never throws. It silently lowers match quality, which is the kind of defect that
survives for months because nothing looks broken. The rules live in `src/hash.ts`
with test vectors against them.

- Email: trimmed, lowercased, plus-addressing preserved
- Phone: digits only, country code kept, international `00` prefix dropped
- Names and state: lowercased, letters only
- Zip: first five characters
- Empty values are omitted rather than sent as the hash of an empty string, which is
  a real value and pollutes match quality

The live panel in the browser shows the **normalised** value inside `sha256(...)`,
not the value as typed, so the preview cannot tell you a comforting lie.

## Running it against a real pixel

Everything above is demonstrable with no Meta account. With no credentials set, the
server builds the payload, validates it, and returns exactly what it would have sent.

To send for real, copy `.env.example` to `.env` and fill in the pixel id and access
token. Set `META_TEST_EVENT_CODE` from Events Manager > Test events and the events
land in the test view instead of your reporting, which is how to watch deduplication
work without touching a live campaign's numbers.

## Tests

```
node --test "test/**/*.test.ts"
```

19 tests. The ones that matter:

- Health answers never reach the payload, raw or hashed
- `assertNoPhi` throws rather than degrading when a retained value appears
- An unclassified field is retained, not sent
- Condition-specific event names are refused
- Query strings are stripped from the event source URL
- The server event carries the browser's `event_id` unchanged
- Every field the funnel writes is classified in `phi.ts`

The hashed check is the important half of the first one. Hashing a condition does not
make it safe to send, it just makes the leak harder to see in a network tab.

## What this is not

- **Not a compliance product, and not legal advice.** Field-level separation is one
  control among many. It does not substitute for a business associate agreement, a
  risk analysis, access controls, audit logging, encryption at rest, or counsel.
- **Not production code.** The store is a JSONL file standing in for a real system
  inside the covered entity's own infrastructure.
- **No real PHI anywhere in this repository.** The `data/` directory is gitignored.
- Meta and TikTok do not sign BAAs. That is the reason this separation exists rather
  than a detail about it.

## Layout

```
src/phi.ts        the boundary: classification, partitioning, URL stripping
src/hash.ts       normalisation and SHA-256, with the per-platform rules
src/capi.ts       payload construction, assertNoPhi, send with dry-run mode
src/funnel.ts     steps, branching, server-side eligibility
src/store.ts      the retained side, deliberately boring
src/server.ts     ~120 lines of node:http, no framework
public/           the funnel, and a live view of where each answer goes
test/             19 tests
```

## Licence

MIT.

Built by [Mostafa Shams El Deen](https://www.linkedin.com/in/mostafashamseldeen).
