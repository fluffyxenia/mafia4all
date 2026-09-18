# BUGREPORT: `/admin` has no auth and is reachable wherever the game itself is reachable

**Filed:** 2026-09-18
**Status:** fixed 2026-09-18 — see "Fix shipped" at the bottom
**Scope note:** mafia4all's stated trust model is "AIs and trusted friends/players," not strangers on the open internet. Given that, this is **not an urgent must-fix**, but it's worth documenting precisely because it changes what "safe to expose" actually means for this project, and it's the thing that would need fixing first if the trust radius ever widens (remote friends over the internet, semi-trusted players, or the bring-your-own-AI feature discussed in `docs/design.md`).

## Summary

`packages/mcp-server/src/http-server.ts` mounts the host-console API at `/admin` with an explicit, intentional "no auth" comment:

```
// Host-console-only: create/start/inspect/stop games. No auth beyond
// "can reach this port" — same trust boundary as running this server at
// all, since it's meant for the host's own machine, not public exposure.
app.use("/admin", createAdminRouter(runtime, `http://localhost:${port}`));
```

The stated safety assumption is that only the host's own machine can reach this port. That assumption doesn't hold as written:

- `packages/mcp-server/src/cli.ts:46` calls `app.listen(port, () => ...)` with **no host argument** — Node/Express default to binding all interfaces (`0.0.0.0`), not `127.0.0.1`.
- `docs/design.md:139` states the design intent directly: *"need many independent, possibly remote players sharing"* the server. Remote players joining via `/mcp/:token` links is the whole point of the HTTP transport choice (`design.md:138-139` picked Streamable HTTP over stdio specifically for this).
- `/admin` and `/mcp/:token` are mounted on the exact same `express()` app and the exact same listener (`http-server.ts:16-32`). There is no separate bind, port, or network restriction between them.

**Net effect: anyone who can reach the game's join links can also reach `/admin`, full stop.** Any friend given a `/mcp/<token>` URL for a LAN game, or any remote friend for whom the host has port-forwarded/tunneled the server so they can join at all, has the same network access to `POST /admin/games`, `POST /admin/games/:id/stop`, etc. as the host does. The comment describes a boundary the code does not actually enforce.

## What `/admin` access actually grants

From `packages/mcp-server/src/admin.ts`:

- `POST /admin/games` — create an arbitrary new game with arbitrary seats, including AI seats. For each AI seat with `ai.backend === "llamacpp"`, `spawnAiSeat()` (`admin.ts:58-79`) runs:
  ```ts
  spawn(process.execPath, [AI_PLAYER_CLI, joinUrl, "--backend=llamacpp", `--base-url=${ai.baseUrl}`, ...], { stdio: "inherit" })
  ```
  This is a **real child process spawned on the host's own machine**, which then makes real outbound HTTP requests to whatever `baseUrl` was supplied (via `packages/ai-player/src/llm/openai-compatible.ts`).
- `POST /admin/games/:id/stop` — kill any in-progress game's AI processes (host-only denial-of-service, from anyone who can reach the port).
- `GET /admin/games/:id` — read a game's live state.

Two separate findings fall out of this:

### Finding 1 (present-day, concrete): unauthenticated admin control alongside player access
Today, with zero new features, anyone with a join link for a LAN or port-forwarded game can also drive `/admin` directly — create games, spawn AI seats, or kill the host's running game — none of which requires any special knowledge beyond "guess or read off the same host:port the join link uses." In a genuinely trusted-friend-group setting the practical risk is low (nobody's expected to misuse it), but it's not a designed permission boundary, it's an absence of one, and it will surprise anyone who reads the comment at face value.

### Finding 2 (mechanism exists today, risk is conditional): SSRF via `ai.baseUrl`
`spawnAiSeat` accepts `ai.baseUrl` with no validation and hands it straight to a child process that fetches it. This is **SSRF-shaped (arbitrary server-side outbound fetch), not RCE** — `spawn()` here is called with an argv array, never a shell string, so a hostile `baseUrl` value cannot achieve shell/command injection. The actual risk is that whoever can reach `/admin` can make the host's own machine issue HTTP requests to any address they choose: internal LAN services, `localhost`-bound admin panels, cloud metadata endpoints if the host is ever cloud-hosted, etc.

This is a non-issue for a solo host launching their own games (they're only pointing the fetch at addresses they already trust). It becomes a real issue the moment `ai.baseUrl` (or the model slug for OpenRouter) is populated from a *player's* input rather than the host's own config — i.e., exactly the "bring-your-own-AI" feature under discussion. That feature is not built yet; this note is so the auth gap on `/admin` doesn't get forgotten if/when it is.

## Reproduction

1. Start the server for a LAN or port-forwarded game: `mafia-server [config] [port]`.
2. From any other machine that can reach `<host>:<port>` (including any player who has a join link and can therefore reach that host:port), send:
   ```
   curl -X POST http://<host>:<port>/admin/games \
     -H 'content-type: application/json' \
     -d '{"seats":[{"playerId":"p1","displayName":"x","ai":{"backend":"llamacpp","baseUrl":"http://<attacker-chosen-address>/v1"}}],"roleDistribution":{...}}'
  ```
3. The server accepts it with no authentication and spawns the AI seat as described above.

## Recommended fix (proportionate to the stated trust model — no need for a full auth system)

- **Minimum:** bind the listener to `127.0.0.1` by default (`app.listen(port, "127.0.0.1", ...)` in `cli.ts`), and require an explicit opt-in flag (e.g. `--bind=0.0.0.0`) for anyone who deliberately wants the whole app reachable beyond localhost. This alone closes Finding 1 for the common case (LAN/tunnel exposes `/mcp` via a reverse proxy or explicit port-forward, while `/admin` stays local) — though note a naive port-forward of the whole listener still exposes both together, so this is a default-safety improvement, not a hard guarantee.
- **Better:** give `/admin` its own listener/port, separate from the player-facing `/mcp` routes, so a host can forward one without the other.
- **If/when bring-your-own-AI ships:** whatever new endpoint accepts player-supplied `baseUrl`/model values needs its own validation independent of the auth fix above — auth answers "who can call this," not "is this URL safe to fetch." At minimum, deny loopback/link-local/private ranges when the value didn't come from the host's own trusted config, and consider requiring that fetch to happen from the *player's own* client rather than server-side, to keep the blast radius off the host's machine entirely.

## Non-issues explicitly ruled out

- **Not command/shell injection.** `admin.ts`'s `spawn()` call uses an argv array; a `baseUrl` containing shell metacharacters is passed as a single literal argument, never interpreted by a shell.
- **Not exploitable by strangers on the open internet by default**, since nothing here is exposed unless the host chooses to forward/tunnel the port — but see Finding 1: exposing the game to *any* remote player, including trusted ones, currently exposes `/admin` too, which is a stronger claim than "meant for the host's own machine" suggests.

## Fix shipped

Both parts of "Recommended fix" (minimum) implemented in `packages/mcp-server/src/cli.ts`, `http-server.ts`, and `admin.ts`, plus a token check beyond what was originally recommended:

- `cli.ts` now parses a `--bind=<host>` flag and defaults to `127.0.0.1` (was: no host arg, i.e. `0.0.0.0`). Existing LAN/remote setups need to add `--bind=0.0.0.0` (or a specific LAN/public address) explicitly going forward.
- Whenever the bind host isn't loopback (`127.0.0.1`/`localhost`/`::1`), `cli.ts` generates a random admin token (`randomBytes(24).toString("hex")`) and prints it once at startup. `createAdminRouter` (via a new optional `adminToken` param threaded through `createHttpApp`) then requires that exact value in an `x-admin-token` header on every `/admin/*` request, 401ing otherwise. On the default loopback bind, no token is required — the original trust assumption ("reaching this port at all means it's the host's own machine") is actually true there, so a token would be pure friction with no real boundary crossed.
- Finding 2 (SSRF via `ai.baseUrl`) is **not** addressed by this fix — it remains a live TODO for whenever the bring-your-own-AI feature accepts player-supplied URLs, per the original recommendation above.

Verified live: default bind rejects nothing extra (admin reachable with no token, same as before, on `127.0.0.1`); `--bind=0.0.0.0` prints a token and returns 401 on `/admin/games` without it, 200-path (past auth, into normal request validation) with it.
