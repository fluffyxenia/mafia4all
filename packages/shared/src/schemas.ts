import { z } from "zod";
import { NIGHT_ACTION_TYPES, ROLES } from "./roles.js";

export const RoleSchema = z.enum(ROLES);
export const NightActionTypeSchema = z.enum(NIGHT_ACTION_TYPES);

// Deliberately no .min()/.max() on any string field below (channel,
// message, targetPlayerId, reasoning, etc.). Those compile to JSON Schema's
// minLength/maxLength, which at least some local llama.cpp builds' GBNF
// grammar converter cannot parse — a tool with such a field fails outright
// ("failed to parse grammar") the moment it's offered to the model, which
// silently breaks every tool but `pass` for local-model players. Length
// bounds that actually matter (e.g. a message cap) are enforced in the
// engine reducer instead, in plain JS, not via the schema.
export const VoteTargetSchema = z.union([
  z.string(),
  z.literal("abstain"),
  z.literal("request_more_messages"),
]);

export const SendChatInput = z.object({
  channel: z.string(),
  message: z.string(),
  // .nullish() (undefined OR null), not .optional() (undefined only): a
  // model unsure about an optional field will sometimes emit an explicit
  // `null` rather than omit the key entirely — .optional() alone rejects
  // that as a schema violation, burning a strike toward the 3-strikes
  // fallback (see agent-loop.ts) over a field the model never needed to
  // set in the first place. Every consumer already does a plain truthy
  // check (`replyToPingId ? ... : ...`), which treats null and undefined
  // identically, so this needs no other code changes.
  replyToPingId: z.string().nullish(),
});

export const PingPlayerInput = z.object({
  targetPlayerId: z.string(),
  message: z.string(),
});

export const ReasoningField = z
  .string()
  .nullish()
  .describe(
    "Your in-character reasoning for this choice. If given, this becomes your entire visible statement as-is (nothing is added in front of it) — so make sure it actually states your choice, not just your justification, e.g. \"Locked in on p3, they've been too quiet\" rather than just \"they've been too quiet.\" If omitted, a short generic line naming your choice is posted instead. Length should match the situation: one line is fine when the read is obvious or you have little to go on; a few sentences of real chain-of-thought are worth it when you're weighing conflicting evidence. Strongly recommended — this is your visible in-game statement and how you (and everyone reading the transcript) stay coherent turn to turn.",
  );

export const CastVoteInput = z.object({
  target: VoteTargetSchema,
  reasoning: ReasoningField,
});

export const NightActionInput = z.object({
  actionType: NightActionTypeSchema,
  // Same .nullish() reasoning as replyToPingId above — a solo role's
  // night_action (e.g. Vigilante's hold) genuinely has no target, and a
  // model expressing that as explicit `null` shouldn't fail schema
  // validation over it.
  targetPlayerId: z.string().nullish(),
  reasoning: ReasoningField,
});

export const JesterRevengeInput = z.object({
  targetPlayerId: z.string(),
  reasoning: ReasoningField,
});
