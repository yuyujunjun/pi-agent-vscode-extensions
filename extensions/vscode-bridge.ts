/**
 * VS Code Bridge — auto-injects current editor context into pi.
 *
 * The companion VS Code extension writes /tmp/pi-active-editor.json
 * on every editor/selection change. This extension:
 *   1. Shows current file:line in the footer at all times
 *   2. Injects editor context into agent before each turn
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(tmpdir(), "pi-active-editor.json");
const POLL_MS = 1000;

interface EditorState {
  file: string;
  language: string;
  line: number;
  column: number;
  selected: string | null;
  timestamp: number;
}

function readState(): EditorState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    if (Date.now() - data.timestamp > 30000) return null;
    return data;
  } catch {
    return null;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export default function vscodeBridge(pi: ExtensionAPI): void {
  // ── Polling: update footer status with current editor info ────────
  pi.on("session_start", (_event, ctx) => {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(() => {
      const state = readState();
      if (!state) {
        ctx.ui.setStatus("vscode-bridge", undefined);
        return;
      }

      const selected = state.selected;
      let label = `📄 ${state.file}:${state.line}`;
      if (selected) {
        const snippet = selected.replace(/\n/g, " ").substring(0, 60);
        label += ` → "${snippet}${selected.length > 60 ? "…" : ""}"`;
      }

      ctx.ui.setStatus("vscode-bridge", ctx.ui.theme.fg("muted", label));
    }, POLL_MS);
  });

  pi.on("session_shutdown", () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });

  // ── Agent context injection ──────────────────────────────────────
  pi.on("before_agent_start", async () => {
    const state = readState();
    if (!state) return;

    let context = `[VS Code: @${state.file}`;
    if (state.selected) {
      const oneline = state.selected.replace(/\n/g, " ↵ ");
      context += `:${state.line} → "${oneline.substring(0, 200)}"`;
    } else {
      context += ` line ${state.line}`;
    }
    context += `]`;

    return {
      message: {
        customType: "vscode-bridge",
        content: context,
        display: false,
      },
    };
  });
}
