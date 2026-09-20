import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GameScene } from "./scene.js";
import { renderHud } from "./hud.js";
import { appendPinnedToBottom, nameResolver, renderMessage, renderNewChat } from "./chat.js";
import { renderActions, type ToolSpec } from "./action-panel.js";
import { estimateDurationMs, speak, setTtsEnabled } from "./tts.js";
import type { PlayerView, ViewChatMessage } from "./view-types.js";

const VIEW_URI = "mafia://me/view";
const POLL_INTERVAL_MS = 2000;

const connectPanel = document.getElementById("connect") as HTMLDivElement;
const connectForm = document.getElementById("connect-form") as HTMLFormElement;
const joinUrlInput = document.getElementById("join-url") as HTMLInputElement;
const connectError = document.getElementById("connect-error") as HTMLDivElement;
const sceneContainer = document.getElementById("scene") as HTMLDivElement;
const hudEl = document.getElementById("hud") as HTMLDivElement;
const chatEl = document.getElementById("chat") as HTMLDivElement;
const chatLogEl = document.getElementById("chat-log") as HTMLDivElement;
const actionsEl = document.getElementById("actions") as HTMLDivElement;
const ttsToggleEl = document.getElementById("tts-toggle") as HTMLDivElement;
const ttsCheckboxEl = document.getElementById("tts-checkbox") as HTMLInputElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;

ttsCheckboxEl.addEventListener("change", () => setTtsEnabled(ttsCheckboxEl.checked));

let toastTimeout: ReturnType<typeof setTimeout> | undefined;
function showToast(message: string, variant: "info" | "error" = "info"): void {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", variant === "error");
  toastEl.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}

let lastView: PlayerView | undefined;
let lastActionsSignature: string | undefined;

/**
 * What renderActions actually needs to differ on: which tools are enabled,
 * night_action's narrowed actionType set, and who's alive/in-roster (target
 * dropdown contents). Deliberately excludes fields like chat log or turn
 * budgets that change constantly but don't change what the panel should
 * show — rebuilding the panel on every poll tick was wiping out whatever
 * the player was mid-typing or had selected, since fresh DOM nodes replace
 * the focused ones every couple of seconds.
 */
function actionsSignature(tools: ToolSpec[], view: PlayerView): string {
  return JSON.stringify({
    tools: tools.map((t) => [t.name, t.inputSchema?.properties?.actionType?.enum]),
    roster: view.roster.map((p) => [p.id, p.alive]),
    visibleChannels: view.visibleChannels,
  });
}

async function fetchView(client: Client): Promise<PlayerView> {
  const result = await client.readResource({ uri: VIEW_URI });
  const first = result.contents[0] as { text: string };
  return JSON.parse(first.text) as PlayerView;
}

function startGame(client: Client): void {
  connectPanel.hidden = true;
  hudEl.hidden = false;
  chatEl.hidden = false;
  actionsEl.hidden = false;
  ttsToggleEl.hidden = false;

  const scene = new GameScene(sceneContainer);
  scene.start();

  // Reveals newly-arrived chat messages (text bubble + camera focus + TTS)
  // one at a time, in order, each one waiting for the previous message's
  // voice line to actually finish before starting the next. Without this,
  // a burst of new messages arriving in the same poll tick (a handful of
  // fast-responding models can each answer within the same ~2s window)
  // fired every message's camera-focus and speak() call immediately and
  // independently — whichever message's timer/TTS happened to finish first
  // could yank the camera off a still-"talking" player, and a fast
  // responder could steal focus before a slower player already on screen
  // had finished. Queuing means the WebUI can legitimately lag a few
  // messages behind the actual (already-resolved) game state during a
  // burst — that's the point: it trades real-time accuracy for a pace a
  // viewer can actually follow, one speaker at a time.
  const chatRevealQueue: { message: ViewChatMessage; nameOf: (id: string) => string }[] = [];
  let revealing = false;

  function drainChatRevealQueue(): void {
    if (revealing) return;
    const next = chatRevealQueue.shift();
    if (!next) return;
    revealing = true;
    const { message: m, nameOf } = next;
    appendPinnedToBottom(chatLogEl, renderMessage(m, nameOf));

    if (m.system) {
      // Narrator lines (deaths, phase announcements) have no speaker to
      // focus the camera on or voice — reveal instantly and move on,
      // rather than holding up real players' queued messages behind them.
      revealing = false;
      drainChatRevealQueue();
      return;
    }

    // Paced entirely by our own timer, deliberately NOT by speak()'s own
    // onstart/onend events — real-world testing found more than one
    // distinct way for those to be unreliable across browsers/environments
    // (an utterance queued behind another never reporting "started"; a
    // completion that apparently never fires at all, permanently stalling
    // this queue with a still-"talking" avatar and no way to tell). speak()
    // is called purely for best-effort audio; onstart is a nice-to-have for
    // the bob animation's timing but nothing here depends on it firing.
    scene.focus(m.authorId);
    scene.startTalking(m.authorId);
    speak(m.authorId, m.message);
    setTimeout(() => {
      scene.stopTalking(m.authorId);
      scene.unfocus();
      revealing = false;
      drainChatRevealQueue();
    }, estimateDurationMs(m.message));
  }

  const callTool: (name: string, args: Record<string, unknown>) => void = (name, args) => {
    client
      .callTool({ name, arguments: args })
      .then((result: unknown) => {
        const r = result as { isError?: boolean; content?: { type: string; text: string }[] };
        if (r.isError) {
          const detail = r.content?.[0]?.text ?? "unknown error";
          console.error(`${name} failed:`, detail);
          showToast(`${name} failed: ${detail}`, "error");
        } else if (name === "pass") {
          // pass has no other visible effect (no chat message, no HUD change
          // until everyone else has also acted) — without this it looks
          // exactly like the button silently did nothing.
          showToast("Passed — waiting on other players.");
        }
        // Refresh right away rather than waiting up to POLL_INTERVAL_MS —
        // otherwise a successful action (e.g. Pass) looks like it did
        // nothing until the next tick.
        poll().catch((err: unknown) => console.error("poll failed:", err));
      })
      .catch((err: unknown) => {
        console.error(`${name} threw:`, err);
        showToast(`${name} failed: ${String(err)}`, "error");
      });
  };

  async function poll(): Promise<void> {
    const [view, toolsResult] = await Promise.all([fetchView(client), client.listTools()]);

    scene.syncRoster(view.roster);
    scene.setPhase(view.phase);
    scene.setWaitingOn(view.dayTurnPlayerId ?? view.dayVoteTurnPlayerId ?? view.debriefTurnPlayerId);
    if (!lastView) {
      // First poll after connecting: dump the full existing backlog into
      // the text log at once, with no camera focus/voice replay — a viewer
      // joining a game already in progress wasn't here to watch it unfold
      // live, so there's nothing to "catch up on" for the camera/TTS.
      renderNewChat(chatLogEl, undefined, view);
    } else {
      const nameOf = nameResolver(view);
      const seenIds = new Set(lastView.chatLog.map((m) => m.id));
      for (const m of view.chatLog) {
        if (!seenIds.has(m.id)) chatRevealQueue.push({ message: m, nameOf });
      }
      if (chatRevealQueue.length > 0) drainChatRevealQueue();
    }
    renderHud(hudEl, view, chatRevealQueue.length + (revealing ? 1 : 0));

    const tools = toolsResult.tools as ToolSpec[];
    const signature = actionsSignature(tools, view);
    if (signature !== lastActionsSignature) {
      renderActions(actionsEl, tools, view, callTool);
      lastActionsSignature = signature;
    }

    lastView = view;
  }

  void poll();
  const interval = setInterval(() => {
    poll().catch((err: unknown) => console.error("poll failed:", err));
  }, POLL_INTERVAL_MS);

  window.addEventListener("beforeunload", () => {
    clearInterval(interval);
    void client.close();
  });
}

connectForm.addEventListener("submit", (e) => {
  e.preventDefault();
  connectError.textContent = "";
  const url = joinUrlInput.value.trim();
  if (!url) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    connectError.textContent = "That doesn't look like a valid URL.";
    return;
  }

  const client = new Client({ name: "mafia-web-client", version: "0.1.0" });
  client
    .connect(new StreamableHTTPClientTransport(parsed))
    .then(() => startGame(client))
    .catch((err: unknown) => {
      connectError.textContent = `Couldn't connect: ${String(err)}`;
    });
});

// Convenience for local testing: `?join=<url>` skips the paste-in form.
const presetJoinUrl = new URLSearchParams(window.location.search).get("join");
if (presetJoinUrl) {
  joinUrlInput.value = presetJoinUrl;
  connectForm.requestSubmit();
}
