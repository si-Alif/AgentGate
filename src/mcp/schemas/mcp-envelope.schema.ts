import { z } from "zod";

/** The single protocol version this gateway understands. */
export const SUPPORTED_PROTOCOL_VERSION = "2026-07-28";

// ── JSON-RPC 2.0 envelope shape (without protocol version check) ──
const jsonRpcEnvelopeBase = z.object({
  jsonrpc: z.literal("2.0", { error: "JSON-RPC version must be exactly '2.0'" }),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1, "Method identifier cannot be empty"),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  _meta: z.object({
    protocolVersion: z.string(),
    clientCapabilities: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * Full envelope schema.
 * The protocol version is validated *after* the envelope shape, so that
 * Day 2 can distinguish a structurally invalid request (`-32600`) from
 * an unsupported protocol version (`-32011`).
 */
export const mcpRequestEnvelopeSchema = jsonRpcEnvelopeBase.refine(
  (data) => data._meta.protocolVersion === SUPPORTED_PROTOCOL_VERSION,
  { message: `Unsupported protocol version. Expected '${SUPPORTED_PROTOCOL_VERSION}'`, path: ["_meta", "protocolVersion"] }
);

export type McpRequestEnvelope = z.infer<typeof mcpRequestEnvelopeSchema>;

/**
 * Same shape but without the protocol‑version refinement, used for
 * structural validation only (to emit a distinct error code).
 */
export const jsonRpcEnvelopeShapeSchema = jsonRpcEnvelopeBase;