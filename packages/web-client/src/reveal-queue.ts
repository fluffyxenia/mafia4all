import type { GameScene } from "./scene.js";
import { appendPinnedToBottom, renderMessage } from "./chat.js";
import { estimateDurationMs, LIVE_DURATION_CAP_MS, speak } from "./tts.js";
import type { ViewChatMessage } from "./view-types.js";

interface QueueItem {
  message: ViewChatMessage;
  nameOf: (id: string) => string;
}

/**
 * Reveals chat messages one at a time (text bubble + camera focus + TTS),
 * each one holding the camera until its own hold timer elapses before
 * starting the next — shared by main.ts (live polling) and replay-main.ts
 * (a static transcript) so a future pacing fix only needs to happen once.
 * See main.ts's git history for why this exists: without it, a burst of
 * fast-arriving messages fights over the camera and can yank focus off a
 * still-"talking" player.
 *
 * Paced by our own setTimeout, deliberately NOT by speak()'s own
 * onstart/onend events — real-world testing found more than one distinct
 * way for those to be unreliable across browsers/environments. speak() is
 * called purely for best-effort audio.
 */
export class RevealQueue {
  private queue: QueueItem[] = [];
  private revealing = false;
  private paused = false;
  private holdTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private scene: GameScene,
    private chatLogEl: HTMLElement,
    /** Playback speed multiplier: 2 halves every hold time and doubles the TTS rate. Defaults to 1 (unchanged, live play's only setting). */
    private speed: () => number = () => 1,
    /** Ceiling on a single message's hold time before speed is applied — see estimateDurationMs's capMs. Defaults to live play's own LIVE_DURATION_CAP_MS. */
    private capMs: number = LIVE_DURATION_CAP_MS,
    /**
     * Fired the instant a message is appended to the log (before its hold
     * timer starts), with that message's own day/phase — lets a caller
     * (replay-main.ts) track "how far into the game has been shown so far"
     * for its own progressive HUD/roster state, without this class needing
     * to know anything about GameState shapes itself. Live play (main.ts)
     * doesn't need this — every message it reveals is already current.
     */
    private onReveal?: (message: ViewChatMessage) => void,
  ) {}

  /** Queues a message for reveal; starts draining immediately if idle. */
  push(message: ViewChatMessage, nameOf: (id: string) => string): void {
    this.queue.push({ message, nameOf });
    this.drain();
  }

  /** Already-resolved messages not yet shown on screen — including the one currently mid-reveal. */
  get pendingCount(): number {
    return this.queue.length + (this.revealing ? 1 : 0);
  }

  get isRevealing(): boolean {
    return this.revealing;
  }

  /** Pausing holds the current message on screen (if one is revealing) but stops advancing to the next; unpausing resumes draining. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.drain();
  }

  /**
   * Discards everything queued and cancels any in-flight hold timer,
   * without touching the DOM or camera — call before abandoning this queue
   * (e.g. replay-main.ts switching to a different transcript) so a stray
   * callback doesn't fire later against a scene that's since been
   * disposed.
   */
  stop(): void {
    this.queue = [];
    this.paused = true;
    if (this.holdTimeout !== undefined) clearTimeout(this.holdTimeout);
    this.revealing = false;
  }

  private drain(): void {
    if (this.revealing || this.paused) return;
    const next = this.queue.shift();
    if (!next) return;
    this.revealing = true;
    const { message: m, nameOf } = next;
    appendPinnedToBottom(this.chatLogEl, renderMessage(m, nameOf));
    this.onReveal?.(m);

    if (m.system) {
      // Narrator lines (deaths, phase announcements) have no speaker to
      // focus the camera on or voice — reveal instantly and move on, rather
      // than holding up real players' queued messages behind them.
      this.revealing = false;
      this.drain();
      return;
    }

    const speed = this.speed();
    this.scene.focus(m.authorId);
    this.scene.startTalking(m.authorId);
    speak(m.authorId, m.message, {}, speed);
    this.holdTimeout = setTimeout(
      () => {
        this.scene.stopTalking(m.authorId);
        this.scene.unfocus();
        this.revealing = false;
        this.drain();
      },
      estimateDurationMs(m.message, this.capMs) / speed,
    );
  }
}
