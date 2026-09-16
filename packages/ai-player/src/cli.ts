#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentLoop, type TurnRecord } from "./agent-loop.js";
import { OpenRouterAdapter } from "./llm/openrouter.js";
import { LlamaCppAdapter } from "./llm/llamacpp.js";
import type { LlmAdapter } from "./llm/types.js";

function usage(): never {
  console.error(
    "usage: mafia-ai-player <join-url> [--backend=openrouter|llamacpp] [--model=<slug>] [--base-url=<url>] [--timeout-ms=<ms>] [--max-tokens=<n>] [--turns-log=<path>] [--no-turns-log] [--enable-thinking=true|false] [--reasoning-effort=minimal|low|medium|high]",
  );
  process.exit(1);
}

const [, , joinUrl, ...rest] = process.argv;
if (!joinUrl) usage();

const flags = Object.fromEntries(
  rest
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value] = arg.slice(2).split("=");
      return [key, value ?? "true"];
    }),
);

const backend = flags.backend ?? (process.env.OPENROUTER_API_KEY ? "openrouter" : "llamacpp");
const timeoutMsRaw = flags["timeout-ms"] ?? process.env.MAFIA_LLM_TIMEOUT_MS;
const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : undefined;
const maxTokensRaw = flags["max-tokens"] ?? process.env.MAFIA_LLM_MAX_TOKENS;
const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : undefined;

function buildAdapter(): LlmAdapter {
  if (backend === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY must be set to use the openrouter backend.");
      process.exit(1);
    }
    return new OpenRouterAdapter({
      apiKey,
      model: flags.model ?? process.env.OPENROUTER_MODEL,
      timeoutMs,
      maxTokens,
      reasoningEffort: flags["reasoning-effort"],
    });
  }
  if (backend === "llamacpp") {
    const enableThinkingRaw = flags["enable-thinking"];
    const enableThinking = enableThinkingRaw === undefined ? undefined : enableThinkingRaw === "true";
    return new LlamaCppAdapter({
      baseUrl: flags["base-url"] ?? process.env.LLAMACPP_BASE_URL,
      timeoutMs,
      maxTokens,
      enableThinking,
    });
  }
  console.error(`unknown backend: ${backend}`);
  process.exit(1);
}

// packages/ai-player/dist/cli.js -> repo root is three levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Turns logging (including each turn's raw LLM reasoning — see
 * LlmCompleteResult.reasoning) is on by default now, not opt-in: found in
 * real testing that a pivotal moment's reasoning is unrecoverable after the
 * fact if logging wasn't explicitly enabled for that specific run, and
 * there's no good reason not to always have it. `mafialogs/` already
 * existed as the established manual convention (one file per
 * device/model); this just makes that the automatic default instead of
 * something to remember to pass. `--no-turns-log` opts back out.
 */
function defaultTurnsLogPath(): string {
  const slug = (backend === "openrouter" ? flags.model ?? process.env.OPENROUTER_MODEL : flags["base-url"] ?? process.env.LLAMACPP_BASE_URL) ?? backend;
  return path.join(repoRoot, "mafialogs", `${slug.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")}.jsonl`);
}

const turnsLogDisabled = flags["no-turns-log"] === "true";
const turnsLogPath = turnsLogDisabled ? undefined : flags["turns-log"] ?? process.env.MAFIA_TURNS_LOG ?? defaultTurnsLogPath();
if (turnsLogPath) {
  try {
    mkdirSync(path.dirname(turnsLogPath), { recursive: true });
  } catch (err) {
    console.error(`failed to create turns-log directory for ${turnsLogPath}: ${String(err)}`);
  }
}

// One JSON object per line, appended as turns happen — a training-data
// capture, deliberately separate from GameRuntime's own transcript
// snapshots (see runtime.ts), which record final state, not per-turn model
// I/O. A disk hiccup here must never take down a live game, same rationale
// as GameRuntime.persist.
function logTurn(record: TurnRecord): void {
  if (!turnsLogPath) return;
  try {
    appendFileSync(turnsLogPath, JSON.stringify({ joinUrl, loggedAt: new Date().toISOString(), ...record }) + "\n");
  } catch (err) {
    console.error(`failed to append turn record to ${turnsLogPath}: ${String(err)}`);
  }
}

const client = new Client({ name: "mafia-ai-player", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(joinUrl)));

const loop = new AgentLoop({
  client,
  llm: buildAdapter(),
  // eslint-disable-next-line no-console
  onLog: (line) => console.log(line),
  onTurn: logTurn,
});

process.on("SIGINT", () => {
  loop.stop();
});

await loop.run();
await client.close();
