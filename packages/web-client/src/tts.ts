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

/**
 * Roughly how long an average TTS voice takes to read `text`. Exported so
 * the caller (main.ts's chat-reveal queue) can use this as its own
 * deterministic pacing timer instead of depending on this module's actual
 * onstart/onend events firing reliably — real-world testing found more
 * than one distinct way for that to go wrong across browsers/environments
 * (an utterance queued behind another reported as "never started," and
 * separately a case where completion apparently never fired at all), and
 * chasing each one individually kept reintroducing the same class of bug.
 * Capped at 12s regardless of length: for a viewer, holding the spotlight
 * on one speaker for a genuinely long message isn't worth it — the full
 * text is still readable in the log either way.
 */
export function estimateDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(12_000, Math.max(900, (words / 2.5) * 1000)); // ~150wpm, floor so even short lines get a visible beat
}

export function setTtsEnabled(value: boolean): void {
  enabled = value;
  if (!value && supported()) window.speechSynthesis.cancel();
}

export function isTtsEnabled(): boolean {
  return enabled;
}

export function speak(speakerId: string, text: string, handlers: SpeakHandlers = {}): void {
  if (!enabled || !supported()) {
    handlers.onstart?.();
    setTimeout(() => handlers.onend?.(), estimateDurationMs(text));
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = voiceFor(speakerId);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;

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
    setTimeout(fireEnd, estimateDurationMs(text));
  };
  setTimeout(checkStarted, 400);
}
