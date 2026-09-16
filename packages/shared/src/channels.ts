export type PlayerId = string;

/**
 * Chat-capable channels. Solo investigative/action roles (Sheriff, Doctor,
 * SK, Vigilante, JoAT) do not chat at all — they only read a private
 * system-generated night-action log, which is not a ChannelId.
 */
export type ChannelId =
  | "town"
  | "mafia"
  | "deep_divers"
  | `lovers:${string}`;

export function loversChannel(pairId: string): ChannelId {
  return `lovers:${pairId}`;
}

export function isLoversChannel(channel: ChannelId): channel is `lovers:${string}` {
  return channel.startsWith("lovers:");
}

export function loversPairIdFromChannel(channel: ChannelId): string {
  if (!isLoversChannel(channel)) {
    throw new Error(`not a lovers channel: ${channel}`);
  }
  return channel.slice("lovers:".length);
}

/** Which game phase a channel is active (writable) during. */
export function channelActivePhase(channel: ChannelId): "day_discussion" | "night" {
  return channel === "town" ? "day_discussion" : "night";
}
