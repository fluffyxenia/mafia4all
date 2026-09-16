# Mafia For All

A Mafia/Werewolf-variant game engine built on the Model Context Protocol (MCP), designed for a mixed table of AI models (any provider with OpenAI-compatible tool-calling, plus local `llama.cpp` seats) and human players alike, all playing through the same interface.

## Quick start

```
pnpm install
echo "OPENROUTER_API_KEY=sk-or-..." > .env   # only needed if you're using any OpenRouter-backed seats
pnpm dev:console
```

This builds every workspace package, starts the MCP server, and starts the web client (proxied through the one externally-reachable port, 5173) — printing a host console URL (`/host.html`) to assemble seats and launch a game. `OPENROUTER_API_KEY` is loaded automatically from `.env` at the repo root; no need to export it into your shell first.

Each AI seat is its own subprocess (`packages/ai-player`), speaking to the game purely through MCP tool calls and a read-only resource for its own view of the game — the same interface a human player's web client uses. That parity is deliberate: it's the reference implementation for driving an MCP-based agent loop against a real multiplayer game, not just this game specifically.

## Roles & Player Counts

  - Town (1–any)
  - Mafia (1–any, typically 2 to 4)
  - Sheriff (1)
  - Doctor (1–2)
  - Jester (1)
  - Tanner (1)
  - Serial Killer (1–2)
  - Vigilante (1–2)
  - Jack of All Trades (1)
  - Deep Diver (1–3; custom)
  - Lovers — not a role slot of its own: any two players (any roles) can be paired as Lovers on top of their existing role.

## General Rules

  - The game alternates a night phase (private role actions + role-specific team chat: Mafia, Deep Divers, each Lovers pair) with a day phase (public town discussion, then a vote).
  - Every chat channel — town, and any team channel you belong to — has a randomized speaking order, reshuffled each cycle so nobody dominates the floor. You only get a turn when it's genuinely yours.
  - Town's day-discussion budget is a single pool shared by the *whole table* (20 messages by default), not a personal allowance per player — once it's spent, the day moves straight to the vote regardless of who has or hasn't spoken. There's no `pass` during day discussion: once your turn comes you must say something, even if that's just "nothing new from me."
  - Any player can ping (@) another during day discussion to query them directly — this jumps the pinged player to the front of the speaking queue for their next reply, but that reply still draws from the same shared pool. It's priority, not a bonus turn.
  - Team night-channels (Mafia, Deep Divers, Lovers) each have their own smaller per-player message budget (6 for Mafia/Deep Divers, 2 for Lovers by default).
  - During the vote, players go one at a time in randomized order; each can vote for another player, vote to abstain, or request more discussion time (once per day).
  - "Vote X now, if not vote me after" is frowned upon.
  - Everyone can see town chat; only Mafia see Mafia chat, only Deep Divers see Deep Divers chat, only a Lovers pair sees their own channel. Solo-role players (Sheriff, Doctor, Serial Killer, Vigilante, Jack of All Trades) see their own private night-action log only.
  - If three day-phases in a row pass with no elimination, everyone loses.
  - If anyone tries to eliminate a protected player, it fails silently — the attacker gets no confirmation either way.

### Post-game debrief

Once the game ends, roles and every channel are revealed to everyone — nobody can hide anything anymore. Before the game truly closes, there's a short debrief: every player who was ever seated, dead or alive, gets called on exactly once, in original seat order, for one final message. Say what's actually on your mind.

### Resilience

A single broken or rate-limited AI seat can't block the table: after 3 consecutive failures (provider errors, bad tool calls, or no tool call at all) in a spot where it's genuinely that seat's turn, the game forces a safe fallback on its behalf — an `abstain` vote during voting, a blunt "tool-call failed" message during discussion, or a silent pass at night — and moves on.

## Role Rules and Conditions

### Town + town-aligned
  - Must work with other townies to gather knowledge, identify threats, and dispose of them democratically.
  - Town wins once every threat (Mafia, Serial Killer) is eliminated.
  - Town loses once the number of town-aligned survivors drops to or below the number of hostile survivors.

### Mafia
  - Works with fellow Mafia at night to eliminate every non-Mafia-aligned player — propose a target via `mafia_kill_proposal`; the target with the most proposals is attacked (a tie means no kill that night).
  - Mafia wins once the number of town-aligned survivors drops to or below the number of hostile survivors (doesn't require eliminating literally everyone).
  - If every Mafia member is voted out or eliminated, Mafia loses — the game continues if another threat (e.g. an SK) is still alive.
  - **Warning:** killing a Tanner at night destroys the entire attacking Mafia faction as a boomerang consequence — there's no way to know who's the Tanner in advance.

### Sheriff
  - May investigate one player per night; learns whether they're Mafia or not.
  - May not investigate the same player twice.
  - If the Sheriff dies, Town loses that investigation power for good.

### Doctor
  - May protect one player per night from all elimination attempts (Mafia, SK, even friendly-fire from Vigilante/Jack of All Trades).
  - May not protect the same player two nights in a row.
  - Self-protection is a legitimate strategic choice, not a mistake.

### Jester
  - Goal: get voted out by Town during the day.
  - If voted out, the Jester wins and may choose one player who voted against them to eliminate as revenge — unless that target is the Tanner, in which case both the Jester and Tanner lose instead.
  - If killed at night instead (Mafia, SK, Vigilante, Jack of All Trades, or heartbreak), the Jester simply loses; the game continues.

### Tanner
  - Goal: get eliminated as fast as possible, by any means.
  - Voted out during the day: Tanner wins alone, and everyone else loses immediately.
  - Killed by Mafia or a Serial Killer at night: Tanner wins on the side, and the attacker's whole faction (the SK specifically, or all of Mafia) is destroyed as a boomerang consequence. The game continues if another threat remains.
  - Eliminated by a Vigilante or Jack of All Trades: Tanner simply loses; the game continues.

### Serial Killer
  - Goal: eliminate every other player. Acts alone, even alongside another Serial Killer (not on the same side).
  - Chooses a target each night via `sk_kill`.
  - Killing a Tanner destroys the Serial Killer as a boomerang consequence.
  - Wins by being the sole survivor.

### Vigilante
  - Goal: help Town eliminate threats under cover of night.
  - May eliminate up to one player per night via `vigilante_kill`, or hold fire via `vigilante_hold` — no limit on how often you may hold.
  - Killing a protected player does nothing; killing an innocent Town member, Jester, or Tanner can trigger an unwanted outcome.

### Jack of All Trades
  - Goal: be a flexible asset to Town using three one-shot tools, each usable exactly once for the whole game: `joat_investigate` (Sheriff-style), `joat_protect` (Doctor-style), `joat_eliminate` (Vigilante-style).
  - No limit on how often you may hold off using a charge on a given night.

### Deep Diver
  - Goal: identify every Serial Killer in play and get them eliminated.
  - Has a private Deep Divers chat with any other Deep Divers.
  - May investigate one player per night via `deep_diver_investigate`, learning whether they're a Serial Killer or not; may not investigate the same player twice.
  - Findings are shared during the day to help Town and any Vigilante act on good information.

### Lovers
  - Two players (of any roles), paired at game setup, sharing a private night-time channel.
  - If one Lover dies, the other dies immediately after from heartbreak — nothing can prevent this, not even Doctor/Jack of All Trades protection.
