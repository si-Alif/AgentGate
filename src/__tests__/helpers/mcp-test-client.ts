/**
 * A minimal, dependency-free JSON-RPC-over-fetch client for the MCP
 * gateway. Built specifically to avoid adding @modelcontextprotocol/sdk
 * as a new dependency on the final integration day of the week — see
 * roadmap_w6_d6.md Decision 6.1. Uses Node 22's built-in fetch only.
 *
 * Used ONLY by test files that need a genuine socket (client-disconnect,
 * cold-start-replica). Everything else in this project's test suite
 * continues to use app.inject(), unchanged.
 */

const DEFAULT_PROTOCOL_VERSION = "2026-07-28";

export interface McpEnvelopeInput {
  id?: string | number | null;
  method: string;
  params?: unknown;
  protocolVersion?: string;
}

export interface McpSendOptions {
  apiKey?: string;
  origin?: string;
  mcpName?: string;
  signal?: AbortSignal;
}

export interface McpResponse {
  status: number;
  body: any;
}

export function buildMcpEnvelope(input: McpEnvelopeInput): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: input.id ?? crypto.randomUUID(),
    method: input.method,
    params: input.params ?? {},
    _meta: { protocolVersion: input.protocolVersion ?? DEFAULT_PROTOCOL_VERSION },
  };
}

export async function sendMcpRequest(
  baseUrl: string,
  input: McpEnvelopeInput,
  options: McpSendOptions = {}
): Promise<McpResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.mcpName !== undefined) headers["mcp-name"] = options.mcpName;

  const requestInit: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(buildMcpEnvelope(input)),
  };
  if (options.signal !== undefined) requestInit.signal = options.signal;

  const res = await fetch(`${baseUrl}/mcp`, requestInit);
  const text = await res.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: res.status, body };
}