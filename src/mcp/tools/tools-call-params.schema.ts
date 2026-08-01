import { z } from "zod";

/**
 * The MCP tools/call params shape: {name, arguments?}.
 * z.record's two-argument form (key schema + value schema) is required
 */
export const toolsCallParamsSchema = z.object({
  name: z.string().min(1, "Tool name is required"),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

export type ToolsCallParams = z.infer<typeof toolsCallParamsSchema>;