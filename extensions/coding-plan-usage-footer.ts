/**
 * Coding Plan Usage Footer
 *
 * Continuously displays coding-plan quota usage in the pi footer for any
 * registered coding-plan provider (currently GLM Coding Plan and MiniMax
 * Token Plan). Shows both the 5h rolling window and the weekly window
 * with quota-used percentage and next reset time, so you can plan ahead
 * and avoid being cut off mid-task.
 *
 * Display convention: percentages are "quota used" (e.g., "1w 20%" means
 * 20% of the weekly quota has been consumed; "5h 100%" means exhausted).
 * This matches zai's raw `percentage` field semantics and the original
 * glm-usage-footer behavior. Internally the snapshot models `remaining`
 * (because "low remaining = urgent" maps cleanly to the threshold check)
 * but `formatWindow` inverts to `used` for display.
 *
 * 5h window is color-coded based on remaining percentage:
 *   - ≥ 30% remaining → normal
 *   - 10-30% remaining → warning (yellow)
 *   - < 10% remaining or exhausted → error (red)
 * 1w window is always rendered in normal color (weekly is rarely the
 * binding constraint, so coloring it would create false alarms).
 *
 * Auto-stops when the active model is not a coding-plan provider;
 * auto-starts when the user switches back to one.
 *
 * Provider behaviors for the 5h "exhausted" state differ:
 *   - GLM Coding Plan: when 5h is exhausted the API rejects requests;
 *     show reset time so the user knows how long to wait.
 *   - MiniMax Token Plan: when 5h is exhausted, usage automatically
 *     falls back to credits; show "(积分计费)" so the user knows
 *     charges are still accruing.
 *
 * Requires the user to have:
 *   - API key in ~/.pi/agent/auth.json under the provider id
 *   - Provider configured in ~/.pi/agent/models-store.json
 *
 * The extension stores no API keys; all credentials are read from disk
 * at runtime.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

const REFRESH_MS = 60_000;
// Use pi's own config path resolution. This is cross-platform (pi uses
// os.homedir() internally, so it works on Windows / macOS / Linux), honors
// the PI_AGENT_DIR env override, and avoids hardcoding any username.
const PI_AUTH = join(getAgentDir(), "auth.json");
const PI_STORE = join(getAgentDir(), "models-store.json");
const STATUS_KEY = "coding-plan";

type Auth = Record<string, { type: string; key: string }>;
type ProviderStore = Record<string, { models?: { id: string; baseUrl?: string }[] }>;

type WindowState =
  | { kind: "normal"; remaining: number; resetAt: number }  // remaining: 0 = exhausted
  | { kind: "unlimited" };

type PlanSnapshot = {
  displayName: string;
  plan: string;             // e.g., "lite", "Plus"; empty if unknown
  fiveHour: WindowState;
  oneWeek: WindowState;
} | null;

type ProviderConfig = {
  displayName: string;
  fetchQuota: (key: string, host: string) => Promise<PlanSnapshot>;
};

let timer: ReturnType<typeof setInterval> | undefined;

// =============================================================================
// Helpers
// =============================================================================

const clampPct = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;

const formatRelativeTime = (msUntil: number): string => {
  if (!Number.isFinite(msUntil) || msUntil <= 0) return "0m";
  const totalMin = Math.floor(msUntil / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin - days * 60 * 24) / 60);
  const mins = totalMin - days * 60 * 24 - hours * 60;
  if (days >= 1) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours >= 1) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  return `${mins}m`;
};

const colorFor5h = (state: WindowState): "normal" | "warning" | "error" => {
  if (state.kind === "unlimited") return "normal";
  if (state.remaining <= 0) return "error";
  if (state.remaining < 10) return "error";
  if (state.remaining < 30) return "warning";
  return "normal";
};

const formatWindow = (
  label: string,
  state: WindowState,
  isMinimax: boolean,
  now: number,
): string => {
  if (state.kind === "unlimited") return `${label} ∞`;

  const resetStr =
    state.resetAt > 0 ? `(${formatRelativeTime(state.resetAt - now)})` : "(?)";

  // Display as "used" percentage (matches zai's `percentage` field).
  // Internally we model `remaining` so the threshold check ("low remaining
  // = urgent") is straightforward; invert here for display.
  const usedPct = state.remaining <= 0 ? 100 : 100 - state.remaining;

  if (state.remaining <= 0) {
    // Exhausted. Display differs by provider (see file header).
    if (isMinimax) return `${label} ${usedPct}% (积分计费)`;
    return `${label} ${usedPct}% ${resetStr}`;
  }

  return `${label} ${usedPct}% ${resetStr}`;
};

const format = (
  snapshot: PlanSnapshot,
  ctx: ExtensionContext,
  now: number = Date.now(),
): string => {
  if (!snapshot) return "coding-plan | loading…";
  const planLabel = snapshot.plan
    ? `${snapshot.displayName} ${snapshot.plan}`
    : snapshot.displayName;
  const isMinimax = snapshot.displayName === "Minimax";
  const fiveHourStr = formatWindow("5h", snapshot.fiveHour, isMinimax, now);
  const oneWeekStr = formatWindow("1w", snapshot.oneWeek, isMinimax, now);

  // Color only the 5h portion based on threshold.
  const color = colorFor5h(snapshot.fiveHour);
  const fiveHourColored =
    color === "normal" ? fiveHourStr : ctx.ui.theme.fg(color, fiveHourStr);

  return `${planLabel} | ${fiveHourColored} | ${oneWeekStr}`;
};

// =============================================================================
// Provider detection & credentials
// =============================================================================

const isCodingPlan = (m: any): boolean => {
  if (!m) return false;
  return typeof m.provider === "string" && m.provider in PROVIDERS;
};

const loadCredentials = (
  providerId: string,
): { key: string; host: string } | null => {
  try {
    const auth = JSON.parse(readFileSync(PI_AUTH, "utf-8")) as Auth;
    const store = JSON.parse(readFileSync(PI_STORE, "utf-8")) as ProviderStore;
    const key = auth[providerId]?.key;
    const baseUrl = store[providerId]?.models?.[0]?.baseUrl;
    if (!key || !baseUrl) return null;
    return { key, host: new URL(baseUrl).host };
  } catch {
    return null;
  }
};

// =============================================================================
// Generic HTTPS JSON fetch
// =============================================================================

const fetchJson = (
  host: string,
  path: string,
  headers: Record<string, string>,
): Promise<any> =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      { hostname: host, port: 443, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            reject(new Error("invalid JSON"));
          }
        });
      },
    );
    req.on("error", () => reject(new Error("network error")));
    req.end();
  });

// =============================================================================
// GLM (zai-coding-cn) provider
// =============================================================================
//
// Note on the unit field
// ----------------------
// The "5h" / "1w" mapping is based on the unit field returned by zai's
// quota/limit endpoint:
//   - unit=3 → 5h rolling window  (quota 2000 for the lite plan)
//   - unit=6 → weekly window     (quota 10000 for the lite plan)
// zai's docs do not document what unit=3 / unit=6 mean, but the quota
// sizes match the publicly documented 5h / weekly limits for the lite
// plan, so the mapping is consistent for that plan at least. If zai
// changes the encoding, this mapping will need to be updated.
//
// Note on the percentage field
// ----------------------------
// zai's `percentage` field is "percentage of quota used" (0..100). We
// store it internally as `remaining = 100 - percentage` (so the threshold
// check below is straightforward) and invert again in `formatWindow` for
// display, so users see "20% used" instead of "80% remaining". This
// matches the original glm-usage-footer behavior.

async function fetchGlmQuota(
  key: string,
  host: string,
): Promise<PlanSnapshot> {
  const json = await fetchJson(host, "/api/monitor/usage/quota/limit", {
    Authorization: key,  // GLM uses bare key, not Bearer.
    "Accept-Language": "en-US,en",
  });
  const limits: any[] = json?.data?.limits ?? [];
  const fiveHour = limits.find((l: any) => l.unit === 3);
  const oneWeek = limits.find((l: any) => l.unit === 6);
  return {
    displayName: "GLM",
    plan: json?.data?.level ?? "",
    fiveHour: {
      kind: "normal",
      remaining: clampPct(100 - (fiveHour?.percentage ?? 0)),
      resetAt: fiveHour?.nextResetTime ?? 0,
    },
    oneWeek: {
      kind: "normal",
      remaining: clampPct(100 - (oneWeek?.percentage ?? 0)),
      resetAt: oneWeek?.nextResetTime ?? 0,
    },
  };
}

// =============================================================================
// MiniMax Token Plan (minimax-cn / minimax) provider
// =============================================================================
//
// Field semantics gotchas (per MiniMax-M2 issue #99 and community
// documentation):
//   - `current_interval_usage_count` / `current_weekly_usage_count` are
//     misleadingly named — they return REMAINING counts, not consumed.
//     Use `current_*_remaining_percent` directly to avoid confusion.
//   - `current_*_status`:
//       1 → partial quota remaining (normal)
//       2 → window exhausted (MiniMax: falls back to credits)
//       3 → no quota / unlimited
//   - The endpoint returns multiple `model_remains` entries
//     (e.g., "general", "video"). We only look at `model_name: "general"`
//     because that's the LLM bucket for pi's coding use case; missing it
//     is surfaced as an error rather than silently picking the wrong entry.
//   - CN host: api.minimaxi.com   Global host: api.minimax.io
//     (Host is read from models-store.json baseUrl, so no hardcoding.)

const parseMinimaxWindow = (
  m: any,
  scope: "interval" | "weekly",
): WindowState => {
  const status = m[`current_${scope}_status`];
  if (status === 3) return { kind: "unlimited" };
  const resetAt = scope === "interval" ? m.end_time : m.weekly_end_time;
  return {
    kind: "normal",
    remaining: clampPct(m[`current_${scope}_remaining_percent`] ?? 0),
    resetAt: resetAt ?? 0,
  };
};

async function fetchMinimaxQuota(
  key: string,
  host: string,
): Promise<PlanSnapshot> {
  const json = await fetchJson(host, "/v1/token_plan/remains", {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  if (json?.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`api: ${json.base_resp.status_msg ?? "error"}`);
  }
  const remains: any[] = json?.model_remains ?? [];
  const general = remains.find((m: any) => m.model_name === "general");
  if (!general) {
    // Surface API anomaly rather than silently using a non-LLM entry.
    throw new Error("no general quota entry");
  }
  const plan =
    general.current_subscribe_title ??
    general.plan_name ??
    general.plan ??
    "";
  return {
    displayName: "Minimax",
    plan,
    fiveHour: parseMinimaxWindow(general, "interval"),
    oneWeek: parseMinimaxWindow(general, "weekly"),
  };
}

// =============================================================================
// Provider registry
// =============================================================================

const PROVIDERS: Record<string, ProviderConfig> = {
  "zai-coding-cn": {
    displayName: "GLM",
    fetchQuota: fetchGlmQuota,
  },
  "minimax-cn": {
    displayName: "Minimax",
    fetchQuota: fetchMinimaxQuota,
  },
};

// =============================================================================
// Lifecycle
// =============================================================================

const stop = (ctx?: ExtensionContext): void => {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  ctx?.ui.setStatus(STATUS_KEY, undefined);
};

const start = (ctx: ExtensionContext): void => {
  stop(ctx);
  const model = (ctx as any).model;
  if (!isCodingPlan(model)) return;

  const refresh = async () => {
    // Re-read model at every step — the user may have switched providers
    // while we were waiting on the network.
    const m = (ctx as any).model;
    if (!isCodingPlan(m)) return;
    const providerId: string = m.provider;
    const config = PROVIDERS[providerId];
    const errLabel = config.displayName;

    const cred = loadCredentials(providerId);
    if (!cred) {
      if (isCodingPlan((ctx as any).model)) {
        ctx.ui.setStatus(STATUS_KEY, `${errLabel} | err: missing credentials`);
      }
      return;
    }

    let snapshot: PlanSnapshot;
    try {
      snapshot = await config.fetchQuota(cred.key, cred.host);
    } catch (e) {
      if (!isCodingPlan((ctx as any).model)) return;
      ctx.ui.setStatus(
        STATUS_KEY,
        `${errLabel} | err: ${(e as Error).message}`,
      );
      return;
    }

    if (!isCodingPlan((ctx as any).model)) return;
    if (!snapshot) {
      ctx.ui.setStatus(STATUS_KEY, `${errLabel} | err: invalid response`);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, format(snapshot, ctx));
  };

  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);
};

export default function codingPlanUsageFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_e, ctx) => start(ctx));
  pi.on("model_select", (_e, ctx) => start(ctx));
  pi.on("session_shutdown", (_e, ctx) => stop(ctx));
}