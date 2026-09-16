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

/** Roughly how long an average TTS voice takes to read `text`, for the silent/no-speech fallback timer. */
function estimateDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(900, (words / 2.5) * 1000); // ~150wpm, floor so even short lines get a visible beat
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

  let started = false;
  utterance.onstart = () => {
    started = true;
    handlers.onstart?.();
  };
  utterance.onend = () => handlers.onend?.();
  utterance.onerror = () => handlers.onend?.();

  window.speechSynthesis.speak(utterance);

  // Some browsers (notably some Chromebook/embedded builds) silently drop
  // utterances without ever firing onstart. Fall back to the timer so the
  // avatar doesn't end up permanently mid-focus/mid-talk for that speaker.
  setTimeout(() => {
    if (!started) {
      handlers.onstart?.();
      setTimeout(() => handlers.onend?.(), estimateDurationMs(text));
    }
  }, 400);
}
