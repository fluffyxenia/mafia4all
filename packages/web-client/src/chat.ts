import type { PlayerView, ViewChatMessage, ViewPrivateLogEntry } from "./view-types.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderMessage(m: ViewChatMessage, nameOf: (id: string) => string): string {
  if (m.system) {
    return `<div class="msg system">${escapeHtml(m.message)}</div>`;
  }
  const ping = m.pingTargetId ? ` <em>(→ ${escapeHtml(nameOf(m.pingTargetId))})</em>` : "";
  return `<div class="msg"><span class="author">[${escapeHtml(m.channel)}] ${escapeHtml(nameOf(m.authorId))}${ping}:</span> ${escapeHtml(m.message)}</div>`;
}

function renderPrivateLogEntry(e: ViewPrivateLogEntry, playerId: string, nameOf: (id: string) => string): string {
  // Solo-role results (Sheriff/Deep Diver investigations, Doctor/JoAT
  // protect confirmations, kill-attempt outcomes) have no channel to
  // announce into — they land here instead of chatLog. Only your own
  // entries exist during play; everyone's become visible post-game, at
  // which point they need attributing since they're no longer implicitly
  // "yours".
  const label = e.ownerId === playerId ? "private" : `${nameOf(e.ownerId)}'s log`;
  return `<div class="msg private">(${escapeHtml(label)}) ${escapeHtml(e.text)}</div>`;
}

/**
 * Appends only newly-arrived chat messages and private-log entries (the
 * latter matched by how many were already rendered, since they have no id
 * of their own — mirrors the CLI client's approach) and keeps the log
 * pinned to the bottom unless the viewer has scrolled up to read back
 * through history.
 */
export function renderNewChat(el: HTMLElement, previous: PlayerView | undefined, next: PlayerView): void {
  const seenIds = new Set((previous?.chatLog ?? []).map((m) => m.id));
  const freshChat = next.chatLog.filter((m) => !seenIds.has(m.id));
  const freshPrivate = next.privateLog.slice(previous?.privateLog.length ?? 0);
  if (freshChat.length === 0 && freshPrivate.length === 0) return;

  // Chat carries playerIds (the stable, MCP-facing identity), not the
  // human-facing display name — resolve them here so the log reads like a
  // conversation between named players instead of "p1", "p3", etc.
  const nameById = new Map(next.roster.map((p) => [p.id, p.displayName]));
  const nameOf = (id: string) => nameById.get(id) ?? id;

  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const html =
    freshChat.map((m) => renderMessage(m, nameOf)).join("") +
    freshPrivate.map((e) => renderPrivateLogEntry(e, next.playerId, nameOf)).join("");
  el.insertAdjacentHTML("beforeend", html);
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}
