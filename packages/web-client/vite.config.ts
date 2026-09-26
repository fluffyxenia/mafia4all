import { defineConfig } from "vite";

// Lets the dev server and the mcp-server share one externally-reachable
// port (e.g. for SSH port-forwarding, where only one port at a time is
// practical): the browser talks only to Vite, which proxies /mcp/* through
// to the real game server over plain localhost — no second port to expose.
const mcpServerPort = process.env.MCP_SERVER_PORT ?? "8787";

export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    proxy: {
      "/mcp": `http://localhost:${mcpServerPort}`,
      "/admin": `http://localhost:${mcpServerPort}`,
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: "index.html",
        host: "host.html",
        replay: "replay.html",
      },
    },
  },
});
