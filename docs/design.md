# Mafia For All — Implementation Plan

## Context

The repo currently contains only a README describing a Mafia/Werewolf social-deduction
game. The goal is to build a minimal, lean engine where AI models (via OpenRouter's
free-tier models and local llama.cpp) and humans play together as equal players, with
the game exposed as an MCP server so "player" is a uniform interface regardless of who
or what is behind it. Two other agent frameworks (openclaw, ggmlagent) will be wired in
later — nothing is being built for them now, but the MCP interface must be a natural
integration point.

Hard constraint: client hardware includes Chromebooks and Raspberry Pis with as little
as 512MB RAM. Resolution: cleanly separate the **server** (all game state, MCP server,
LLM orchestration — runs on a normal host, not memory-constrained) from **clients**
(thin, ~30-50MB RSS budget, fine for Node). Two client types are required: a CLI
(SSH/terminal-safe fallback) and a Three.js web client (spectating/config/play, minimal
blocky voxel characters that bob/jump when speaking).

Timers are message-count-based per player per phase, not wall-clock — confirmed by the
user, since free-tier OpenRouter models have unpredictable latency and a wall clock
would unfairly punish slower models.

## Repo layout

pnpm workspaces, plain `tsc --build` project references (no Turborepo/Nx — keep tooling
minimal):

```
/home/foxo/mafia
  package.json, pnpm-workspace.yaml, tsconfig.base.json
  packages/
    shared/       @mafia/shared     — wire types & zod schemas (Role, Faction, Phase,
                                       ChannelId, MCP tool I/O DTOs)
    engine/       @mafia/engine     — pure game logic, zero I/O, unit-testable.
                                       Highest-risk package, built and hardened first.
    mcp-server/   @mafia/mcp-server — long-running process: lobby/game creation,
                                       session auth, wraps engine, exposes MCP over
                                       Streamable HTTP, per-connection role-scoped
                                       tools/resources.
    ai-player/    @mafia/ai-player  — MCP client + pluggable LLM adapter (OpenRouter
                                       free tier, llama.cpp) + agent decision loop.
    cli-client/   @mafia/cli-client — human MCP client, plain-text REPL.
    web-client/   @mafia/web-client — Three.js MCP client (browser).
  docs/design.md  (this plan, once approved)
```

`engine` depends on nothing but `zod`. `mcp-server` depends on
`@modelcontextprotocol/sdk` + `engine` + `shared`. Clients depend on the MCP SDK's
client transports + `shared`.

## Core game engine (`packages/engine`)

**State**: `GameState { phase, dayNumber, players[], channels[], votes[], nightActions[],
drawOutCounter, requestMoreMessagesUsedToday, factionCanWin, pendingJesterRevenge?,
pendingHeartbreaks[] }`. `Player { id, displayName, role, alignment, alive,
loverPairId?, abilityCharges, connectionToken }`.
`Phase = 'lobby' | 'night' | 'day_discussion' | 'day_vote' | 'jester_revenge_subphase' |
'post_game'`.

Engine is a pure reducer: `applyCommand(state, command) -> { state, events }`. No
timers, no network, no unseeded randomness (deterministic for tests/replays).

**Turn-budget module** (`turn-budget.ts`): per-player per-phase message caps —
5/day-discussion, 2/lover-night-chat (both from README), 6/night as a default cap for
Mafia and Deep-Diver chat (unspecified in README, given a cap purely so nothing is
literally unbounded with no wall-clock backstop). Ping replies consume a free credit
issued to the *pinged* player, not the pinger. "Request more messages" is a third
day-vote option; if it wins plurality, the day resets into another discussion+vote round
with budgets refilled — but it can only be invoked **once per day** (per user
clarification), tracked via `requestMoreMessagesUsedToday`, and does not itself count
toward the 3-day draw-out counter.

**Night-action resolution pipeline** (`resolution/night.ts`), run once all eligible
actors have submitted or passed:
1. **Protections resolve first** — union of all Doctor/JoAT-protect targets. Per user
   clarification, Doctor/JoAT protection blocks **all** night-elimination sources
   uniformly, including Vigilante/JoAT friendly fire, not just Mafia/SK.
2. **Investigations resolve** — Sheriff, Deep-Diver(s), JoAT-investigate; read-only
   against pre-resolution state.
3. **Kills resolve simultaneously** — Mafia's collective target (each Mafia member
   proposes a target in Mafia chat; plurality wins at night's end; a tie means no Mafia
   kill), each independent SK's target, each Vigilante's target, JoAT-eliminate.
   Protected target → that specific kill fails silently, attacker gets an ambiguous
   "nothing happened" result. Multiple attackers on the same unprotected target: target
   dies once, each attacker still gets a normal success result.
4. **Death events tagged with cause** (`day_vote | mafia_kill | sk_kill:<id> |
   vigilante_kill:<id> | joat_kill | jester_revenge | heartbreak`) — drives Tanner/Jester
   branching.
5. **Per-role `onEliminated` hooks** fire per death event in order, applying the
   README's outcome tables — including the confirmed fix that **Tanner (not Jester)
   loses when killed by Vigilante or JoAT**, game continues, symmetric with Jester's own
   vig/JoAT-kill rule. Also confirmed: killing a Tanner **boomerangs literally** — a
   Mafia night-kill on a Tanner eliminates the *entire* Mafia faction (not just a
   forfeit), and an SK's kill on a Tanner eliminates that specific SK, both queued as
   `tanner_boomerang` follow-up deaths in the same resolution pass. The game still
   continues afterward if another threat (a second SK, etc.) remains alive.
6. **Heartbreak scheduling** — any Lover death (day or night) schedules the surviving
   partner's death within the same resolution pass, broadcast publicly (bypassing normal
   night-channel privacy per the README's explicit carve-out), applied immediately so
   it's reflected in the next roster/vote math.
7. **Win-condition evaluator runs after every mutation** (day-vote elimination,
   jester-revenge sub-resolution, full night resolution) — not just once at phase end,
   since a heartbreak death mid-resolution can itself flip a win/loss.

**Win-condition evaluator** (`win-conditions.ts`), pure function over state + events:
- Town-aligned tally = {Town, Sheriff, Doctor, Vigilante, JoAT, Deep-Diver} + Lovers
  whose base role is town-aligned; hostile tally = {Mafia, Serial Killer}. Jester/Tanner
  excluded (neutral, tracked only via their own side-win triggers). Town wins when
  `hostileAlive === 0`; Town loses when `townAlignedAlive <= hostileAlive`.
- Mafia wins when zero non-Mafia-aligned survivors remain. Mafia loses when all its
  members are dead, whether from normal play or from the Tanner boomerang below.
- SK wins by being the sole survivor (README never states this explicitly; this is the
  cleanest reading of "eliminate every other player, each independent" — SKs also
  compete against each other).
- Draw-out counter increments on any day-vote phase resolving with no elimination from
  abstain/tie; resets on any elimination (including jester-revenge); "request more
  messages" does not itself count toward it. 3 in a row → everyone loses.
- Tanner/Jester elimination-cause branching implemented as literal per-cause lookup
  tables, one unit test per README bullet.
- Doctor/Deep-Diver "can't target/investigate same player twice" is enforced globally,
  per-target-per-game, shared across all instances of the role (prevents multi-actor
  stacking).
- Lovers are a `loverPairId` tag attachable to any two seated players regardless of base
  role (supports lover+other-role combos the README anticipates), assigned at
  game-setup; a Lover's win/loss always follows their base role's faction outcome.
- Day-vote ties → no elimination, counts toward draw-out counter.

**PlayerView projection** (`view.ts`): `buildPlayerView(state, playerId) -> PlayerView`
— pure function deriving exactly what one player may see (own role/faction/charges,
public alive roster, and only channels they belong to: town, mafia, `lovers:<pairId>`,
deep_divers, or their own private one-player-role night-log). Lives in `engine`, unit
tested independent of transport — this is the actual security boundary between e.g. a
Mafia session and Sheriff results.

## MCP server (`packages/mcp-server`)

One process holds a `GameRuntime` (map of active `GameState`s), exposes MCP over
**Streamable HTTP** (not stdio — need many independent, possibly remote players sharing
one game). Each player connects with a join token mapped to a `playerId`; each session
gets its own `McpServer` instance wired to the shared `GameRuntime`, with
role-and-phase-scoped tool/resource registration rebuilt on every action-availability
change, pushed via `notifications/tools/list_changed`.

Tool visibility is a convenience for LLM function-calling, **never the security
boundary** — every handler re-validates phase/role/alive-status/ability-charges/turn-
budget server-side using the same engine command validators the reducer uses, so a
misbehaving AI client calling an "invisible" tool gets a clean rejection, not a leak.

Tools: `send_chat(channel_id, message, reply_to_ping_id?)`,
`ping_player(target_player_id, message)` (issues a free-reply credit),
`cast_vote(target_player_id | "abstain" | "request_more_messages")` (day-vote only,
`request_more_messages` capped at once/day), `night_action(action_type,
target_player_id?)` (action_type validated against caller's role: `mafia_kill`,
`sheriff_investigate`, `doctor_protect`, `deep_diver_investigate`, `sk_kill`,
`vigilante_kill`/`hold`, `joat_investigate`/`joat_protect`/`joat_eliminate`),
`jester_revenge(target_player_id)` (revenge sub-phase only, restricted to that day's
voters against the Jester), `pass()`. Separate host-only lobby tools: `create_game`,
`configure_roles`, `start_game`.

Resources (filtered through `buildPlayerView`): `mafia://game/{id}/state`,
`mafia://game/{id}/channels/{channelId}`, `mafia://game/{id}/players`,
`mafia://game/{id}/transcript` (post-game only, full unredacted log per the README's
explicit reveal-everything rule).

One addition beyond pure spec: a real-seconds **liveness safety timeout** that
auto-passes an unresponsive player (crashed backend, dropped connection) — otherwise a
single hung LLM call freezes the whole game, since pacing is purely budget/pass-driven
with no wall clock as backstop.

## LLM adapter layer (`packages/ai-player`)

```ts
interface LlmAdapter {
  complete(request: { systemPrompt, messages, tools }): Promise<{ toolCall?, text? }>
}
```
`OpenRouterAdapter` (targets `openrouter/free`-slug models) and `LlamaCppAdapter`
(OpenAI-compatible local HTTP API) both implement it — pluggable for future backends,
and the natural seam for openclaw/ggmlagent later without building anything for them
now.

**Agent loop**: read current `PlayerView` resource → build a role-specific system prompt
(one template per role, straight from the README) → call the adapter with visible tool
schemas → parse the tool call → invoke via MCP client → repeat on the next
phase/turn notification.

## CLI and web clients

**CLI**: real MCP client, plain `readline` line-oriented REPL (not full-screen
curses/blessed — cheaper RSS/CPU, behaves better over laggy SSH on constrained
devices).

**Web**: Three.js scene, flat ground plane, one low-poly blocky avatar per player (two
`BoxGeometry` cuboids — body + head, `MeshLambertMaterial`, one directional light, no
shadows/postprocessing/GLTF, capped `devicePixelRatio`) that bobs/scales when that
player's channel updates. Talks to the server's Streamable HTTP endpoint via the MCP
SDK's browser transport, reusing the same tool calls as the CLI client; adds a
lobby/config UI on top.

## Build sequence

- **M1 — Engine core**: state machine, role rules, night-resolution pipeline,
  win-condition evaluator (every README branch — including the confirmed Tanner/vig
  fix and the JoAT three-tool kit — as a named unit test), turn-budget module,
  jester-revenge sub-phase, heartbreak scheduling, request-more-messages once-per-day
  cap. No I/O. Nearly all rules risk lives here.
- **M2 — MCP server + scripted-stub integration tests**: lobby/session/auth, per-role
  tool/resource scoping, Streamable HTTP wiring, notifications. Drive full games
  end-to-end with canned deterministic scripted MCP clients (Town win, Mafia win,
  Tanner day-vote win, SK solo win, draw-out loss) to validate the whole request path.
- **M3 — CLI client**: first fully human-playable milestone, human vs. scripted stubs.
- **M4 — AI players**: LLM adapter + agent loop wired to OpenRouter free tier and
  llama.cpp, replacing stubs; mixed human+AI games.
- **M5 — Web client**: spectator rendering first, then interactive controls.
- **M6 (stretch)**: game-setup config UI, resilience polish, replay/transcript export,
  docs for future openclaw/ggmlagent MCP integration, player memory/journal (each
  player — model or human — maintains a running journal that's summarized/pruned over
  time like agent memory: dense recent entries, older ones consolidated, key events
  pinned; feeds into decision-making the same way the current view+reasoning context
  does). Natural seam is `describe-state.ts`, which already owns what context a player
  sees each turn.

## Confirmed rules clarifications (from user)

1. Tanner (not Jester) loses when killed by Vigilante or JoAT — README line 60 was a
   copy/paste typo.
2. JoAT's three one-shot tools: Investigate (Sheriff-style), Protect (Doctor-style),
   Eliminate (Vigilante-style).
3. "Request more messages" (renamed from "request more time"): a day-vote option that,
   if it wins plurality, extends the current day with refilled turn budgets. Usable
   **once per day** only.
4. Doctor/JoAT protection blocks all night-elimination sources uniformly, including
   Vigilante/JoAT friendly fire on a protected player.
5. Killing a Tanner boomerangs literally: a Mafia kill on a Tanner eliminates the whole
   Mafia faction, and an SK kill on a Tanner eliminates that SK — not a mere forfeit.
   The game continues afterward if another threat is still alive.

## Judgment calls adopted as sensible defaults (flagged for visibility, not re-asked)

- SK wins by being the sole survivor.
- Day-vote ties → no elimination, counts toward the 3-strike draw-out counter.
- Doctor/Deep-Diver target/investigate restrictions are global per-target-per-game
  (shared across multiple doctors/divers), not per-actor.
- Mafia's kill target is decided by plurality of proposals visible in Mafia chat; a tie
  means no kill that night.
- Town-aligned tally for the numeric win/loss check: Town, Sheriff, Doctor, Vigilante,
  JoAT, Deep-Diver, and town-aligned Lovers; hostile tally: Mafia, Serial Killer;
  Jester/Tanner excluded (neutral).
- Lovers are a tag (`loverPairId`) attachable to any two players regardless of base
  role, not a standalone role slot; a Lover's win/loss follows their base role.

These will all be visible as named tests in M1 — flag any of them at that point if they
don't match your intent, before AI/CLI/web work builds on top of the engine.

## Verification

- `packages/engine`: `vitest` unit suite — one test per README rule/branch (role
  actions, night-resolution conflicts, all Tanner/Jester elimination-cause branches,
  draw-out, heartbreak, request-more-messages cap, JoAT triple-kit). This package alone
  should reach near-total behavioral coverage since it's pure and I/O-free.
- `packages/mcp-server`: integration tests using scripted in-process MCP clients driving
  full games to each of the five target end-states (Town win, Mafia win, Tanner
  day-vote win, SK solo win, draw-out loss), asserting final `GameState` and that each
  session only ever saw channels/resources it was entitled to.
- `packages/cli-client`: manual smoke test — run the CLI against a running dev
  `mcp-server`, play one full game as a human against scripted stub opponents.
- `packages/ai-player`: manual run against OpenRouter free-tier models and a local
  llama.cpp server, confirm the agent loop completes valid tool calls across a full
  game without crashing on malformed/unexpected model output.
- `packages/web-client`: manual browser check — spectate a running game, confirm
  avatars render and bob on chat activity, confirm it stays usable on a throttled
  CPU/low-end profile in devtools (proxy for Chromebook/Pi target hardware).
