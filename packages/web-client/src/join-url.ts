/**
 * Accepts either a full join URL or a bare token pasted on its own — the
 * latter always resolves against `origin`, which is safe here because
 * dev.mjs's Vite proxy means the MCP server is never reachable at a
 * different origin than the web client itself (see dev.mjs's doc comment).
 */
export function resolveJoinUrl(input: string, origin: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    try {
      return new URL(`/mcp/${input}`, origin);
    } catch {
      return undefined;
    }
  }
}
