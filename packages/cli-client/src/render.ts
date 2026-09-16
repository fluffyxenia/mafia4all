import type { CliPlayerView } from "./view-types.js";

export function formatSummary(view: CliPlayerView): string {
  const lines: string[] = [];
  lines.push(`--- Day ${view.dayNumber} | ${view.phase} ---`);
  lines.push(`You are ${view.playerId} (${view.self.role}${view.self.alive ? "" : ", DEAD"})`);

  if (view.self.joatCharges) {
    const remaining = Object.entries(view.self.joatCharges)
      .filter(([, available]) => available)
      .map(([tool]) => tool);
    lines.push(`JoAT charges remaining: ${remaining.length > 0 ? remaining.join(", ") : "none"}`);
  }

  const roster = view.roster
    .map((r) => `${r.displayName}${r.alive ? "" : " (dead)"}${r.revealedRole ? ` [${r.revealedRole}]` : ""}`)
    .join(", ");
  lines.push(`Roster: ${roster}`);

  const budgets = view.turnBudgets
    .map((b) => `${b.channel}: ${b.used}/${b.cap}${view.pingCredits > 0 && b.channel === "town" ? ` (+${view.pingCredits} ping credit)` : ""}`)
    .join(", ");
  if (budgets) lines.push(`Turns remaining: ${budgets}`);

  if (view.phase === "day_discussion" && view.dayTurnPlayerId) {
    lines.push(
      view.dayTurnPlayerId === view.playerId
        ? "It's your turn to speak in town chat."
        : `Waiting on ${view.roster.find((r) => r.id === view.dayTurnPlayerId)?.displayName ?? view.dayTurnPlayerId} to speak.`,
    );
  }

  if (view.winner) {
    const winners = view.winner.winningPlayerIds.length > 0 ? view.winner.winningPlayerIds.join(", ") : "nobody";
    lines.push(`\n*** GAME OVER: ${view.winner.result} wins (${winners}) ***`);
  }

  return lines.join("\n");
}

/** Only the messages/log entries the player hasn't seen printed yet, in wire order. */
export function formatNewActivity(previous: CliPlayerView | undefined, next: CliPlayerView): string[] {
  const lines: string[] = [];

  const seenChatIds = new Set((previous?.chatLog ?? []).map((m) => m.id));
  for (const m of next.chatLog) {
    if (seenChatIds.has(m.id)) continue;
    if (m.system) {
      lines.push(`*** ${m.message} ***`);
      continue;
    }
    const ping = m.pingTargetId ? ` @${m.pingTargetId}` : "";
    lines.push(`[${m.channel}]${ping} ${m.authorId}: ${m.message}`);
  }

  const prevPrivateCount = previous?.privateLog.length ?? 0;
  for (const entry of next.privateLog.slice(prevPrivateCount)) {
    // Only your own night-log entries are private during play; once the
    // game ends, everyone's logs become visible (post-game transparency),
    // so label those with whose entry it is rather than implying "yours".
    const label = entry.ownerId === next.playerId ? "private" : `${entry.ownerId}'s log`;
    lines.push(`(${label}) ${entry.text}`);
  }

  return lines;
}

export const HELP_TEXT = `Commands:
  <text>                                send a chat message to your current channel (shorthand)
  /chat <channel> <message>             send a chat message to a specific channel
  /ping <playerId> <message>            ping a player during day discussion
  /vote <target> [-- reasoning]         target is a playerId, "abstain", or "request_more_messages"
  /action <actionType> [target] [-- reasoning]
                                         submit your night action
  /revenge <playerId> [-- reasoning]    (Jester only) revenge-kill during your sub-phase
  /pass                                 end your turn / decline a night action
  /view                                 reprint your current view
  /help                                 show this message
  /quit                                 disconnect

Adding "-- reasoning" to /vote, /action, or /revenge states your reason out
loud (it's announced to the relevant channel, or logged privately for solo
roles) — e.g. "/vote p3 -- they've been too quiet all game."`;

/** The channel a bare (non-slash) line should be sent to, given the current phase. */
export function defaultChannelFor(view: CliPlayerView): string | undefined {
  if (view.phase === "day_discussion") return "town";
  if (view.phase === "night") return view.visibleChannels.find((c) => c !== "town");
  return undefined;
}
