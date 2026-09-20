/** A standard MCP text content block. */
export interface TextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

/** Wrap a string in MCP's content envelope. */
export function textResult(s: string): { content: TextContent[] } {
  return { content: [{ type: "text", text: s }] };
}

/** Serialize a JSON-friendly object as a fenced JSON block. */
export function jsonResult(o: unknown): { content: TextContent[] } {
  return textResult("```json\n" + JSON.stringify(o, null, 2) + "\n```");
}

/** Truncate body text safely for tool output. Default 600 chars. */
export function snippet(body: string | undefined, max = 600): string | undefined {
  if (!body) return undefined;
  if (body.length <= max) return body;
  return body.slice(0, max) + "\n…[truncated]";
}
