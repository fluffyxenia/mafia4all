// The host console is a plain form UI, deliberately separate from the 3D
// player client (host.html vs. index.html) — it's a pre-game setup tool,
// not something a player ever needs to see. Talks to the mcp-server's
// /admin/* routes (see packages/mcp-server/src/admin.ts), proxied through
// Vite the same way /mcp/* is.

// Local mirror of @mafia/shared's ROLES — this package deliberately stays
// independent of the engine/shared workspace packages, talking only to
// wire-shaped JSON, same reasoning as the player client's view-types.ts.
const ROLES = [
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

// Kept in sync with ai-player's own DEFAULT_OPENROUTER_FREE_MODEL (openrouter.ts)
// — this copy is only for the placeholder hint text below, never sent as a
// real request.
const DEFAULT_OPENROUTER_FREE_MODEL = "openrouter/free";
const DEFAULT_LLAMACPP_BASE_URL = "http://localhost:8080/v1";

// "kind" folds human/AI *and*, for AI, which backend — a seat's trailing
// text field means a different thing depending on which of these is picked
// (an OpenRouter model slug vs. a llama-server base URL), so keeping them
// as one choice avoids a separate backend dropdown just for AI rows.
type SeatKind = "human" | "ai-openrouter" | "ai-llamacpp";

interface SeatRow {
  rowId: number;
  displayName: string;
  color: string;
  icon: string;
  kind: SeatKind;
  /** An OpenRouter model slug, or a llama-server base URL, depending on `kind`. Empty means "use the ai-player CLI's own default". */
  aiValue: string;
  /**
   * llama.cpp only: forces `--enable-thinking=false`. Several Qwen3-family
   * Jinja templates (e.g. SmolLM3's) default to reasoning mode unless told
   * otherwise, which in real testing only converged to a real tool call
   * 7/10 times (69-209s, two reps burned the whole token budget with
   * nothing to show for it) vs. clean and fast every time with it off.
   */
  noThinking: boolean;
  /** Empty string means "random," matching every other unpinned seat — see Seat.pinnedRole in @mafia/shared. */
  pinnedRole: string;
  /**
   * llama.cpp only: routes tool descriptions through plain message content
   * instead of the native `tools` field — see LlamaCppAdapterOptions.textToolCalling.
   * Deliberately config-file-only (no inline row control): a per-seat knob
   * this rare shouldn't cost every row more width on an already-cluttered
   * (especially on mobile) host console — set it by editing a saved/loaded
   * config JSON (see the save/load-file buttons) instead.
   */
  textToolCalling: boolean;
  /**
   * Always includes the worked tool-call example on every turn, not just
   * after a detected failure — see AgentLoopOptions.alwaysIncludeToolCallExample.
   * Same config-file-only reasoning as textToolCalling above.
   */
  alwaysIncludeToolCallExample: boolean;
}

let nextRowId = 1;
const defaultColors = ["#dd4b4b", "#4b8add", "#4bdd7a", "#ddd24b", "#a14bdd", "#dd8f4b", "#4bdadd", "#dd4bb0"];

function newSeatRow(index: number): SeatRow {
  return {
    rowId: nextRowId++,
    displayName: `Player ${index + 1}`,
    color: defaultColors[index % defaultColors.length]!,
    icon: "",
    kind: "human",
    aiValue: "",
    noThinking: false,
    pinnedRole: "",
    textToolCalling: false,
    alwaysIncludeToolCallExample: false,
  };
}

interface StoredConfig {
  seats: Omit<SeatRow, "rowId">[];
  roleDistribution: Record<string, number>;
}

const LOCAL_STORAGE_KEY = "mafia-host-console-config-v1";
const ADMIN_TOKEN_STORAGE_KEY = "mafia-host-console-admin-token-v1";

function serializeConfig(): StoredConfig {
  return {
    seats: seatRows.map(({ displayName, color, icon, kind, aiValue, noThinking, pinnedRole, textToolCalling, alwaysIncludeToolCallExample }) => ({
      displayName,
      color,
      icon,
      kind,
      aiValue,
      noThinking,
      pinnedRole,
      textToolCalling,
      alwaysIncludeToolCallExample,
    })),
    roleDistribution: Object.fromEntries(roleCounts),
  };
}

function applyConfig(config: StoredConfig): void {
  // noThinking/pinnedRole/textToolCalling/alwaysIncludeToolCallExample default for configs saved before those fields existed.
  seatRows = config.seats.map((s) => ({
    ...s,
    noThinking: s.noThinking ?? false,
    pinnedRole: s.pinnedRole ?? "",
    textToolCalling: s.textToolCalling ?? false,
    alwaysIncludeToolCallExample: s.alwaysIncludeToolCallExample ?? false,
    rowId: nextRowId++,
  }));
  roleCounts.clear();
  for (const [role, count] of Object.entries(config.roleDistribution ?? {})) {
    if (count > 0) roleCounts.set(role, count);
  }
  renderSeatRows();
  renderRolesGrid();
}

function persist(): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serializeConfig()));
  } catch {
    // Best-effort only (private browsing, storage disabled, etc.) — losing
    // the auto-save safety net isn't worth surfacing an error over.
  }
}

function loadFromLocalStorage(): StoredConfig | undefined {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredConfig) : undefined;
  } catch {
    return undefined;
  }
}

let seatRows: SeatRow[] = [newSeatRow(0), newSeatRow(1), newSeatRow(2), newSeatRow(3), newSeatRow(4)];
const roleCounts = new Map<string, number>([
  ["mafia", 1],
  ["town", 4],
]);

let gameId: string | undefined;

const adminTokenInput = document.getElementById("admin-token-input") as HTMLInputElement;
try {
  adminTokenInput.value = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "";
} catch {
  // Best-effort only, same as the seat-config auto-save.
}
adminTokenInput.addEventListener("input", () => {
  try {
    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminTokenInput.value);
  } catch {
    // Best-effort only.
  }
});

/**
 * Every /admin/* call goes through this instead of a bare fetch. On the
 * default localhost-only bind the server requires no token at all (see
 * cli.ts/admin.ts), so an empty field here is the common, correct case —
 * the header is only ever load-bearing once the host opts into --bind
 * beyond loopback, at which point this is the *only* place in the whole
 * client that can supply it.
 */
function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = adminTokenInput.value.trim();
  return fetch(path, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(token ? { "x-admin-token": token } : {}) },
  });
}

const seatRowsEl = document.getElementById("seat-rows") as HTMLDivElement;
const rolesGridEl = document.getElementById("roles-grid") as HTMLDivElement;
const addSeatBtn = document.getElementById("add-seat") as HTMLButtonElement;
const saveFileBtn = document.getElementById("save-file-btn") as HTMLButtonElement;
const loadFileBtn = document.getElementById("load-file-btn") as HTMLButtonElement;
const loadFileInput = document.getElementById("load-file-input") as HTMLInputElement;
const createBtn = document.getElementById("create-btn") as HTMLButtonElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const resultEl = document.getElementById("result") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

// `.join-link`'s one-click-select-all convenience (see host.html) applies to
// whatever element it's on — keeping the URL in its own span means clicking
// the line selects just the URL, not the "Label: " prefix in front of it.
function makeJoinUrlSpan(url: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "join-url";
  span.textContent = url;
  return span;
}

function renderSeatRows(): void {
  seatRowsEl.innerHTML = "";
  for (const row of seatRows) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const nameInput = document.createElement("input");
    nameInput.className = "name-input";
    nameInput.type = "text";
    nameInput.value = row.displayName;
    nameInput.placeholder = "Display name";
    nameInput.addEventListener("input", () => {
      row.displayName = nameInput.value;
      persist();
    });

    const colorInput = document.createElement("input");
    colorInput.className = "color-input";
    colorInput.type = "color";
    colorInput.value = row.color;
    colorInput.addEventListener("input", () => {
      row.color = colorInput.value;
      persist();
    });

    const iconInput = document.createElement("input");
    iconInput.className = "icon-input";
    iconInput.type = "text";
    iconInput.value = row.icon;
    iconInput.placeholder = "Icon: emoji or image URL";
    iconInput.addEventListener("input", () => {
      row.icon = iconInput.value;
      persist();
    });

    const kindSelect = document.createElement("select");
    kindSelect.className = "kind-select";
    for (const [value, label] of [
      ["human", "Human"],
      ["ai-openrouter", "AI: OpenRouter"],
      ["ai-llamacpp", "AI: llama.cpp"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      opt.selected = row.kind === value;
      kindSelect.appendChild(opt);
    }

    const aiValueInput = document.createElement("input");
    aiValueInput.className = "ai-value-input";
    aiValueInput.type = "text";
    aiValueInput.value = row.aiValue;
    aiValueInput.addEventListener("input", () => {
      row.aiValue = aiValueInput.value;
      persist();
    });

    const noThinkingLabel = document.createElement("label");
    noThinkingLabel.className = "no-thinking-label";
    const noThinkingCheckbox = document.createElement("input");
    noThinkingCheckbox.type = "checkbox";
    noThinkingCheckbox.checked = row.noThinking;
    noThinkingCheckbox.addEventListener("change", () => {
      row.noThinking = noThinkingCheckbox.checked;
      persist();
    });
    noThinkingLabel.append(noThinkingCheckbox, document.createTextNode(" No thinking"));
    noThinkingLabel.title =
      "Forces --enable-thinking=false. For Qwen3-family templates (e.g. SmolLM3) whose own default reasoning mode is slow and unreliable at converging to a real tool call.";

    function syncAiValueField(): void {
      aiValueInput.disabled = row.kind === "human";
      aiValueInput.placeholder =
        row.kind === "ai-llamacpp"
          ? `Base URL (default: ${DEFAULT_LLAMACPP_BASE_URL})`
          : `Model slug (default: ${DEFAULT_OPENROUTER_FREE_MODEL})`;
      noThinkingLabel.hidden = row.kind !== "ai-llamacpp";
    }
    syncAiValueField();

    kindSelect.addEventListener("change", () => {
      row.kind = kindSelect.value as SeatKind;
      syncAiValueField();
      persist();
    });

    const pinnedRoleSelect = document.createElement("select");
    pinnedRoleSelect.className = "pinned-role-select";
    pinnedRoleSelect.title = "Pin this seat to a specific role instead of drawing one at random";
    const randomOpt = document.createElement("option");
    randomOpt.value = "";
    randomOpt.textContent = "Random role";
    randomOpt.selected = row.pinnedRole === "";
    pinnedRoleSelect.appendChild(randomOpt);
    for (const role of ROLES) {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = role.replace(/_/g, " ");
      opt.selected = row.pinnedRole === role;
      pinnedRoleSelect.appendChild(opt);
    }
    pinnedRoleSelect.addEventListener("change", () => {
      row.pinnedRole = pinnedRoleSelect.value;
      persist();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondary remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove seat";
    removeBtn.addEventListener("click", () => {
      seatRows = seatRows.filter((r) => r.rowId !== row.rowId);
      renderSeatRows();
      persist();
    });

    rowEl.append(nameInput, colorInput, iconInput, kindSelect, aiValueInput, noThinkingLabel, pinnedRoleSelect, removeBtn);
    seatRowsEl.appendChild(rowEl);
  }
}

function renderRolesGrid(): void {
  rolesGridEl.innerHTML = "";
  for (const role of ROLES) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = role.replace(/_/g, " ");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = String(roleCounts.get(role) ?? 0);
    input.addEventListener("input", () => {
      const n = Number(input.value) || 0;
      if (n > 0) roleCounts.set(role, n);
      else roleCounts.delete(role);
      persist();
    });
    label.append(span, input);
    rolesGridEl.appendChild(label);
  }
}

addSeatBtn.addEventListener("click", () => {
  seatRows.push(newSeatRow(seatRows.length));
  renderSeatRows();
  persist();
});

saveFileBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(serializeConfig(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mafia-game-config.json";
  a.click();
  URL.revokeObjectURL(url);
});

loadFileBtn.addEventListener("click", () => loadFileInput.click());
loadFileInput.addEventListener("change", () => {
  const file = loadFileInput.files?.[0];
  if (!file) return;
  file
    .text()
    .then((text) => {
      applyConfig(JSON.parse(text) as StoredConfig);
      persist();
    })
    .catch((err: unknown) => {
      errorEl.textContent = `Couldn't load config file: ${String(err)}`;
    })
    .finally(() => {
      loadFileInput.value = "";
    });
});

async function createGame(): Promise<void> {
  errorEl.textContent = "";
  const roleDistribution = Object.fromEntries(roleCounts);
  const seatCount = seatRows.length;
  const roleCount = [...roleCounts.values()].reduce((a, b) => a + b, 0);
  if (roleCount !== seatCount) {
    errorEl.textContent = `Role distribution has ${roleCount} role(s) but there are ${seatCount} seat(s) — these must match.`;
    return;
  }

  function aiPayload(row: SeatRow):
    | {
        backend: "openrouter" | "llamacpp";
        model?: string;
        baseUrl?: string;
        enableThinking?: boolean;
        textToolCalling?: boolean;
        alwaysIncludeToolCallExample?: boolean;
      }
    | undefined {
    if (row.kind === "ai-openrouter") return { backend: "openrouter", ...(row.aiValue ? { model: row.aiValue } : {}) };
    if (row.kind === "ai-llamacpp")
      return {
        backend: "llamacpp",
        ...(row.aiValue ? { baseUrl: row.aiValue } : {}),
        ...(row.noThinking ? { enableThinking: false } : {}),
        ...(row.textToolCalling ? { textToolCalling: true } : {}),
        ...(row.alwaysIncludeToolCallExample ? { alwaysIncludeToolCallExample: true } : {}),
      };
    return undefined;
  }

  const seats = seatRows.map((row, i) => ({
    playerId: `p${i + 1}`,
    displayName: row.displayName || `Player ${i + 1}`,
    ...(row.color ? { color: row.color } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.pinnedRole ? { pinnedRole: row.pinnedRole } : {}),
    ...(aiPayload(row) ? { ai: aiPayload(row) } : {}),
  }));

  const res = await adminFetch("/admin/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seats, roleDistribution }),
  });
  if (res.status === 401) {
    errorEl.textContent = "Admin token missing or wrong — enter the token printed in the server's startup log above.";
    return;
  }
  const body = await res.json();
  if (!res.ok) {
    errorEl.textContent = body.error ?? "failed to create game";
    return;
  }

  gameId = body.gameId;
  const selfBaseUrl = window.location.origin;
  startBtn.disabled = false;
  createBtn.disabled = true;

  resultEl.innerHTML = "";
  const heading = document.createElement("div");
  heading.textContent = `Game ${gameId} created. Join links:`;
  resultEl.appendChild(heading);
  for (const seat of body.seats as { playerId: string; displayName: string; token: string; isAi: boolean }[]) {
    const line = document.createElement("div");
    if (seat.isAi) {
      line.textContent = `${seat.displayName}: AI player launching…`;
    } else {
      const link = document.createElement("span");
      link.className = "join-link";
      link.append(`${seat.displayName}: `, makeJoinUrlSpan(`${selfBaseUrl}/?join=${seat.token}`));
      line.appendChild(link);
    }
    resultEl.appendChild(line);
  }

  const spectateRes = await adminFetch(`/admin/games/${gameId}/spectate`, { method: "POST" });
  if (spectateRes.ok) {
    const { token } = await spectateRes.json();
    const spectateLine = document.createElement("div");
    const spectateLink = document.createElement("span");
    spectateLink.className = "join-link";
    spectateLink.append(
      "Spectate (sees everything, can't act): ",
      makeJoinUrlSpan(`${selfBaseUrl}/?join=${token}`),
    );
    spectateLine.appendChild(spectateLink);
    resultEl.appendChild(spectateLine);
  }
}

async function startGame(): Promise<void> {
  if (!gameId) return;
  errorEl.textContent = "";
  const res = await adminFetch(`/admin/games/${gameId}/start`, { method: "POST" });
  if (res.status === 401) {
    errorEl.textContent = "Admin token missing or wrong — enter the token printed in the server's startup log above.";
    return;
  }
  const body = await res.json();
  if (!res.ok) {
    errorEl.textContent = body.error ?? "failed to start game";
    return;
  }
  startBtn.disabled = true;
  stopBtn.disabled = false;
  void pollStatus();
}

async function stopGame(): Promise<void> {
  if (!gameId) return;
  await adminFetch(`/admin/games/${gameId}/stop`, { method: "POST" });
  stopBtn.disabled = true;
}

let statusInterval: ReturnType<typeof setInterval> | undefined;
async function pollStatus(): Promise<void> {
  if (!gameId) return;
  const fetchOnce = async () => {
    const res = await adminFetch(`/admin/games/${gameId}`);
    if (!res.ok) return;
    const state = await res.json();
    const roster = (state.players as { id: string; displayName: string; alive: boolean; role?: string }[])
      .map((p) => `<span class="${p.alive ? "" : "dead"}">${p.displayName}${p.role ? ` (${p.role})` : ""}</span>`)
      .join(" · ");
    statusEl.innerHTML = `
      <div>Phase: ${state.phase} — Day ${state.dayNumber}</div>
      <div class="roster-line">${roster}</div>
      ${state.winner ? `<div>Winner: ${state.winner.result}</div>` : ""}
    `;
  };
  await fetchOnce();
  clearInterval(statusInterval);
  statusInterval = setInterval(() => void fetchOnce(), 2000);
}

createBtn.addEventListener("click", () => void createGame());
startBtn.addEventListener("click", () => void startGame());
stopBtn.addEventListener("click", () => void stopGame());

const stored = loadFromLocalStorage();
try {
  if (stored) applyConfig(stored);
  else throw new Error("no stored config");
} catch {
  renderSeatRows();
  renderRolesGrid();
}
