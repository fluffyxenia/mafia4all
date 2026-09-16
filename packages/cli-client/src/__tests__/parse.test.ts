import { describe, expect, it } from "vitest";
import { parseInput } from "../parse.js";

describe("parseInput", () => {
  it("treats a bare line as chat shorthand", () => {
    expect(parseInput("hello everyone")).toEqual({ kind: "chat_shorthand", message: "hello everyone" });
  });

  it("treats an empty/whitespace line as a no-op", () => {
    expect(parseInput("   ")).toEqual({ kind: "empty" });
  });

  it("parses /chat into a send_chat tool call", () => {
    expect(parseInput("/chat town let's vote out p2")).toEqual({
      kind: "tool",
      tool: "send_chat",
      args: { channel: "town", message: "let's vote out p2" },
    });
  });

  it("rejects /chat with no message", () => {
    const result = parseInput("/chat town");
    expect(result.kind).toBe("error");
  });

  it("parses /vote", () => {
    expect(parseInput("/vote p3")).toEqual({ kind: "tool", tool: "cast_vote", args: { target: "p3" } });
  });

  it("parses /action with an optional target", () => {
    expect(parseInput("/action vigilante_hold")).toEqual({
      kind: "tool",
      tool: "night_action",
      args: { actionType: "vigilante_hold" },
    });
    expect(parseInput("/action doctor_protect p1")).toEqual({
      kind: "tool",
      tool: "night_action",
      args: { actionType: "doctor_protect", targetPlayerId: "p1" },
    });
  });

  it("parses /pass with no args", () => {
    expect(parseInput("/pass")).toEqual({ kind: "tool", tool: "pass", args: {} });
  });

  it("recognizes /help, /quit, /view", () => {
    expect(parseInput("/help")).toEqual({ kind: "help" });
    expect(parseInput("/quit")).toEqual({ kind: "quit" });
    expect(parseInput("/view")).toEqual({ kind: "view" });
  });

  it("reports an error for an unknown command", () => {
    const result = parseInput("/frobnicate");
    expect(result.kind).toBe("error");
  });

  it("parses reasoning after -- for /vote", () => {
    expect(parseInput("/vote p3 -- they've been too quiet all game")).toEqual({
      kind: "tool",
      tool: "cast_vote",
      args: { target: "p3", reasoning: "they've been too quiet all game" },
    });
  });

  it("parses reasoning after -- for /action, with and without a target", () => {
    expect(parseInput("/action vigilante_hold -- I'll wait and see")).toEqual({
      kind: "tool",
      tool: "night_action",
      args: { actionType: "vigilante_hold", reasoning: "I'll wait and see" },
    });
    expect(parseInput("/action doctor_protect p1 -- they've been accused twice")).toEqual({
      kind: "tool",
      tool: "night_action",
      args: { actionType: "doctor_protect", targetPlayerId: "p1", reasoning: "they've been accused twice" },
    });
  });

  it("parses reasoning after -- for /revenge", () => {
    expect(parseInput("/revenge p2 -- you voted first")).toEqual({
      kind: "tool",
      tool: "jester_revenge",
      args: { targetPlayerId: "p2", reasoning: "you voted first" },
    });
  });

  it("omits reasoning entirely when there's no -- separator", () => {
    const result = parseInput("/vote p3");
    expect(result.kind).toBe("tool");
    if (result.kind === "tool") expect(result.args.reasoning).toBeUndefined();
  });
});
