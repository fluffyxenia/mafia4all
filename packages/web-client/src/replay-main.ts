import { GameScene } from "./scene.js";
import { renderHud } from "./hud.js";
import { nameResolver } from "./chat.js";
import { setTtsEnabled } from "./tts.js";
import { RevealQueue } from "./reveal-queue.js";
import { buildReplayView, rosterAsOf, shortId, validateReplayable } from "./transcript.js";
import type { RawTranscript } from "./transcript.js";
import { getTranscript, listTranscripts, saveTranscript } from "./transcript-store.js";
import type { PlayerView, ViewChatMessage } from "./view-types.js";

const HUD_REFRESH_MS = 500;
// Live play caps a message's on-screen hold at 12s so a real-time audience
// keeps moving — replay has no such pressure, and real games run verbose
// enough (a game's own median message was ~54 words, ~22s at the formula's
// reading pace) that reusing live's cap flattened most messages to the
// same fixed 12s hold, reading like a broken timer instead of pacing tied
// to length. This is just a backstop against a truly extreme outlier (the
// same game's longest message was 287 words, ~115s uncapped) — the speed
// control is the actual way to compress overall pacing for recording.
const REPLAY_DURATION_CAP_MS = 60_000;

const pickerEl = document.getElementById("picker") as HTMLDivElement;
const pickerErrorEl = document.getElementById("picker-error") as HTMLDivElement;
const dropzoneEl = document.getElementById("dropzone") as HTMLDivElement;
const fileInputEl = document.getElementById("file-input") as HTMLInputElement;
const recentListEl = document.getElementById("recent-list") as HTMLDivElement;
const recentEmptyEl = document.getElementById("recent-empty") as HTMLDivElement;

const sceneContainer = document.getElementById("scene") as HTMLDivElement;
const hudEl = document.getElementById("hud") as HTMLDivElement;
const chatEl = document.getElementById("chat") as HTMLDivElement;
const chatLogEl = document.getElementById("chat-log") as HTMLDivElement;
const ttsToggleEl = document.getElementById("tts-toggle") as HTMLDivElement;
const ttsCheckboxEl = document.getElementById("tts-checkbox") as HTMLInputElement;
const controlsEl = document.getElementById("controls") as HTMLDivElement;
const playPauseBtn = document.getElementById("play-pause-btn") as HTMLButtonElement;
const speedSelectEl = document.getElementById("speed-select") as HTMLSelectElement;
const hideControlsBtn = document.getElementById("hide-controls-btn") as HTMLButtonElement;
const hideControlsHintEl = document.getElementById("hide-controls-hint") as HTMLDivElement;

ttsCheckboxEl.addEventListener("change", () => setTtsEnabled(ttsCheckboxEl.checked));

async function refreshRecentList(): Promise<void> {
  const metas = await listTranscripts();
  recentEmptyEl.hidden = metas.length > 0;
  recentListEl.innerHTML = "";
  for (const meta of metas) {
    const btn = document.createElement("button");
    btn.type = "button";
    const idSpan = document.createElement("span");
    idSpan.className = "id";
    idSpan.textContent = shortId(meta.id);
    const metaSpan = document.createElement("span");
    metaSpan.className = "meta";
    metaSpan.textContent = `Day ${meta.dayCount} · ${meta.playerCount}p · ${meta.winner ?? "?"} win`;
    btn.append(idSpan, metaSpan);
    btn.addEventListener("click", () => {
      void getTranscript(meta.id).then((raw) => {
        if (raw) startReplay(meta.id, raw);
      });
    });
    recentListEl.appendChild(btn);
  }
}

async function handleFile(file: File): Promise<void> {
  pickerErrorEl.textContent = "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    pickerErrorEl.textContent = "That's not valid JSON.";
    return;
  }
  if (!validateReplayable(parsed)) {
    pickerErrorEl.textContent =
      "Not a replayable transcript — only a finished game (phase \"post_game\") can be replayed.";
    return;
  }
  const id = file.name.replace(/\.json$/i, "");
  await saveTranscript(id, parsed);
  startReplay(id, parsed);
}

dropzoneEl.addEventListener("click", () => fileInputEl.click());
dropzoneEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzoneEl.classList.add("dragover");
});
dropzoneEl.addEventListener("dragleave", () => dropzoneEl.classList.remove("dragover"));
dropzoneEl.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzoneEl.classList.remove("dragover");
  const file = e.dataTransfer?.files[0];
  if (file) void handleFile(file);
});
fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files?.[0];
  if (file) void handleFile(file);
});

let speed = 1;
speedSelectEl.addEventListener("change", () => {
  speed = Number(speedSelectEl.value) || 1;
});

let scene: GameScene | undefined;
let activeRevealQueue: RevealQueue | undefined;
let hudInterval: ReturnType<typeof setInterval> | undefined;

function startReplay(id: string, raw: RawTranscript): void {
  activeRevealQueue?.stop();
  clearInterval(hudInterval);
  scene?.dispose();
  pickerEl.hidden = true;
  hudEl.hidden = false;
  chatEl.hidden = false;
  ttsToggleEl.hidden = false;
  controlsEl.hidden = false;
  chatLogEl.innerHTML = "";
  playPauseBtn.textContent = "Play";

  const finalView: PlayerView = buildReplayView(raw);
  const firstMessage: ViewChatMessage | undefined = finalView.chatLog[0];

  // Tracks "how far into the game has been shown on screen so far,"
  // starting from the very first message rather than the transcript's
  // final state — the scene and HUD are re-synced to this on every reveal
  // (see the RevealQueue's onReveal callback below) so players die
  // progressively and the day/phase/winner line track playback instead of
  // spoiling the ending on frame one.
  let shown = { day: firstMessage?.day ?? raw.dayNumber, phase: firstMessage?.phase ?? raw.phase };

  scene = new GameScene(sceneContainer);
  scene.start();
  scene.syncRoster(rosterAsOf(raw, shown.day, shown.phase));
  scene.setPhase(shown.phase);

  const revealQueue = new RevealQueue(scene, chatLogEl, () => speed, REPLAY_DURATION_CAP_MS, (m) => {
    // Re-syncing the whole roster (position/color/label writes for every
    // avatar) on literally every message — most of which don't cross a
    // day/phase boundary and so wouldn't change anything — was pure
    // overhead piled onto every single reveal. Only actually do the work
    // when the day or phase genuinely advanced.
    if (m.day === shown.day && m.phase === shown.phase) return;
    shown = { day: m.day, phase: m.phase };
    scene?.syncRoster(rosterAsOf(raw, shown.day, shown.phase));
    scene?.setPhase(shown.phase);
  });
  activeRevealQueue = revealQueue;
  const nameOf = nameResolver(finalView);

  revealQueue.setPaused(true); // start paused so recording can begin before anything plays
  for (const m of finalView.chatLog) revealQueue.push(m, nameOf);

  function refreshHud(): void {
    const done = revealQueue.pendingCount === 0;
    renderHud(hudEl, { ...finalView, ...shown, ...(done ? {} : { winner: undefined }) }, revealQueue.pendingCount);
  }
  hudInterval = setInterval(refreshHud, HUD_REFRESH_MS);
  refreshHud();

  let paused = true;
  playPauseBtn.onclick = () => {
    paused = !paused;
    revealQueue.setPaused(paused);
    playPauseBtn.textContent = paused ? "Play" : "Pause";
  };

  history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
}

let controlsHidden = false;
function setControlsHidden(hidden: boolean): void {
  controlsHidden = hidden;
  controlsEl.dataset.hidden = String(hidden);
  hideControlsHintEl.hidden = !hidden;
}
hideControlsBtn.addEventListener("click", () => setControlsHidden(true));
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "h" && pickerEl.hidden) setControlsHidden(!controlsHidden);
});

void refreshRecentList();

// Convenience for reloading a replay already open in this tab (see
// startReplay's history.replaceState) — not a cross-machine sharing
// mechanism, since the transcript itself lives only in this browser's
// IndexedDB cache, not on any server.
const presetId = new URLSearchParams(window.location.search).get("id");
if (presetId) {
  void getTranscript(presetId).then((raw) => {
    if (raw) startReplay(presetId, raw);
  });
}
