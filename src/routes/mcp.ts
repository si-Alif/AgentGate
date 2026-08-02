import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { isOriginAllowed } from "../mcp/http/origin-validator.js";
import { checkRateLimitByNameSpace } from "../lib/rate-limiter.js";
import { env } from "../config/env.js";
import { jsonRpcEnvelopeShapeSchema, mcpRequestEnvelopeSchema } from "../mcp/schemas/mcp-envelope.schema.js";
import { McpGatewayError, formatMcpErrorResponse } from "../mcp/errors/mcp-error-taxonomy.js";
import { resolveAgentIdentity } from "../mcp/auth/mcp-auth-resolver.js";
import { createRequestAbortController } from "../mcp/lifecycle/request-abort.js";
import { parseApiKey } from "../lib/api-key.js";

import { handleToolsList } from "../mcp/tools/tools-list-handler.js";
import { handleToolsCall } from "../mcp/tools/tools-call-handler.js";


const MESSAGE_RATE_NAMESPACE = "mcp-msg";

function deriveCoarseRateLimitKey(request: FastifyRequest): string {
  const authHeader = request.headers.authorization;
  let identity = `ip:${request.ip}`;
  if (authHeader?.startsWith("Bearer ")) {
    const parsed = parseApiKey(authHeader.slice("Bearer ".length).trim());
    if (parsed) identity = `keyid:${parsed.keyId}`;
  }

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
  app.decorateRequest("abortController" , null);

  // every response leaving THIS scope is JSON-RPC
  // shaped, including genuinely unexpected exceptions and Fastify's
  // own body-parser failures. Distinct from app.ts's REST-scoped
  // handler; Fastify's plugin encapsulation makes this safe.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "Unhandled error in MCP gateway");
    const requestId = extractRequestId(request.body);

    if (error instanceof McpGatewayError) {
      return reply.status(200).send(formatMcpErrorResponse(error, requestId));
    }

    if (error.statusCode !== undefined && error.statusCode < 500) {
      // A client-side failure Fastify itself rejected before the
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

  // Origin + coarse rate-limit are header-only checks;
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

  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST") return;
    const controller = new AbortController();

    // Listen to reply.raw (the socket connection) instead of request.raw.
    // request.raw "close" fires prematurely as soon as the request body finishes uploading.
    reply.raw.once("close", () => {
      // If the socket closes and the response hasn't been sent or finished yet,
      // the client disconnected prematurely mid-flight.
      if (!reply.sent && !reply.raw.writableEnded) {
        controller.abort();
      }
    });

    request.abortController = controller;
  });

  app.post("/", async (request, reply) => {
    const requestStart = performance.now();
    const requestReceivedAt = new Date();

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

    const method = versionResult.data.method;

    if (method === "tools/list") {
      const listResult = await handleToolsList(identity.identity);
      return reply.status(200).send({
        jsonrpc: "2.0",
        id: requestId,
        result: listResult,
      });
    }

    if (method === "tools/call") {
      const mcpNameHeader = request.headers["mcp-name"];
      const callResult = await handleToolsCall(
        identity.identity,
        versionResult.data.params,
        requestStart,
        request.abortController!.signal,
        typeof mcpNameHeader === "string" ? mcpNameHeader : undefined,
        requestReceivedAt
      );
      return reply.status(200).send({ jsonrpc: "2.0", id: requestId, result: callResult });
    }

    // Day 4 adds "tools/call" here. Anything else is genuinely unknown.
    return reply
      .status(200)
      .send(formatMcpErrorResponse(McpGatewayError.fromSignal("METHOD_NOT_FOUND"), requestId));
  });

  app.get("/", async (_request, reply) => {
    return reply.status(405).header("Allow", "POST").send({
      statusCode: 405,
      error: "Method Not Allowed",
      message: "GET is not supported on the MCP gateway endpoint. Use POST.",
    });
  });
}