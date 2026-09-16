#!/usr/bin/env node
// One-command launcher: builds every workspace package, starts the
// mcp-server on an internal port, and starts the web-client's Vite dev
// server proxying to it on the one externally-reachable port (5173) — the
// SSH-single-port setup this project targets. Rewrites the mcp-server's
// printed join URLs to go through that proxy port so they're pasteable
// straight into the web client with no manual port-juggling.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Minimal dotenv-style loader for repo-root `.env` (KEY=value per line, "#"
 * comments, blank lines ignored) — keeps secrets like OPENROUTER_API_KEY out
 * of shell history/scrollback instead of exporting them inline before every
 * launch. Real environment variables always win over the file, so
 * `OPENROUTER_API_KEY=... pnpm dev` still overrides it per-invocation.
 */
function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const vars = {};
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

const dotEnv = loadDotEnv(path.join(rootDir, ".env"));
const spawnEnv = { ...dotEnv, ...process.env };

if (!spawnEnv.OPENROUTER_API_KEY) {
  console.warn(
    "Note: OPENROUTER_API_KEY isn't set (checked .env and the environment) — any OpenRouter-backed AI seat " +
      "the host console creates will fail immediately and silently drop out of the game. Add it to .env if you " +
      "plan to use OpenRouter seats.",
  );
}
const args = process.argv.slice(2);
// `pnpm dev --console` skips the sample config entirely and starts the
// mcp-server empty, ready for the host console (host.html) to create games
// via /admin/games instead of one baked in ahead of time.
const consoleMode = args[0] === "--console";
const configPath = consoleMode ? undefined : path.resolve(rootDir, args[0] ?? "scripts/sample-game.json");
const mcpPort = Number(args[1] ?? 8787);
const webPort = 5173;

if (configPath && !existsSync(configPath)) {
  console.error(`Game config not found: ${configPath}`);
  console.error("Usage: pnpm dev [game-config.json] [mcp-port]");
  console.error("       pnpm dev --console [mcp-port]   (start empty, use the host console)");
  process.exit(1);
}

console.log("Building workspace packages...");
const build = spawnSync("pnpm", ["build"], { cwd: rootDir, stdio: "inherit" });
if (build.status !== 0) {
  console.error("Build failed — not starting servers.");
  process.exit(build.status ?? 1);
}

const children = [];
function spawnTagged(name, command, cmdArgs, options, onLine) {
  const child = spawn(command, cmdArgs, { cwd: rootDir, ...options });
  children.push(child);
  const tag = `[${name}]`;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    console.log(tag, line);
    onLine?.(line);
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => console.error(tag, line));
  child.on("exit", (code) => {
    console.log(`${tag} exited with code ${code}`);
    shutdown();
  });
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const joinUrlPattern = new RegExp(`http://localhost:${mcpPort}(/mcp/[\\w-]+)`);
const mcpServerArgs = [path.join("packages/mcp-server/dist/cli.js")];
if (configPath) mcpServerArgs.push(configPath);
mcpServerArgs.push(String(mcpPort));
spawnTagged("mcp-server", "node", mcpServerArgs, { stdio: ["ignore", "pipe", "pipe"], env: spawnEnv }, (line) => {
  const match = line.match(joinUrlPattern);
  if (match) console.log(`  -> open: http://localhost:${webPort}/?join=http://localhost:${webPort}${match[1]}`);
});

if (consoleMode) {
  console.log(`\nHost console: http://localhost:${webPort}/host.html\n`);
}

// Invoked directly (not via `pnpm --filter ... dev --`) because pnpm's
// script-passthrough was observed inserting an extra literal "--" before
// these args, which Vite's CLI parser (cac) treats as an end-of-options
// marker — silently swallowing --strictPort and letting Vite fall back to
// a different port instead of failing loudly, which then makes every
// printed join URL wrong.
const viteBin = path.join(rootDir, "packages/web-client/node_modules/.bin/vite");
spawnTagged("web-client", viteBin, ["--port", String(webPort), "--strictPort"], {
  cwd: path.join(rootDir, "packages/web-client"),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...spawnEnv, MCP_SERVER_PORT: String(mcpPort) },
});
