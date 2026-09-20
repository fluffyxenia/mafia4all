import type { PlayerView, ViewChatMessage, ViewPrivateLogEntry } from "./view-types.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Exported so a caller presenting one message at a time (see main.ts's chat-reveal queue) can render it identically to a bulk catch-up render. */
export function renderMessage(m: ViewChatMessage, nameOf: (id: string) => string): string {
  if (m.system) {
    return `<div class="msg system">${escapeHtml(m.message)}</div>`;
  }
  const ping = m.pingTargetId ? ` <em>(→ ${escapeHtml(nameOf(m.pingTargetId))})</em>` : "";
  return `<div class="msg"><span class="author">[${escapeHtml(m.channel)}] ${escapeHtml(nameOf(m.authorId))}${ping}:</span> ${escapeHtml(m.message)}</div>`;
}

export function renderPrivateLogEntry(e: ViewPrivateLogEntry, playerId: string, nameOf: (id: string) => string): string {
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
 * Appends HTML to the log, keeping it pinned to the bottom unless the
 * viewer has scrolled up to read back through history. Exported so a
 * one-message-at-a-time reveal (see main.ts's chat-reveal queue) gets the
 * same auto-scroll behavior as a bulk catch-up render.
 */
export function appendPinnedToBottom(el: HTMLElement, html: string): void {
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.insertAdjacentHTML("beforeend", html);
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

/**
 * Builds the { id -> display name } lookup every render call needs — chat
 * carries playerIds (the stable, MCP-facing identity), not the human-facing
 * display name, so this resolves them into something that reads like a
 * conversation between named players instead of "p1", "p3", etc.
 */
export function nameResolver(view: PlayerView): (id: string) => string {
  const nameById = new Map(view.roster.map((p) => [p.id, p.displayName]));
  return (id: string) => nameById.get(id) ?? id;
}

/**
 * Appends every newly-arrived chat message and private-log entry (the
 * latter matched by how many were already rendered, since they have no id
 * of their own — mirrors the CLI client's approach) all at once — used only
 * for a fresh connection's one-time catch-up on history the viewer wasn't
 * here to watch unfold live. Once connected, new messages instead go
 * through main.ts's one-at-a-time reveal queue (renderMessage +
 * appendPinnedToBottom, called per message) so the log stays in sync with
 * the camera/voice instead of dumping every new line at once.
 */
export function renderNewChat(el: HTMLElement, previous: PlayerView | undefined, next: PlayerView): void {
  const seenIds = new Set((previous?.chatLog ?? []).map((m) => m.id));
  const freshChat = next.chatLog.filter((m) => !seenIds.has(m.id));
  const freshPrivate = next.privateLog.slice(previous?.privateLog.length ?? 0);
  if (freshChat.length === 0 && freshPrivate.length === 0) return;

  const nameOf = nameResolver(next);
  const html =
    freshChat.map((m) => renderMessage(m, nameOf)).join("") +
    freshPrivate.map((e) => renderPrivateLogEntry(e, next.playerId, nameOf)).join("");
  appendPinnedToBottom(el, html);
}
