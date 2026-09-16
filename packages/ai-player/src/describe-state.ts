import type { PlayerView } from "./view-types.js";

/**
 * Night N happens *before* Day N's discussion (dayNumber increments the
 * instant night begins — see advance.ts/day-vote.ts) — internally
 * consistent, but the old plain "Day 2, phase: night." rendering reads as
 * contradictory (day and night stated as simultaneous) rather than as the
 * natural "Night 2." Found in real testing: a model got stuck in a visible
 * reasoning loop specifically confused by that phrasing, mid-generation,
 * never reaching a tool call at all.
 */
function phaseLabel(dayNumber: number, phase: string): string {
  switch (phase) {
    case "night":
      return `Night ${dayNumber}`;
    case "day_discussion":
      return `Day ${dayNumber} discussion`;
    case "day_vote":
      return `Day ${dayNumber} vote`;
    case "jester_revenge_subphase":
      return `Day ${dayNumber}, Jester revenge`;
    case "debrief":
      return "Post-game debrief";
    case "lobby":
      return "Lobby (game not yet started)";
    case "post_game":
      return "Game over";
    default:
      return `Day ${dayNumber}, phase: ${phase}`;
  }
}

/** Renders a compact, LLM-friendly summary of the current turn: state plus anything new since the last one. */
export function describeTurn(previous: PlayerView | undefined, next: PlayerView): string {
  const lines: string[] = [];

  // Every model was otherwise only ever shown raw ids (p1, p2, ...) — the
  // roster/chat/ping lines below all had displayName sitting right there on
  // RosterEntry and never rendered it, so players could only ever refer to
  // each other as "p7" instead of by an actual name. Name leads, id trails
  // in parens (rather than the reverse) deliberately: the whole point is
  // getting models to actually write the name in their own prose (see
  // BASE_SYSTEM_PROMPT's matching instruction), and leading with it gives
  // it more weight than a parenthetical afterthought would.
  const nameById = new Map(next.roster.map((r) => [r.id, r.displayName]));
  const nameFor = (id: string): string => {
    const name = nameById.get(id);
    return name ? `${name} (${id})` : id;
  };

  lines.push(`${phaseLabel(next.dayNumber, next.phase)}.`);
  lines.push(`You are ${nameFor(next.playerId)} (${next.self.role}${next.self.alive ? "" : ", DEAD"}).`);

  if (next.self.joatCharges) {
    const remaining = Object.entries(next.self.joatCharges)
      .filter(([, available]) => available)
      .map(([tool]) => tool);
    lines.push(`Jack of All Trades charges remaining: ${remaining.length > 0 ? remaining.join(", ") : "none"}.`);
  }

  const roster = next.roster
    .map((r) => `${nameFor(r.id)}${r.alive ? "" : " (dead)"}${r.revealedRole ? ` [${r.revealedRole}]` : ""}`)
    .join(", ");
  lines.push(`Roster: ${roster}.`);

  // Spell out the remaining count directly rather than a bare "used/cap"
  // pair — multiple models in real testing misread e.g. "town: 0/3" as
  // "0 remaining" (it's 0 used, 3 remaining) and talked themselves out of
  // using a tool that was genuinely available, derailing the whole turn on
  // a misreading of the label rather than an actual lack of options.
  const budgets = next.turnBudgets
    .map((b) => {
      const scope = b.channel === "town" ? ", shared by the whole table" : "";
      return `${b.channel}: ${b.cap - b.used} remaining (${b.used} used of ${b.cap}${scope})`;
    })
    .join(", ");
  if (budgets) lines.push(`Your remaining turns this phase: ${budgets}.`);
  if (next.pingCredits > 0) lines.push(`You have ${next.pingCredits} free reply turn(s) from being pinged.`);

  // Town chat has a randomized speaking order (reshuffled each round) so
  // no small set of players dominates the floor — send_chat/ping_player to
  // "town" only appear in your tool list when it's genuinely your turn.
  if (next.phase === "day_discussion") {
    lines.push(
      next.dayTurnPlayerId === next.playerId
        ? "It's your turn to speak in town chat."
        : `It's ${next.dayTurnPlayerId ? nameFor(next.dayTurnPlayerId) : "someone else's"} turn to speak in town chat — wait for your turn (or a ping) before you can send there.`,
    );
  }

  // Voting is sequential too, one at a time in randomized order — not a
  // free-for-all the instant day_vote begins.
  if (next.phase === "day_vote") {
    lines.push(
      next.dayVoteTurnPlayerId === next.playerId
        ? "It's your turn to cast your vote."
        : `It's ${next.dayVoteTurnPlayerId ? nameFor(next.dayVoteTurnPlayerId) : "someone else's"} turn to vote — wait for your turn.`,
    );
  }

  // The game is over, roles are revealed, and there's no more strategy to
  // protect — this is every player's (living or dead, in original seat
  // order) one and only chance to say whatever's actually on their mind
  // before the transcript closes for good.
  if (next.phase === "debrief") {
    lines.push(
      "The game has ended and every role is now public — see the roster above. This is your one and only closing message: no more turns after this, so say what you actually think now that it's safe to.",
    );
    lines.push(
      next.debriefTurnPlayerId === next.playerId
        ? "It's your turn to give your final word."
        : `It's ${next.debriefTurnPlayerId ? nameFor(next.debriefTurnPlayerId) : "someone else's"} turn to give their final word — wait for your turn.`,
    );
  }

  // The full running transcript, not just the delta since your last turn —
  // each turn is now a fresh, stateless prompt with no memory of its own
  // past turns (see AgentLoop), so this is the player's only way to see
  // anything that happened before. Context is cheap on these models
  // (16k-32k) and a whole game's chat log stays well within that, so
  // there's no reason to risk missing something pivotal just because it
  // fell between two of this player's own polls — which is exactly what
  // happened in real testing: a player never reacted to another player's
  // self-incriminating public statement because it landed outside their
  // narrow last-turn-to-this-turn window. [NEW] marks what's arrived since
  // this player's own last turn, as a focus hint — everything else is
  // still shown, just unmarked.
  if (next.chatLog.length > 0) {
    const seenChatIds = new Set((previous?.chatLog ?? []).map((m) => m.id));
    lines.push("Full public chat transcript so far:");
    for (const m of next.chatLog) {
      const marker = seenChatIds.has(m.id) ? "" : " [NEW]";
      if (m.system) {
        lines.push(`  [announcement]${marker} ${m.message}`);
        continue;
      }
      const ping = m.pingTargetId ? ` (pinging ${nameFor(m.pingTargetId)})` : "";
      lines.push(`  [${m.channel}] ${nameFor(m.authorId)}${ping}${marker}: ${m.message}`);
    }
  }

  if (next.privateLog.length > 0) {
    const prevPrivateCount = previous?.privateLog.length ?? 0;
    lines.push("Your private results so far:");
    next.privateLog.forEach((entry, i) => {
      const marker = i >= prevPrivateCount ? " [NEW]" : "";
      lines.push(`  ${entry.text}${marker}`);
    });
  }

  if (next.winner) {
    lines.push(`GAME OVER: ${next.winner.result} wins (${next.winner.winningPlayerIds.join(", ") || "nobody"}).`);
  }

  lines.push("Decide your action for this turn and call exactly one tool (or pass).");
  return lines.join("\n");
}

/**
 * Whether it's worth spending an LLM call this tick: something changed
 * (phase, new chat, new private results), or the idle-nudge window elapsed
 * so a player who still needs to vote/act isn't stuck silent forever. This
 * matters a lot on free-tier rate limits — no point burning a call when
 * nothing happened.
 */
export function shouldPrompt(
  previous: PlayerView | undefined,
  next: PlayerView,
  msSinceLastPrompt: number,
  idleNudgeMs: number,
): boolean {
  if (!previous) return true;
  if (previous.phase !== next.phase) return true;
  if (next.privateLog.length > previous.privateLog.length) return true;
  if (next.chatLog.length > previous.chatLog.length) {
    // Outside day_discussion (e.g. Mafia coordinating at night), any new
    // chat is worth reacting to. During day_discussion specifically, turn
    // order means send_chat/ping_player to "town" are hidden from this
    // player's tool list until it's genuinely their turn — every other
    // player's message triggers this same check, so prompting anyway would
    // burn a slow local-inference call just to relearn "still not my turn"
    // (and risks a model reaching for the only tool left, `pass`, which
    // would wrongly give up its turns for the rest of the day).
    if (next.phase !== "day_discussion" || next.dayTurnPlayerId === next.playerId) return true;
  }
  // No separate "already committed this phase" veto here — AgentLoop only
  // ever calls this once its own hasRealTool check already confirmed a
  // real, not-yet-exhausted tool is on offer, and tool-availability.ts's
  // own per-tool state gating (alreadyActedTonight, channel turn order,
  // etc.) is what actually decides whether a one-shot action is still
  // biddable. A flat "already committed" flag here used to double as that
  // protection, but it was wrong for the case tool-availability.ts can't
  // see coming: a mafia/deep_divers/lovers player who already submitted
  // their night_action but still has a separate, not-yet-taken send_chat
  // turn queued in their team channel — found in real testing as a
  // permanently stuck channel turn queue (the committed player was never
  // re-prompted for their still-pending chat turn, freezing everyone
  // queued behind them for the rest of the night).
  return msSinceLastPrompt >= idleNudgeMs;
}
