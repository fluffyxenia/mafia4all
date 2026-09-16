import type { GameState, NightActionType, PlayerId, VoteTarget } from "@mafia/shared";

/**
 * Every player-facing message should read as talking about a person, not an
 * internal id — safely a no-op for "abstain"/"request_more_messages" and
 * any other non-player string, since a failed lookup just falls back to
 * whatever was passed in.
 */
export function displayNameOf(state: GameState, playerId: PlayerId): string {
  return state.players.find((p) => p.id === playerId)?.displayName ?? playerId;
}

/**
 * Every action-with-a-target always produces some in-character statement —
 * the actor's own `reasoning` if they gave one, otherwise one of these
 * generic defaults. Guaranteeing a statement either way (rather than only
 * showing one when a model bothers to explain itself) gives every player, a
 * small local model included, a consistent pattern to both emit and read
 * back turn to turn, which is worth more for coherence than leaving the
 * field silent when empty.
 */
export function defaultNightActionStatement(actionType: NightActionType, targetName?: string): string {
  switch (actionType) {
    case "mafia_kill_proposal":
      return `Locked in on ${targetName}.`;
    case "sk_kill":
      return `Tonight, ${targetName} dies.`;
    case "vigilante_kill":
      return `Taking the shot on ${targetName}.`;
    case "vigilante_hold":
      return "I'll hold my fire for now.";
    case "doctor_protect":
      return `Protecting ${targetName} tonight.`;
    case "sheriff_investigate":
      return `Investigating ${targetName} tonight.`;
    case "deep_diver_investigate":
      return `Diving into ${targetName}'s history tonight.`;
    case "joat_investigate":
      return `Using my investigate charge on ${targetName}.`;
    case "joat_protect":
      return `Using my protect charge on ${targetName}.`;
    case "joat_eliminate":
      return `Using my eliminate charge on ${targetName}.`;
    default:
      return targetName ? `Targeting ${targetName}.` : "Taking no action tonight.";
  }
}

export function defaultVoteStatement(target: VoteTarget, targetName: string): string {
  if (target === "abstain") return "I'll abstain for now.";
  if (target === "request_more_messages") return "I need more time to discuss.";
  return `My vote goes to ${targetName}.`;
}

export function defaultJesterRevengeStatement(targetName: string): string {
  return `Taking ${targetName} down with me.`;
}
