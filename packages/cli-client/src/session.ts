import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { defaultChannelFor, formatNewActivity, formatSummary, HELP_TEXT } from "./render.js";
import { parseInput } from "./parse.js";
import type { CliPlayerView } from "./view-types.js";

export interface CliSessionOptions {
  client: Client;
  input: Readable;
  output: Writable;
  /** Called once the user quits or input ends. */
  onClose?: () => void;
}

const VIEW_URI = "mafia://me/view";

/**
 * Line-oriented REPL over a connected MCP client. Deliberately not a
 * full-screen TUI (no curses/blessed) — cheaper RSS/CPU and it behaves
 * better over a laggy SSH session on constrained hardware, per the design
 * doc's Chromebook/Pi target. Streams are injected so this can be driven by
 * tests without a real terminal.
 */
export class CliSession {
  private lastView: CliPlayerView | undefined;

  constructor(private opts: CliSessionOptions) {}

  private print(line: string): void {
    this.opts.output.write(`${line}\n`);
  }

  private async fetchView(): Promise<CliPlayerView> {
    const result = await this.opts.client.readResource({ uri: VIEW_URI });
    const first = result.contents[0] as { text: string };
    return JSON.parse(first.text) as CliPlayerView;
  }

  private async refresh(announce: boolean): Promise<CliPlayerView> {
    const view = await this.fetchView();
    if (announce) {
      for (const line of formatNewActivity(this.lastView, view)) this.print(line);
      if (!this.lastView || this.lastView.phase !== view.phase) this.print(formatSummary(view));
    }
    this.lastView = view;
    return view;
  }

  private async callTool(tool: string, args: Record<string, unknown>): Promise<void> {
    const result = (await this.opts.client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    if (result.isError) {
      this.print(`error: ${result.content[0]?.text ?? "unknown error"}`);
    }
    await this.refresh(true);
  }

  async handleLine(line: string): Promise<void> {
    const parsed = parseInput(line);
    switch (parsed.kind) {
      case "empty":
        return;
      case "help":
        this.print(HELP_TEXT);
        return;
      case "quit":
        this.print("bye.");
        this.opts.onClose?.();
        return;
      case "view":
        this.print(formatSummary(await this.fetchView()));
        return;
      case "error":
        this.print(`error: ${parsed.message}`);
        return;
      case "chat_shorthand": {
        const view = this.lastView ?? (await this.fetchView());
        const channel = defaultChannelFor(view);
        if (!channel) {
          this.print("no writable channel right now — use /chat, /vote, or /action explicitly.");
          return;
        }
        await this.callTool("send_chat", { channel, message: parsed.message });
        return;
      }
      case "tool":
        await this.callTool(parsed.tool, parsed.args);
        return;
    }
  }

  /** Starts polling for activity from other players while the REPL is idle. */
  startPolling(intervalMs = 2000): NodeJS.Timeout {
    return setInterval(() => {
      this.refresh(true).catch((err: unknown) => this.print(`error refreshing: ${String(err)}`));
    }, intervalMs);
  }

  async start(): Promise<void> {
    // Announce=true so a freshly-connected (or reconnecting) player sees
    // the full backlog — chat and narrator announcements (deaths,
    // eliminations) that happened before this session existed. refresh()
    // already prints a summary itself on this first call (no previous view
    // to compare phases against), so there's no need to print one again here.
    await this.refresh(true);
    this.print(HELP_TEXT);

    const poller = this.startPolling();
    const rl = readline.createInterface({ input: this.opts.input, output: this.opts.output, terminal: false });
    try {
      for await (const line of rl) {
        await this.handleLine(line);
      }
    } finally {
      clearInterval(poller);
      rl.close();
    }
  }
}
