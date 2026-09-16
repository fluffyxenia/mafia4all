export type ParsedInput =
  | { kind: "empty" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "view" }
  | { kind: "chat_shorthand"; message: string }
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "error"; message: string };

/** Splits "<mechanical args> -- <reasoning>" into its two halves; reasoning is undefined if there's no ` -- `. */
function splitReasoning(restLine: string): { mechanical: string; reasoning?: string } {
  const sep = restLine.indexOf(" -- ");
  if (sep === -1) return { mechanical: restLine };
  return { mechanical: restLine.slice(0, sep).trim(), reasoning: restLine.slice(sep + 4).trim() };
}

/** Pure parser for one line of CLI input — kept free of I/O so it's directly unit-testable. */
export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "chat_shorthand", message: trimmed };

  const body = trimmed.slice(1);
  const firstSpace = body.indexOf(" ");
  const cmd = firstSpace === -1 ? body : body.slice(0, firstSpace);
  const restLine = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();

  switch (cmd) {
    case "help":
      return { kind: "help" };
    case "quit":
    case "exit":
      return { kind: "quit" };
    case "view":
    case "state":
      return { kind: "view" };
    case "pass":
      return { kind: "tool", tool: "pass", args: {} };
    case "chat": {
      const parts = restLine.length > 0 ? restLine.split(/\s+/) : [];
      const [channel, ...msgParts] = parts;
      if (!channel || msgParts.length === 0) {
        return { kind: "error", message: "usage: /chat <channel> <message>" };
      }
      return { kind: "tool", tool: "send_chat", args: { channel, message: msgParts.join(" ") } };
    }
    case "ping": {
      const parts = restLine.length > 0 ? restLine.split(/\s+/) : [];
      const [target, ...msgParts] = parts;
      if (!target || msgParts.length === 0) {
        return { kind: "error", message: "usage: /ping <playerId> <message>" };
      }
      return { kind: "tool", tool: "ping_player", args: { targetPlayerId: target, message: msgParts.join(" ") } };
    }
    case "vote": {
      const { mechanical, reasoning } = splitReasoning(restLine);
      const [target] = mechanical.length > 0 ? mechanical.split(/\s+/) : [];
      if (!target) {
        return {
          kind: "error",
          message: "usage: /vote <playerId|abstain|request_more_messages> [-- reasoning]",
        };
      }
      return { kind: "tool", tool: "cast_vote", args: { target, ...(reasoning ? { reasoning } : {}) } };
    }
    case "action": {
      const { mechanical, reasoning } = splitReasoning(restLine);
      const [actionType, targetPlayerId] = mechanical.length > 0 ? mechanical.split(/\s+/) : [];
      if (!actionType) return { kind: "error", message: "usage: /action <actionType> [targetPlayerId] [-- reasoning]" };
      return {
        kind: "tool",
        tool: "night_action",
        args: {
          actionType,
          ...(targetPlayerId ? { targetPlayerId } : {}),
          ...(reasoning ? { reasoning } : {}),
        },
      };
    }
    case "revenge": {
      const { mechanical, reasoning } = splitReasoning(restLine);
      const [target] = mechanical.length > 0 ? mechanical.split(/\s+/) : [];
      if (!target) return { kind: "error", message: "usage: /revenge <playerId> [-- reasoning]" };
      return { kind: "tool", tool: "jester_revenge", args: { targetPlayerId: target, ...(reasoning ? { reasoning } : {}) } };
    }
    default:
      return { kind: "error", message: `unknown command: /${cmd} (try /help)` };
  }
}
