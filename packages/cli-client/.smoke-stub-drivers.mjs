import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [, , bobUrl, caraUrl, danUrl] = process.argv;

async function connect(url, name) {
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return result;
}

async function view(client) {
  const result = await client.readResource({ uri: "mafia://me/view" });
  return JSON.parse(result.contents[0].text);
}

async function waitForPhase(client, phase, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await view(client);
    if (v.phase === phase) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for phase ${phase}`);
}

const bob = await connect(bobUrl, "sheriff-stub"); // p2 sheriff
const cara = await connect(caraUrl, "mafia-stub"); // p3 mafia
const dan = await connect(danUrl, "doctor-stub"); // p4 doctor

await call(dan, "night_action", { actionType: "doctor_protect", targetPlayerId: "p1" });
await call(cara, "night_action", { actionType: "mafia_kill_proposal", targetPlayerId: "p1" });
await call(bob, "night_action", { actionType: "sheriff_investigate", targetPlayerId: "p3" });
console.log("stub-drivers: night 1 actions submitted");

await waitForPhase(bob, "day_discussion");
await call(bob, "pass", {});
await call(cara, "pass", {});
await call(dan, "pass", {});
console.log("stub-drivers: passed discussion, waiting for the human to pass/exhaust their turns too");

await waitForPhase(bob, "day_vote");
await call(bob, "cast_vote", { target: "p3" });
await call(dan, "cast_vote", { target: "p3" });
await call(cara, "cast_vote", { target: "abstain" });
console.log("stub-drivers: votes cast");

const final = await waitForPhase(bob, "post_game");
console.log("stub-drivers: game over ->", JSON.stringify(final.winner));
