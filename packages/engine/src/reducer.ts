import {
  ROLE_NIGHT_ACTIONS,
  SELF_TARGET_FORBIDDEN_NIGHT_ACTIONS,
  joatChargeKey,
  type ChannelId,
  type ChatMessage,
  type Command,
  type CommandResult,
  type GameEvent,
  type GameState,
  type NightActionRecord,
  type NightActionType,
  type Player,
  type Vote,
} from "@mafia/shared";
import { assignRolesAndStart } from "./setup.js";
import { canSendMessage, channelWritableThisPhase, recordMessage } from "./turn-budget.js";
import { advanceDayTurn, advanceVoteQueue, currentDayTurn, currentVoteTurn, enqueuePing } from "./day-turn-order.js";
import { advanceChannelTurn, currentChannelTurn } from "./channel-turn-order.js";
import { advanceDebriefQueue, currentDebriefTurn } from "./debrief.js";
import { resolveJesterRevenge } from "./resolution/jester-revenge.js";
import { nextMessageId } from "./ids.js";
import { appendGeneratedMessage } from "./narrator.js";
import { defaultNightActionStatement, defaultVoteStatement, displayNameOf } from "./flavor.js";

/**
 * Enforced here in plain JS rather than as a zod .max() on the MCP tool
 * schema: JSON Schema's minLength/maxLength breaks at least some local
 * llama.cpp builds' grammar-constrained tool calling outright ("failed to
 * parse grammar"), so the wire schemas intentionally carry no length bounds.
 */
const MAX_MESSAGE_LENGTH = 2000;

function fail(state: GameState, error: string): CommandResult {
  return { ok: false, state, error };
}

function ok(state: GameState, events: GameEvent[]): CommandResult {
  return { ok: true, state, events };
}

function getAlivePlayer(state: GameState, playerId: string): Player | undefined {
  const p = state.players.find((x) => x.id === playerId);
  return p && p.alive ? p : undefined;
}

function playerBelongsToChannel(player: Player, channel: ChannelId): boolean {
  if (channel === "town") return true;
  if (channel === "mafia") return player.role === "mafia";
  if (channel === "deep_divers") return player.role === "deep_diver";
  if (channel.startsWith("lovers:")) return channel === `lovers:${player.loverPairId ?? ""}`;
  return false;
}

export function applyCommand(state: GameState, command: Command): CommandResult {
  switch (command.type) {
    case "start_game":
      return handleStartGame(state);
    case "send_chat":
      return handleSendChat(state, command);
    case "ping_player":
      return handlePingPlayer(state, command);
    case "cast_vote":
      return handleCastVote(state, command);
    case "night_action":
      return handleNightAction(state, command);
    case "jester_revenge":
      return handleJesterRevenge(state, command);
    case "pass":
      return handlePass(state, command);
    default:
      return fail(state, `unknown command`);
  }
}

function handleStartGame(state: GameState): CommandResult {
  if (state.phase !== "lobby") return fail(state, `cannot start game from phase '${state.phase}'`);
  const nextState = assignRolesAndStart(state);
  return ok(nextState, [
    { type: "game_started" },
    { type: "phase_changed", from: "lobby", to: "night", day: nextState.dayNumber },
  ]);
}

/**
 * The post-game debrief is deliberately not modeled through the ordinary
 * turn-budget/channelWritableThisPhase machinery below: every other channel
 * gates on `alive` (see getAlivePlayer) and a resettable per-phase budget,
 * neither of which make sense here — a dead player still owes the table
 * their one final word, and there's no "budget" to speak of, just a single
 * pass through debriefQueue that never refills.
 */
function handleDebriefChat(
  state: GameState,
  command: Extract<Command, { type: "send_chat" }>,
  channel: ChannelId,
): CommandResult {
  const player = state.players.find((p) => p.id === command.playerId);
  if (!player) return fail(state, "unknown player");
  if (channel !== "town") return fail(state, "the post-game debrief only has a town channel");
  if (currentDebriefTurn(state) !== player.id) return fail(state, "it's not your turn to speak yet");
  if (!command.message.trim()) return fail(state, "message cannot be empty");
  if (command.message.length > MAX_MESSAGE_LENGTH) return fail(state, `message exceeds ${MAX_MESSAGE_LENGTH} characters`);

  const message: ChatMessage = {
    id: nextMessageId(),
    channel,
    authorId: player.id,
    message: command.message,
    day: state.dayNumber,
    phase: state.phase,
  };
  const nextState = advanceDebriefQueue({ ...state, chatLog: [...state.chatLog, message] }, player.id);
  return ok(nextState, [{ type: "chat_sent", channel, authorId: player.id, messageId: message.id }]);
}

function handleSendChat(
  state: GameState,
  command: Extract<Command, { type: "send_chat" }>,
): CommandResult {
  const channel = command.channel as ChannelId;
  if (state.phase === "debrief") return handleDebriefChat(state, command, channel);

  const player = getAlivePlayer(state, command.playerId);
  if (!player) return fail(state, "unknown or dead player");

  if (!playerBelongsToChannel(player, channel)) return fail(state, `not a member of channel ${channel}`);
  if (!channelWritableThisPhase(channel, state)) {
    return fail(state, `channel ${channel} is not active during phase ${state.phase}`);
  }
  if (!canSendMessage(state, player.id, channel)) return fail(state, "no turns remaining in this channel");
  // Every chat channel is turn-ordered, not just town's public day
  // discussion — team channels (mafia, deep_divers, lovers) used to be
  // free-for-all, budget-limited only, on the theory that a small private
  // channel had "no fairness concern to enforce." Found in real testing to
  // be a real problem: a fast model could burn its entire night-chat budget
  // (multiple messages) before a slower teammate got a single word in.
  const isMyChannelTurn =
    channel === "town" ? currentDayTurn(state) === player.id : currentChannelTurn(state, channel) === player.id;
  if (!isMyChannelTurn) {
    return fail(state, "it's not your turn to speak yet");
  }
  if (!command.message.trim()) return fail(state, "message cannot be empty");
  if (command.message.length > MAX_MESSAGE_LENGTH) return fail(state, `message exceeds ${MAX_MESSAGE_LENGTH} characters`);

  const message: ChatMessage = {
    id: nextMessageId(),
    channel,
    authorId: player.id,
    message: command.message,
    day: state.dayNumber,
    phase: state.phase,
    ...(command.replyToPingId ? { replyToPingId: command.replyToPingId } : {}),
  };

  let nextState: GameState = { ...state, chatLog: [...state.chatLog, message] };
  nextState = recordMessage(nextState, player.id, channel);
  nextState = channel === "town" ? advanceDayTurn(nextState, player.id) : advanceChannelTurn(nextState, channel, player.id);

  return ok(nextState, [{ type: "chat_sent", channel, authorId: player.id, messageId: message.id }]);
}

function handlePingPlayer(
  state: GameState,
  command: Extract<Command, { type: "ping_player" }>,
): CommandResult {
  if (state.phase !== "day_discussion") return fail(state, "pinging is only allowed during day discussion");
  const player = getAlivePlayer(state, command.playerId);
  if (!player) return fail(state, "unknown or dead player");
  if (command.targetPlayerId === player.id) return fail(state, "cannot ping yourself");
  const target = getAlivePlayer(state, command.targetPlayerId);
  if (!target) return fail(state, "unknown or dead target");
  if (!canSendMessage(state, player.id, "town")) return fail(state, "no turns remaining");
  if (currentDayTurn(state) !== player.id) return fail(state, "it's not your turn to speak yet");
  if (!command.message.trim()) return fail(state, "message cannot be empty");
  if (command.message.length > MAX_MESSAGE_LENGTH) return fail(state, `message exceeds ${MAX_MESSAGE_LENGTH} characters`);

  const message: ChatMessage = {
    id: nextMessageId(),
    channel: "town",
    authorId: player.id,
    message: command.message,
    day: state.dayNumber,
    phase: state.phase,
    pingTargetId: target.id,
  };

  // No ping credit granted here anymore: town's cap is a single shared pool
  // (see TurnBudgetConfig's doc comment) — a ping still grants the target
  // priority to reply next (enqueuePing below), but that reply still draws
  // from the same shared pool like any other message, not a bonus beyond it.
  let nextState: GameState = { ...state, chatLog: [...state.chatLog, message] };
  nextState = recordMessage(nextState, player.id, "town");
  nextState = advanceDayTurn(nextState, player.id);
  nextState = enqueuePing(nextState, target.id);

  return ok(nextState, [
    { type: "chat_sent", channel: "town", authorId: player.id, messageId: message.id },
  ]);
}

function handleCastVote(
  state: GameState,
  command: Extract<Command, { type: "cast_vote" }>,
): CommandResult {
  if (state.phase !== "day_vote") return fail(state, "voting is only allowed during the day vote phase");
  const player = getAlivePlayer(state, command.playerId);
  if (!player) return fail(state, "unknown or dead player");
  // Sequential, like the real show-of-hands this narrates as — also avoids
  // every AI seat's LLM firing at once the instant day_vote begins.
  if (currentVoteTurn(state) !== player.id) return fail(state, "it's not your turn to vote yet");

  if (command.target === "request_more_messages" && state.requestMoreMessagesUsedToday) {
    return fail(state, "request_more_messages has already been used today");
  }
  if (command.target !== "abstain" && command.target !== "request_more_messages") {
    const target = getAlivePlayer(state, command.target);
    if (!target) return fail(state, "unknown or dead vote target");
  }

  const vote: Vote = {
    voterId: player.id,
    target: command.target,
    day: state.dayNumber,
    ...(command.reasoning ? { reasoning: command.reasoning } : {}),
  };
  const votes = [...state.votes.filter((v) => !(v.voterId === player.id && v.day === state.dayNumber)), vote];

  // Votes are cast openly — announce it as the voter's own statement in
  // town chat immediately, same as a live show-of-hands, and the natural
  // place to see the tally forming without a separate resource.
  // Reasoning replaces the boilerplate line entirely when given (rather
  // than always appearing alongside it) — anyone who bothers to type a
  // reason naturally makes their own choice clear, and stacking "My vote
  // goes to Bob." in front of a human's own sentence reads redundant.
  const statement = command.reasoning?.trim() || defaultVoteStatement(command.target, displayNameOf(state, command.target));
  let nextState: GameState = { ...state, votes };
  nextState = advanceVoteQueue(nextState, player.id);
  nextState = appendGeneratedMessage(nextState, {
    channel: "town",
    authorId: player.id,
    message: statement,
    day: state.dayNumber,
    phase: state.phase,
  });

  return ok(nextState, [{ type: "vote_cast", playerId: player.id, target: command.target }]);
}

/**
 * Investigative action types whose target may never be reused, tracked
 * across the whole game — a player's alignment is a static fact, so
 * re-investigating the same target later, cooldown or not, would only ever
 * confirm what's already known. Deliberately excludes doctor_protect: see
 * CONSECUTIVE_NIGHT_COOLDOWN_ACTIONS below.
 */
const GLOBAL_UNIQUE_TARGET_ACTIONS: readonly NightActionType[] = ["deep_diver_investigate", "sheriff_investigate"];

/**
 * Doctor protection only cools down for one night: protecting the same
 * player two nights in a row is disallowed (protection choices are meant to
 * respond to fresh circumstances each night), but the same target is fair
 * game again once a night has passed. This used to be folded into
 * GLOBAL_UNIQUE_TARGET_ACTIONS above (permanent, whole-game block) — a spec
 * slip carried over from the original design docs, not intentional design,
 * caught in real testing when a Doctor who self-protected night 1 found
 * themselves permanently unable to ever protect themselves again.
 */
const CONSECUTIVE_NIGHT_COOLDOWN_ACTIONS: readonly NightActionType[] = ["doctor_protect"];

/** Coordinated-role actions whose auto-statement is announced in their team channel instead of a private log. */
const TEAM_CHAT_ACTIONS: Partial<Record<NightActionType, ChannelId>> = {
  mafia_kill_proposal: "mafia",
  deep_diver_investigate: "deep_divers",
};

function handleNightAction(
  state: GameState,
  command: Extract<Command, { type: "night_action" }>,
): CommandResult {
  if (state.phase !== "night") return fail(state, "night actions are only allowed during the night phase");
  const player = getAlivePlayer(state, command.playerId);
  if (!player) return fail(state, "unknown or dead player");

  const allowed = ROLE_NIGHT_ACTIONS[player.role] ?? [];
  if (!allowed.includes(command.actionType)) {
    return fail(state, `role ${player.role} may not submit action ${command.actionType}`);
  }

  const needsTarget = command.actionType !== "vigilante_hold";
  if (needsTarget) {
    if (!command.targetPlayerId) return fail(state, `${command.actionType} requires a target`);
    if (SELF_TARGET_FORBIDDEN_NIGHT_ACTIONS.has(command.actionType) && command.targetPlayerId === player.id) {
      return fail(state, `${command.actionType} cannot target yourself`);
    }
    const target = getAlivePlayer(state, command.targetPlayerId);
    if (!target) return fail(state, "unknown or dead target");
  }

  if (GLOBAL_UNIQUE_TARGET_ACTIONS.includes(command.actionType)) {
    const alreadyTargeted = state.nightActions.some(
      (a) => a.actionType === command.actionType && a.targetId === command.targetPlayerId,
    );
    if (alreadyTargeted) return fail(state, "this player has already been targeted by that ability");
  }

  if (CONSECUTIVE_NIGHT_COOLDOWN_ACTIONS.includes(command.actionType)) {
    const targetedLastNight = state.nightActions.some(
      (a) =>
        a.actionType === command.actionType && a.targetId === command.targetPlayerId && a.day === state.dayNumber - 1,
    );
    if (targetedLastNight) {
      return fail(state, "you protected this player last night — choose someone else, or wait a night to protect them again");
    }
  }

  const chargeKey = joatChargeKey(command.actionType);
  if (chargeKey && !(player.joatCharges?.[chargeKey] ?? false)) {
    return fail(state, `the ${chargeKey} tool has already been used`);
  }

  const record: NightActionRecord = {
    actorId: player.id,
    actionType: command.actionType,
    day: state.dayNumber,
    ...(command.targetPlayerId ? { targetId: command.targetPlayerId } : {}),
    ...(command.reasoning ? { reasoning: command.reasoning } : {}),
  };

  // One committed action per actor per night: mafia proposals are per-actor
  // too, so each mafia member's own prior proposal (not their teammates') is replaced.
  const nightActions = [
    ...state.nightActions.filter((a) => !(a.actorId === player.id && a.day === state.dayNumber)),
    record,
  ];

  let nextState: GameState = { ...state, nightActions };
  const statement =
    command.reasoning?.trim() ||
    defaultNightActionStatement(
      command.actionType,
      command.targetPlayerId ? displayNameOf(state, command.targetPlayerId) : undefined,
    );
  const teamChannel = TEAM_CHAT_ACTIONS[command.actionType];
  if (teamChannel) {
    // Coordinated-role actions (Mafia's kill proposal, Deep Divers'
    // investigation) announce themselves in the team's own channel — this
    // is what makes proposals actually visible to teammates at all.
    nextState = appendGeneratedMessage(nextState, {
      channel: teamChannel,
      authorId: player.id,
      message: statement,
      day: state.dayNumber,
      phase: state.phase,
    });
  } else {
    // Solo roles have no channel to announce into — the statement becomes
    // their own private-log entry (visible to them now, everyone post-game).
    nextState = {
      ...nextState,
      privateLog: [
        ...nextState.privateLog,
        { ownerId: player.id, day: state.dayNumber, kind: "statement", text: statement },
      ],
    };
  }

  return ok(nextState, [
    { type: "night_action_submitted", playerId: player.id, actionType: command.actionType },
  ]);
}

function handleJesterRevenge(
  state: GameState,
  command: Extract<Command, { type: "jester_revenge" }>,
): CommandResult {
  if (state.phase !== "jester_revenge_subphase" || !state.pendingJesterRevenge) {
    return fail(state, "no jester revenge is pending");
  }
  if (command.playerId !== state.pendingJesterRevenge.jesterId) {
    return fail(state, "only the eliminated jester may act here");
  }
  if (!state.pendingJesterRevenge.eligibleTargets.includes(command.targetPlayerId)) {
    return fail(state, "target did not vote against the jester");
  }
  const { state: nextState, events } = resolveJesterRevenge(state, command.targetPlayerId, command.reasoning);
  return ok(nextState, events);
}

function handlePass(state: GameState, command: Extract<Command, { type: "pass" }>): CommandResult {
  // Checked first, ahead of the aliveness gate below: the Jester's one
  // legal moment to act in this sub-phase is specifically while dead (see
  // computeToolAvailability's isPendingJester) — routing through
  // getAlivePlayer first would reject them with "unknown or dead player"
  // on every single attempt, making it impossible to ever decline revenge.
  // Found via a real test: declining revenge failed unconditionally before
  // this fix, which would have wedged the first live game to reach here.
  if (state.phase === "jester_revenge_subphase" && state.pendingJesterRevenge) {
    if (command.playerId !== state.pendingJesterRevenge.jesterId) {
      return fail(state, "only the eliminated jester may act here");
    }
    const { state: nextState, events } = resolveJesterRevenge(state, undefined);
    return ok(nextState, events);
  }

  const player = getAlivePlayer(state, command.playerId);
  if (!player) return fail(state, "unknown or dead player");

  if (state.phase === "night") {
    // A sentinel "pass" record marks this actor done for the night without
    // taking a role action — distinct from simply never having acted, which
    // (for a solo role with no chat channel) would otherwise hang the phase
    // forever with no wall clock to fall back on.
    const nightActions = [
      ...state.nightActions.filter((a) => !(a.actorId === player.id && a.day === state.dayNumber)),
      { actorId: player.id, actionType: "pass", day: state.dayNumber },
    ];
    return ok({ ...state, nightActions }, []);
  }

  // day_discussion has no pass: a player with nothing new must send_chat and
  // say so, consuming a normal turn rather than forfeiting every remaining
  // turn for the day (see tool-availability.ts for the full rationale).
  return fail(state, `pass is not meaningful during phase ${state.phase}`);
}
