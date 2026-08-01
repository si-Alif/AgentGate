/**
 * The exact MCP tool-descriptor shape returned by tools/list 
 * Deliberately three fields only: no outputSchema on
 * the wire (matches real-world MCP tool-descriptor convention and the
 * plan's own stated scope); output_schema remains an internal,
 * documentation-only column on the Tool row, never surfaced here.
 */
export interface ToolDescriptor {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export function toToolDescriptor(tool: {
  name: string;
  description: string | null;
  inputSchema: unknown;
}): ToolDescriptor {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}