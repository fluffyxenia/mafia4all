export const ROLES = [
  "town",
  "mafia",
  "sheriff",
  "doctor",
  "jester",
  "tanner",
  "serial_killer",
  "vigilante",
  "jack_of_all_trades",
  "deep_diver",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Coarse alignment used by the win-condition tallies. Jester and Tanner are
 * "neutral" — excluded from the town-vs-hostile numeric tally and tracked
 * only via their own side-win triggers.
 */
export type Alignment = "town" | "mafia" | "serial_killer" | "neutral";

export const ROLE_ALIGNMENT: Record<Role, Alignment> = {
  town: "town",
  sheriff: "town",
  doctor: "town",
  vigilante: "town",
  jack_of_all_trades: "town",
  deep_diver: "town",
  mafia: "mafia",
  serial_killer: "serial_killer",
  jester: "neutral",
  tanner: "neutral",
};

/** Roles counted toward the numeric Town-aligned tally in win-conditions. */
export const TOWN_ALIGNED_ROLES: ReadonlySet<Role> = new Set([
  "town",
  "sheriff",
  "doctor",
  "vigilante",
  "jack_of_all_trades",
  "deep_diver",
]);

/** Roles counted toward the "hostile" tally Town must reduce to zero. */
export const HOSTILE_ROLES: ReadonlySet<Role> = new Set(["mafia", "serial_killer"]);

/** One-player investigative/action roles whose night results are private prose only. */
export const SOLO_NIGHT_ROLES: ReadonlySet<Role> = new Set([
  "sheriff",
  "doctor",
  "serial_killer",
  "vigilante",
  "jack_of_all_trades",
]);

export const NIGHT_ACTION_TYPES = [
  "mafia_kill_proposal",
  "sheriff_investigate",
  "doctor_protect",
  "deep_diver_investigate",
  "sk_kill",
  "vigilante_kill",
  "vigilante_hold",
  "joat_investigate",
  "joat_protect",
  "joat_eliminate",
] as const;

export type NightActionType = (typeof NIGHT_ACTION_TYPES)[number];

/**
 * Night action types where targeting yourself can never be a real decision
 * — you already know your own role/alignment (the investigative ones), or
 * it's simply self-destructive with no legitimate strategic reading (the
 * kill ones). Deliberately excludes doctor_protect and joat_protect:
 * self-protection is a genuine, legitimate strategic choice, not a mistake,
 * so those two are allowed to self-target.
 */
export const SELF_TARGET_FORBIDDEN_NIGHT_ACTIONS: ReadonlySet<NightActionType> = new Set([
  "mafia_kill_proposal",
  "sheriff_investigate",
  "deep_diver_investigate",
  "sk_kill",
  "vigilante_kill",
  "joat_investigate",
  "joat_eliminate",
]);

/** Which night action types a given role is permitted to submit. */
export const ROLE_NIGHT_ACTIONS: Partial<Record<Role, readonly NightActionType[]>> = {
  mafia: ["mafia_kill_proposal"],
  sheriff: ["sheriff_investigate"],
  doctor: ["doctor_protect"],
  deep_diver: ["deep_diver_investigate"],
  serial_killer: ["sk_kill"],
  vigilante: ["vigilante_kill", "vigilante_hold"],
  jack_of_all_trades: ["joat_investigate", "joat_protect", "joat_eliminate"],
};

/** JoAT's three tools are one-shot: each usable once total across the whole game. */
export type JoatCharges = {
  investigate: boolean;
  protect: boolean;
  eliminate: boolean;
};

export function initialJoatCharges(): JoatCharges {
  return { investigate: true, protect: true, eliminate: true };
}

/** Which JoAT charge (if any) a given night action type consumes. */
export function joatChargeKey(actionType: NightActionType): keyof JoatCharges | undefined {
  if (actionType === "joat_investigate") return "investigate";
  if (actionType === "joat_protect") return "protect";
  if (actionType === "joat_eliminate") return "eliminate";
  return undefined;
}
