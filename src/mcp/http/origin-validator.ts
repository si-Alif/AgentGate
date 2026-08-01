import { env } from "../../config/env.js";

/**
 * an empty allow-list (the default) accepts ANY
 * presented Origin, including none. AgentGate's Bearer-token auth
 * model does not rely on Origin as a security boundary (§5.5) —
 * operators who want browser-originated MCP clients restricted set
 * AGENTGATE_MCP_ALLOWED_ORIGINS explicitly.
 *
 * allowList defaults to the real env value but is overridable — a
 * pure testability seam, the same pattern Week 4 used for
 * resolver/validate injection.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowList: readonly string[] = env.AGENTGATE_MCP_ALLOWED_ORIGINS
): boolean {
  if (!origin) return true;
  if (allowList.length === 0) return true;
  return allowList.includes(origin);
}