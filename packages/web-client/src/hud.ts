import type { PlayerView } from "./view-types.js";

/**
 * Renders the top-left HUD: role, phase/day, alive status, and this
 * player's turn budgets.
 *
 * `pendingReveal` is how many already-resolved chat messages the
 * camera/voice/text-log reveal queue (see main.ts) hasn't caught up to
 * displaying yet. The budget counters below are always real-time-accurate
 * to the actual game state — deliberately not paced like the chat log —
 * so without this they can show a count ahead of what's visibly happened
 * on screen (e.g. a shared town pool already at 6 while only 2 messages
 * have been shown), which reads exactly like players silently skipping
 * their turn. They aren't — the rest is just still queued to display.
 */
export function renderHud(el: HTMLElement, view: PlayerView, pendingReveal = 0): void {
  const pendingNote = pendingReveal > 0 ? ` <span class="pending-reveal">(${pendingReveal} queued)</span>` : "";
  const budgets = view.turnBudgets.map((b) => `${b.channel} ${b.used}/${b.cap}`).join(" · ");
  const charges = view.self.joatCharges
    ? Object.entries(view.self.joatCharges)
        .filter(([, remaining]) => remaining)
        .map(([tool]) => tool)
        .join(", ") || "none left"
    : undefined;

  const turnLine = (() => {
    if (view.phase === "day_discussion" && view.dayTurnPlayerId) {
      if (view.dayTurnPlayerId === view.playerId) {
        return `<div style="color:#7fffab;font-weight:600">Your turn to speak</div>`;
      }
      const name = view.roster.find((p) => p.id === view.dayTurnPlayerId)?.displayName ?? view.dayTurnPlayerId;
      return `<div>Waiting on ${name} to speak…</div>`;
    }
    if (view.phase === "debrief" && view.debriefTurnPlayerId) {
      if (view.debriefTurnPlayerId === view.playerId) {
        return `<div style="color:#7fffab;font-weight:600">Your turn for a final word</div>`;
      }
      const name = view.roster.find((p) => p.id === view.debriefTurnPlayerId)?.displayName ?? view.debriefTurnPlayerId;
      return `<div>Waiting on ${name}'s final word…</div>`;
    }
    return "";
  })();

  el.innerHTML = `
    <div><span class="role">${view.self.role}</span>${view.self.alive ? "" : " (dead)"}</div>
    <div>Day ${view.dayNumber} — ${view.phase.replace(/_/g, " ")}</div>
    ${budgets ? `<div>${budgets}${pendingNote}</div>` : ""}
    ${charges !== undefined ? `<div>JoAT charges: ${charges}</div>` : ""}
    ${view.pingCredits > 0 ? `<div>${view.pingCredits} free reply turn(s) available</div>` : ""}
    ${turnLine}
    ${view.winner ? `<div style="color:#ffd166;font-weight:600">GAME OVER — ${view.winner.result} wins</div>` : ""}
  `;
}
