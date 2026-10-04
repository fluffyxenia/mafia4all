import type { PlayerView } from "./view-types.js";

export interface ToolSpec {
  name: string;
  inputSchema?: { properties?: Record<string, { enum?: string[] }> };
}

export type CallTool = (name: string, args: Record<string, unknown>) => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function aliveOptions(view: PlayerView, excludeSelf: boolean): { id: string; label: string }[] {
  return view.roster
    .filter((p) => p.alive && (!excludeSelf || p.id !== view.playerId))
    .map((p) => ({ id: p.id, label: p.displayName }));
}

function select(options: { id: string; label: string }[]): HTMLSelectElement {
  const node = el("select");
  for (const opt of options) {
    const o = el("option");
    o.value = opt.id;
    o.textContent = opt.label;
    node.appendChild(o);
  }
  return node;
}

/**
 * A plain <input type="text"> can never hold a newline — Enter does
 * nothing in one, since these aren't inside a <form> to submit. A
 * <textarea> is the only element that actually supports multi-line text,
 * so reasoning/chat fields need one, growing to fit rather than scrolling
 * internally.
 */
function growingTextarea(placeholder: string): HTMLTextAreaElement {
  const node = el("textarea", { placeholder, rows: "1" });
  node.addEventListener("input", () => {
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  });
  return node;
}

/** Enter submits (like a normal chat box); Shift+Enter inserts a real line break. */
function submitOnEnter(node: HTMLTextAreaElement, onSubmit: () => void): void {
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  });
}

/**
 * Wraps one tool's controls with a visible label. Without this, two tools
 * offered at once (e.g. send_chat to a team channel alongside night_action,
 * for Mafia/Deep Diver at night) render as one flat row of near-identical
 * dropdowns and textareas with nothing distinguishing which box belongs to
 * which action — found in real testing when a player typed their kill
 * proposal's reasoning into the team-chat message box by mistake, since
 * both boxes looked and behaved the same with no indication otherwise.
 */
function toolGroup(label: string, ...children: HTMLElement[]): HTMLDivElement {
  const group = el("div", { class: "tool-group" });
  const labelEl = el("span", { class: "tool-group-label" });
  labelEl.textContent = label;
  group.append(labelEl, ...children);
  return group;
}

/**
 * Rebuilds the action panel from scratch on every poll from whichever
 * tools are *currently* advertised (the phase/role-narrowed set — see
 * mcp-server's tool-availability.ts) — this is deliberately the same
 * information an AI player's agent loop sees, not a hand-maintained
 * parallel notion of "what this role can do".
 */
export function renderActions(el_: HTMLElement, tools: ToolSpec[], view: PlayerView, callTool: CallTool): void {
  el_.innerHTML = "";
  const byName = new Map(tools.map((t) => [t.name, t]));

  const sendChat = byName.get("send_chat");
  if (sendChat) {
    // Only channels currently writable this phase — the tool's own narrowed
    // enum (see mcp-server's tool-availability.ts), not every channel this
    // player merely belongs to. Town chat is day-only, mafia/deep_divers/
    // lovers are night-only; offering the wrong one just for it to fail
    // server-side is exactly what this narrowing is meant to avoid.
    const allowedChannels = sendChat.inputSchema?.properties?.channel?.enum ?? [];
    const channel = select(allowedChannels.map((c) => ({ id: c, label: c })));
    const message = growingTextarea("Say something… (Enter to send, Shift+Enter for a new line)");
    const send = el("button");
    send.className = "tool-btn";
    send.textContent = "Send";
    const submit = () => {
      if (!message.value.trim()) return;
      callTool("send_chat", { channel: channel.value, message: message.value });
      message.value = "";
      message.style.height = "auto";
    };
    send.onclick = submit;
    submitOnEnter(message, submit);
    el_.append(toolGroup(`Send message (${allowedChannels.join(", ") || "chat"})`, channel, message, send));
  }

  if (byName.has("ping_player")) {
    const target = select(aliveOptions(view, true));
    const message = growingTextarea("Ping message… (Enter to send, Shift+Enter for a new line)");
    const btn = el("button");
    btn.className = "tool-btn";
    btn.textContent = "Ping";
    const submit = () => {
      if (!message.value.trim()) return;
      callTool("ping_player", { targetPlayerId: target.value, message: message.value });
      message.value = "";
      message.style.height = "auto";
    };
    btn.onclick = submit;
    submitOnEnter(message, submit);
    el_.append(toolGroup("Ping a player", target, message, btn));
  }

  if (byName.has("cast_vote")) {
    const target = select([
      ...aliveOptions(view, false),
      { id: "abstain", label: "Abstain" },
      { id: "request_more_messages", label: "Request more messages" },
    ]);
    const reasoning = growingTextarea("Why? (optional — Enter to vote, Shift+Enter for a new line)");
    const btn = el("button");
    btn.className = "tool-btn active";
    btn.textContent = "Cast vote";
    const submit = () => {
      callTool("cast_vote", { target: target.value, ...(reasoning.value.trim() ? { reasoning: reasoning.value } : {}) });
      reasoning.value = "";
      reasoning.style.height = "auto";
    };
    btn.onclick = submit;
    submitOnEnter(reasoning, submit);
    el_.append(toolGroup("Cast your vote", target, reasoning, btn));
  }

  const nightAction = byName.get("night_action");
  // Whether pass gets its own standalone control below, or merges into this
  // group's actionType dropdown, depends on night_action existing at all —
  // see the standalone block's comment for the case where it doesn't.
  const passOffered = byName.has("pass");
  const mergePassIntoNightAction = Boolean(nightAction) && passOffered;
  if (nightAction) {
    const actionTypes = nightAction.inputSchema?.properties?.actionType?.enum ?? [];
    // "pass" is deliberately not part of night_action's own actionType enum
    // (it's a separate tool server-side — see session.ts) — appended here
    // purely so it reads as one more choice in the same dropdown, which is
    // what a player actually wants: "what do I do this turn," pass included.
    const options = mergePassIntoNightAction
      ? [...actionTypes.map((a) => ({ id: a, label: a })), { id: "pass", label: "pass" }]
      : actionTypes.map((a) => ({ id: a, label: a }));
    const actionType = select(options);
    const target = select(aliveOptions(view, false));
    const reasoning = growingTextarea("Why? (optional — Enter to submit, Shift+Enter for a new line)");
    const btn = el("button");
    btn.className = "tool-btn active";
    btn.textContent = "Submit action";
    const syncTargetVisibility = () => {
      target.style.display = actionType.value === "vigilante_hold" || actionType.value === "pass" ? "none" : "";
    };
    actionType.onchange = syncTargetVisibility;
    syncTargetVisibility();
    const submit = () => {
      if (actionType.value === "pass") {
        callTool("pass", { ...(reasoning.value.trim() ? { reasoning: reasoning.value } : {}) });
      } else {
        const needsTarget = actionType.value !== "vigilante_hold";
        callTool("night_action", {
          actionType: actionType.value,
          ...(needsTarget ? { targetPlayerId: target.value } : {}),
          ...(reasoning.value.trim() ? { reasoning: reasoning.value } : {}),
        });
      }
      reasoning.value = "";
      reasoning.style.height = "auto";
    };
    btn.onclick = submit;
    submitOnEnter(reasoning, submit);
    el_.append(toolGroup("Night action", actionType, target, reasoning, btn));
  }

  if (byName.has("jester_revenge")) {
    const target = select(aliveOptions(view, true));
    const reasoning = growingTextarea("Why? (optional — Enter to submit, Shift+Enter for a new line)");
    const btn = el("button");
    btn.className = "tool-btn active";
    btn.textContent = "Revenge";
    const submit = () => {
      callTool("jester_revenge", { targetPlayerId: target.value, ...(reasoning.value.trim() ? { reasoning: reasoning.value } : {}) });
      reasoning.value = "";
      reasoning.style.height = "auto";
    };
    btn.onclick = submit;
    submitOnEnter(reasoning, submit);
    el_.append(toolGroup("Jester revenge", target, reasoning, btn));
  }

  // Only rendered standalone when it wasn't already folded into the night
  // action group above — currently just the Jester-revenge-decline case,
  // where there's no night_action group to fold into.
  if (passOffered && !mergePassIntoNightAction) {
    const reasoning = growingTextarea("Why? (optional — Enter to pass, Shift+Enter for a new line)");
    const btn = el("button");
    btn.className = "tool-btn";
    btn.textContent = "Pass";
    const submit = () => {
      callTool("pass", { ...(reasoning.value.trim() ? { reasoning: reasoning.value } : {}) });
      reasoning.value = "";
      reasoning.style.height = "auto";
    };
    btn.onclick = submit;
    submitOnEnter(reasoning, submit);
    el_.append(toolGroup("Pass", reasoning, btn));
  }

  if (el_.children.length === 0) {
    const idle = el("span");
    idle.textContent = "Nothing to do right now — waiting on other players.";
    idle.style.color = "#9a9ba5";
    idle.style.fontSize = "0.85rem";
    el_.append(idle);
  }
}
