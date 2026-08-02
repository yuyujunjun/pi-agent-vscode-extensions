/**
 * GLM Usage Footer
 *
 * Continuously displays GLM Coding Plan quota usage in the pi footer.
 * Auto-stops when the active model is not GLM; auto-starts when it is.
 *
 * Requires the user to have:
 *   - GLM Coding Plan API key in ~/.pi/agent/auth.json under "zai-coding-cn"
 *   - GLM provider configured in ~/.pi/agent/models-store.json
 *
 * Note on the unit field
 * ----------------------
 * The "5h" / "1w" mapping is based on the unit field returned by zai's
 * quota/limit endpoint:
 *   - unit=3 → 5h rolling window  (quota 2000 for the lite plan)
 *   - unit=6 → weekly window     (quota 10000 for the lite plan)
 * zai's docs do not document what unit=3 / unit=6 mean, but the quota
 * sizes match the publicly documented 5h / weekly limits for the lite
 * plan, so the mapping is consistent for that plan at least. If zai
 * changes the encoding, this mapping will need to be updated.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

const REFRESH_MS = 60_000;
const HOME = process.env.HOME ?? "/home/tangx0b";
const PI_AUTH = join(HOME, ".pi/agent/auth.json");
const PI_STORE = join(HOME, ".pi/agent/models-store.json");
const GLM_PROVIDER = "zai-coding-cn";
const STATUS_KEY = "glm-usage";

type Auth = Record<string, { type: string; key: string }>;
type ModelEntry = { id: string; baseUrl?: string };
type ProviderStore = Record<string, { models?: ModelEntry[] }>;
type QuotaSnapshot = { plan: string; fiveHour: number; oneWeek: number } | null;

let timer: ReturnType<typeof setInterval> | undefined;

const isGlm = (m: any): boolean => {
  if (!m) return false;
  if (m.provider === GLM_PROVIDER || m.provider === "zai" || m.provider === "zhipu") {
    return true;
  }
  return /glm/i.test(m.id ?? "");
};

const loadCredentials = (): { key: string; host: string } | null => {
  try {
    const auth = JSON.parse(readFileSync(PI_AUTH, "utf-8")) as Auth;
    const store = JSON.parse(readFileSync(PI_STORE, "utf-8")) as ProviderStore;
    const key = auth[GLM_PROVIDER]?.key;
    const baseUrl = store[GLM_PROVIDER]?.models?.[0]?.baseUrl;
    if (!key || !baseUrl) return null;
    return { key, host: new URL(baseUrl).host };
  } catch {
    return null;
  }
};

const fetchQuota = (key: string, host: string): Promise<QuotaSnapshot> =>
  new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: host,
        port: 443,
        path: "/api/monitor/usage/quota/limit",
        method: "GET",
        headers: {
          Authorization: key,
          "Accept-Language": "en-US,en",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            const limits: any[] = json?.data?.limits ?? [];
            // unit=3 → 5h window  (lite quota 2000)
            // unit=6 → 1w window  (lite quota 10000)
            // Inferred from plan limits; not officially documented by zai.
            const fiveHour = limits.find((l: any) => l.unit === 3);
            const oneWeek = limits.find((l: any) => l.unit === 6);
            resolve({
              plan: json?.data?.level ?? "?",
              fiveHour: fiveHour?.percentage ?? -1,
              oneWeek: oneWeek?.percentage ?? -1,
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.end();
  });

const format = (q: QuotaSnapshot): string => {
  if (!q) return "GLM | loading…";
  const pct = (n: number) => (n < 0 ? "?" : `${n}%`);
  return `GLM ${q.plan} | 5h ${pct(q.fiveHour)} | 1w ${pct(q.oneWeek)}`;
};

const stop = (ctx?: ExtensionContext): void => {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  ctx?.ui.setStatus(STATUS_KEY, undefined);
};

const start = (ctx: ExtensionContext): void => {
  stop(ctx);
  if (!isGlm((ctx as any).model)) return;

  const refresh = async () => {
    const cred = loadCredentials();
    if (!cred) {
      if (isGlm((ctx as any).model)) {
        ctx.ui.setStatus(STATUS_KEY, "GLM | err: missing credentials");
      }
      return;
    }
    const q = await fetchQuota(cred.key, cred.host);
    // Re-check after async: model may have changed during the fetch.
    if (!isGlm((ctx as any).model)) return;
    ctx.ui.setStatus(STATUS_KEY, format(q));
  };

  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);
};

export default function glmUsageFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_e, ctx) => start(ctx));
  pi.on("model_select", (_e, ctx) => start(ctx));
  pi.on("session_shutdown", (_e, ctx) => stop(ctx));
}
