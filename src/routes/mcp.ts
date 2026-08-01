import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { isOriginAllowed } from "../mcp/http/origin-validator.js";
import { checkRateLimitByNameSpace } from "../lib/rate-limiter.js";
import { env } from "../config/env.js";
import { jsonRpcEnvelopeShapeSchema, mcpRequestEnvelopeSchema } from "../mcp/schemas/mcp-envelope.schema.js";
import { McpGatewayError, formatMcpErrorResponse } from "../mcp/errors/mcp-error-taxonomy.js";
import { resolveAgentIdentity } from "../mcp/auth/mcp-auth-resolver.js";
import { createRequestAbortController } from "../mcp/lifecycle/request-abort.js";
import { parseApiKey } from "../lib/api-key.js";

const MESSAGE_RATE_NAMESPACE = "mcp-msg";

function deriveCoarseRateLimitKey(request: FastifyRequest): string {
  const authHeader = request.headers.authorization;
  let identity = `ip:${request.ip}`;
  if (authHeader?.startsWith("Bearer ")) {
    const parsed = parseApiKey(authHeader.slice("Bearer ".length).trim());
    if (parsed) identity = `keyid:${parsed.keyId}`;
  }
  // Decision 2.10 — Mcp-Method, when present, buckets the coarse limit
  // per method so a flood of tools/call can't starve a legitimate
  // tools/list from the SAME agent. Absent header -> one shared bucket.
  const method = request.headers["mcp-method"];
  return typeof method === "string" ? `${identity}:${method}` : identity;
}

function extractRequestId(body: unknown): string | number | null {
  if (body && typeof body === "object" && "id" in body) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

export async function mcpGatewayRoutes(app: FastifyInstance) {
  app.decorateRequest("abortController", null);

  // Decision 2.8 — every response leaving THIS scope is JSON-RPC
  // shaped, including genuinely unexpected exceptions and Fastify's
  // own body-parser failures. Distinct from app.ts's REST-scoped
  // handler; Fastify's plugin encapsulation makes this safe.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "Unhandled error in MCP gateway");
    const requestId = extractRequestId(request.body);

    if (error.statusCode !== undefined && error.statusCode < 500) {
      // A client-side failure Fastify itself rejected before our own
      // envelope validation ran (malformed JSON, unsupported
      // content-type, oversized body, etc.).
      return reply
        .status(error.statusCode)
        .send(formatMcpErrorResponse(McpGatewayError.fromSignal("PARSE_ERROR"), requestId));
    }

    return reply
      .status(200)
      .send(formatMcpErrorResponse(McpGatewayError.fromSignal("INTERNAL_ERROR"), requestId));
  });

  // Decision 2.6/F6 — Origin + coarse rate-limit are header-only checks;
  // they run BEFORE Fastify's JSON body parser, so a rejected request
  // never pays the cost of body parsing at all.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST") return;

    const origin = request.headers.origin;
    if (!isOriginAllowed(origin)) {
      return reply
        .status(403)
        .send(formatMcpErrorResponse(McpGatewayError.fromSignal("ORIGIN_NOT_ALLOWED"), null));
    }

    const key = deriveCoarseRateLimitKey(request);
    const result = await checkRateLimitByNameSpace(MESSAGE_RATE_NAMESPACE, key, env.AGENTGATE_MCP_MESSAGE_RATE_LIMIT);

    if (!result.allowed) {
      // Decision 2.2/F2 — degraded infra is NEVER reported as a policy
      // denial.
      if (result.degraded) {
        return reply
          .status(503)
          .send(formatMcpErrorResponse(McpGatewayError.fromSignal("SERVICE_DEGRADED"), null));
      }
      return reply
        .status(429)
        .send(formatMcpErrorResponse(McpGatewayError.fromSignal("MESSAGE_RATE_LIMITED"), null));
    }
  });

  app.addHook("preHandler", async (request) => {
    if (request.method !== "POST") return;
    request.abortController = createRequestAbortController(request);
  });

  app.post("/", async (request, reply) => {
    const shapeResult = jsonRpcEnvelopeShapeSchema.safeParse(request.body);
    if (!shapeResult.success) {
      return reply
        .status(400)
        .send(formatMcpErrorResponse(McpGatewayError.fromSignal("INVALID_REQUEST"), null));
    }

    const requestId = shapeResult.data.id;

    const versionResult = mcpRequestEnvelopeSchema.safeParse(request.body);
    if (!versionResult.success) {
      return reply
        .status(200)
        .send(formatMcpErrorResponse(McpGatewayError.fromSignal("UNSUPPORTED_PROTOCOL_VERSION"), requestId));
    }

    const identity = await resolveAgentIdentity(request.headers.authorization);
    if (!identity.ok) {
      return reply
        .status(200)
        .send(formatMcpErrorResponse(McpGatewayError.fromSignal("IDENTITY_INVALID"), requestId));
    }

    // Day 3 wires tools/list; Day 4 wires tools/call. Both consume
    // identity.identity.{agentId,tenantId} and request.abortController,
    // both fully ready as of today.
    return reply.status(200).send({
      jsonrpc: "2.0",
      id: requestId,
      result: { _placeholder: "identity resolved — Day 3/4 continue the pipeline" },
    });
  });

  app.get("/", async (_request, reply) => {
    return reply.status(405).header("Allow", "POST").send({
      statusCode: 405,
      error: "Method Not Allowed",
      message: "GET is not supported on the MCP gateway endpoint. Use POST.",
    });
  });
}