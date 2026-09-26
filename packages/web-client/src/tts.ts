/**
 * Speaks a chat line aloud via the browser's built-in Web Speech API — no
 * server, no API key, works offline. When speech synthesis isn't available
 * (or the user has muted it), onstart/onend still fire on a length-based
 * timer so the caller (the talk animation + camera focus) behaves exactly
 * the same either way; it just plays out silently.
 *
 * A per-player voice is picked deterministically from whatever voices the
 * browser exposes, so different players don't all sound identical. Voice
 * *quality* here is a known ceiling of this API — swapping in a richer
 * external TTS provider is planned as a later, separate upgrade.
 */

export interface SpeakHandlers {
  onstart?: () => void;
  onend?: () => void;
}

let enabled = true;
let voicesCache: SpeechSynthesisVoice[] = [];

function supported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

if (supported()) {
  const loadVoices = () => {
    voicesCache = window.speechSynthesis.getVoices();
  };
  loadVoices();
  window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function voiceFor(speakerId: string): SpeechSynthesisVoice | undefined {
  if (voicesCache.length === 0) return undefined;
  return voicesCache[hashString(speakerId) % voicesCache.length];
}

/** Live play's cap: for a real-time viewer, holding the spotlight on one speaker for a genuinely long message isn't worth it — the full text is still readable in the log either way. */
export const LIVE_DURATION_CAP_MS = 12_000;

/**
 * Roughly how long an average TTS voice takes to read `text`. Exported so
 * the caller (main.ts's/replay-main.ts's shared reveal queue, see
 * reveal-queue.ts) can use this as its own deterministic pacing timer
 * instead of depending on this module's actual onstart/onend events firing
 * reliably — real-world testing found more than one distinct way for that
 * to go wrong across browsers/environments (an utterance queued behind
 * another reported as "never started," and separately a case where
 * completion apparently never fired at all), and chasing each one
 * individually kept reintroducing the same class of bug.
 *
 * `capMs` defaults to LIVE_DURATION_CAP_MS (live play's own setting,
 * unchanged) — replay-main.ts passes a much more generous one, since a
 * recording has no "keep a live audience moving" pressure the way live
 * play does, and these models write verbosely enough in real games (a
 * game's own median message ran ~54 words, well past the point live play's
 * cap flattens everything to the same 12s) that reusing live's cap made
 * replay's pacing look like a fixed timer instead of something that
 * actually reflects message length.
 */
export function estimateDurationMs(text: string, capMs: number = LIVE_DURATION_CAP_MS): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(capMs, Math.max(900, (words / 2.5) * 1000)); // ~150wpm, floor so even short lines get a visible beat
}

export function setTtsEnabled(value: boolean): void {
  enabled = value;
  if (!value && supported()) window.speechSynthesis.cancel();
}

export function isTtsEnabled(): boolean {
  return enabled;
}

/**
 * `rateMultiplier` scales the utterance's speech rate (and the
 * silent-fallback timer below) — used by the replay renderer's speed
 * control so the voice actually speeds up along with the on-screen pacing,
 * instead of droning on past a hold time that's already moved on. Defaults
 * to 1 (unchanged) for live play, which never adjusts playback speed.
 */
export function speak(speakerId: string, text: string, handlers: SpeakHandlers = {}, rateMultiplier = 1): void {
  if (!enabled || !supported()) {
    handlers.onstart?.();
    setTimeout(() => handlers.onend?.(), estimateDurationMs(text) / rateMultiplier);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = voiceFor(speakerId);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05 * rateMultiplier;

  // Guards so whichever of (a) a real utterance event or (b) the
  // silent-drop fallback below fires first "wins," and the other becomes a
  // no-op — without this, a message queued behind an earlier one (see the
  // fallback's own comment) could fire its fake onend early *and* its real
  // onend later, double-advancing the caller's reveal-queue past the next
  // message while this one's audio was still actually playing.
  let started = false;
  let ended = false;
  const fireStart = () => {
    if (started) return;
    started = true;
    handlers.onstart?.();
  };
  const fireEnd = () => {
    if (ended) return;
    ended = true;
    handlers.onend?.();
  };

  utterance.onstart = fireStart;
  utterance.onend = fireEnd;
  utterance.onerror = fireEnd;

  window.speechSynthesis.speak(utterance);

  // Some browsers (notably some Chromebook/embedded builds) silently drop
  // utterances without ever firing onstart — this is the fallback for that.
  // But "hasn't started yet" is also completely normal for an utterance
  // still queued behind an earlier one that's still speaking (the browser's
  // synthesis queue plays one at a time) — treating that as a dropped
  // utterance after a fixed short delay was firing constantly whenever
  // messages arrived close together, advancing this caller's reveal
  // sequence far ahead of what was actually audible. Only ever treat it as
  // genuinely dropped once the synthesis engine itself is idle (nothing
  // speaking or pending) and this utterance still never started.
  const checkStarted = (): void => {
    if (started) return;
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      setTimeout(checkStarted, 200);
      return;
    }
    fireStart();
    setTimeout(fireEnd, estimateDurationMs(text) / rateMultiplier);
  };
  setTimeout(checkStarted, 400);
}
