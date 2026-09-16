import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const urls = {
  p1: "http://localhost:8790/mcp/b03d21e1-f877-4d59-b1e5-9d62128f54d0", // Alice, town
  p4: "http://localhost:8790/mcp/61fbccf0-512e-44c1-a636-f5f2afdf6853", // Dan, town
  p5: "http://localhost:8790/mcp/bfe26a8f-3a73-4631-a896-5ed765310166", // Eve, mafia
};

async function connect(id) {
  const client = new Client({ name: `${id}-stub`, version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(urls[id])));
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) console.error(`${name} failed:`, result.content?.[0]?.text);
  return result;
}
async function view(client) {
  const r = await client.readResource({ uri: "mafia://me/view" });
  return JSON.parse(r.contents[0].text);
}

const alice = await connect("p1");
const dan = await connect("p4");
const eve = await connect("p5");

await call(eve, "night_action", {
  actionType: "mafia_kill_proposal",
  targetPlayerId: "p1",
  reasoning: "Alice's the easiest read so far, starting there.",
});
console.log("stubs: Eve (mafia) has acted. Waiting on night to resolve...");

async function autoPassLoop(client, id) {
  let lastKey = "";
  while (true) {
    const v = await view(client);
    if (v.phase === "post_game") {
      console.log(`${id}: game over`);
      return;
    }
    if (!v.self.alive) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const key = `${v.phase}:${v.dayNumber}`;
    if (key !== lastKey) {
      if (v.phase === "night" || v.phase === "day_discussion") {
        await call(client, "pass", {});
        lastKey = key;
        console.log(`${id}: passed for ${key}`);
      } else if (v.phase === "day_vote") {
        await call(client, "cast_vote", { target: "abstain" });
        lastKey = key;
        console.log(`${id}: abstained for ${key}`);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

await Promise.all([autoPassLoop(alice, "p1/Alice"), autoPassLoop(dan, "p4/Dan"), autoPassLoop(eve, "p5/Eve")]);
