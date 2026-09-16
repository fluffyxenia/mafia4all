#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CliSession } from "./session.js";

const joinUrl = process.argv[2];
if (!joinUrl) {
  console.error("usage: mafia-cli <join-url>");
  process.exit(1);
}

const client = new Client({ name: "mafia-cli", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(joinUrl));

await client.connect(transport);

const session = new CliSession({
  client,
  input: process.stdin,
  output: process.stdout,
  onClose: () => {
    void client.close();
    process.exit(0);
  },
});

await session.start();
await client.close();
