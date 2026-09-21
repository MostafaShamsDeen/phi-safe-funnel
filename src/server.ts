/**
 * A small HTTP server with no framework and no dependencies.
 *
 * Serves the funnel and exposes one interesting endpoint, POST /api/submit,
 * which does the whole job in order: revalidate eligibility on the server,
 * split the submission at the boundary, retain one side, send the other, and
 * report back exactly what went where so the split is visible in the browser.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configFromEnv, send } from './capi.ts';
import { evaluateEligibility, eventNameFor } from './funnel.ts';
import { partition } from './phi.ts';
import { retain } from './store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3210);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const JSON_HEADERS = { 'content-type': MIME['.json'] };

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/api/submit') {
    try {
      const body = (await readBody(req)) as {
        eventId?: string;
        answers?: Record<string, string>;
        sourceUrl?: string;
      };

      const answers = body.answers ?? {};
      const eventId = body.eventId;
      if (!eventId) {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'eventId is required, and must be the one the pixel used.' }));
        return;
      }

      // The client gates screens for UX. The server decides eligibility.
      const eligibility = evaluateEligibility(answers);
      const { matchable, retained, unclassified } = partition(answers);

      await retain({
        eventId,
        submittedAt: new Date().toISOString(),
        retained,
        eligibility: { eligible: eligibility.eligible, code: eligibility.code },
      });

      const eventName = eventNameFor(eligibility);
      let capi = null;
      if (eventName) {
        capi = await send(
          {
            eventId,
            eventName,
            answers,
            sourceUrl: body.sourceUrl,
            clientIp: req.socket.remoteAddress ?? undefined,
            userAgent: req.headers['user-agent'],
          },
          configFromEnv(),
        );
      }

      res.writeHead(200, JSON_HEADERS);
      res.end(
        JSON.stringify({
          eligibility,
          // Field names only. The values stay on the server.
          retainedFields: Object.keys(retained),
          matchableFields: Object.keys(matchable),
          unclassified,
          capi,
        }),
      );
      return;
    } catch (error) {
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ error: (error as Error).message }));
      return;
    }
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  try {
    const contents = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(contents);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] });
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const capi = configFromEnv();
  const mode = capi.pixelId && capi.accessToken ? 'live (events will be sent to Meta)' : 'dry run (no credentials set)';
  console.log(`phi-safe-funnel listening on http://127.0.0.1:${PORT}`);
  console.log(`Conversions API mode: ${mode}`);
});
