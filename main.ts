// The forge's life in one process: start the HTTP server, tell the harness env which
// ephemeral port it bound, then keep serving until the env says the trial is over.
//
// The harness owns the other side of this contract (see the kit's program/env/src/wire.ts):
//   - MAKEFUN_ENV_URL is the env's origin (http://store:8080 inside a trial pod). With no
//     env there is nothing to serve, so the process exits 1 right away.
//   - listen(0) lets the kernel pick a free port. Port 8080 is the env's own and is never
//     bound here.
//   - POST $MAKEFUN_ENV_URL/register with {"port": N}. The env dials the address that
//     request came from plus N. The first register wins; a 409 means another entry already
//     registered, and this process simply carries on waiting like any other.
//   - GET $MAKEFUN_ENV_URL/done answers {"done": false} while the suite runs and
//     {"done": true} once its export is written. It answers at once, so this is a poll
//     with a short backoff, never a long-held request, and the process never exits early.
//   - Once done is true the server closes and the process exits 0; the harness then stops
//     the env and the scorer reads its export.
//
// This file only runs the lifecycle. The forge itself lives in app.ts (and its modules),
// which is what the suite scores.

import { createApp } from './app.ts';

/** The env's origin, without a trailing slash. Empty when the trial gives us none. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Abandon one register/done request after this long, then retry it. */
const REQUEST_BUDGET_MS = 30_000;
/** First backoff between retries, and the longest backoff. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Backoff after `failures` failed requests: doubling from the first, capped. */
function backoffAfter(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

/** True for a register answer that ends the loop without an error. */
function registerSettled(status: number): boolean {
  return status === 200 || status === 409;
}

/** True for a register answer that is a contract error and must end the program. */
function registerFatal(status: number): boolean {
  return status === 400 || status === 405;
}

/**
 * Announce the bound port to the env until it accepts it. 200 is the normal answer and
 * 409 means a first register already won, which is not this process's to fix. A 400 or
 * 405 is a contract error and throws; anything else (a network error, another status)
 * is retried, since the env may still be starting.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (registerSettled(answer.status)) return;
      if (registerFatal(answer.status)) {
        throw new Error(`register answered HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await pause(backoffAfter(failures));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function awaitDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoffAfter(failures));
  }
}

/** Bind the port, announce it, then serve until the env says the trial is over. */
async function serve(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[forge] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await serve();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
