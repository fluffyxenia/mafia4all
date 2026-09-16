import type { PlayerView } from "./view-types.js";

/** Renders the top-left HUD: role, phase/day, alive status, and this player's turn budgets. */
export function renderHud(el: HTMLElement, view: PlayerView): void {
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
    ${budgets ? `<div>${budgets}</div>` : ""}
    ${charges !== undefined ? `<div>JoAT charges: ${charges}</div>` : ""}
    ${view.pingCredits > 0 ? `<div>${view.pingCredits} free reply turn(s) available</div>` : ""}
    ${turnLine}
    ${view.winner ? `<div style="color:#ffd166;font-weight:600">GAME OVER — ${view.winner.result} wins</div>` : ""}
  `;
}
