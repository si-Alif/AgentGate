import type { FastifyRequest } from "fastify";

/**
 * Wires the underlying POST's client-disconnect signal into an
 * AbortController whose .signal Day 4 will thread through as
 * executeTool()'s existing externalSignal parameter (Week 4) — built
 * now so Day 4 has nothing left to retrofit (Decision 2.13).
 *
 * .once(), not .on(): guarantees the listener fires (and self-removes)
 * at most one time per request, regardless of how many times 'close'
 * might fire on the underlying stream — no leak, no double-abort logic
 * needed (AbortController.abort() is itself idempotent, but there's no
 * reason to rely on that when .once() makes it moot).
 */
export function createRequestAbortController(request: FastifyRequest): AbortController {
  const controller = new AbortController();
  request.raw.once("close", () => {
    if (request.raw.aborted) {
      controller.abort();
    }
  });
  return controller;
}