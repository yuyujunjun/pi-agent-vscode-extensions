/**
 * Mode Manager Extension
 *
 * Three operating modes for editing control:
 * - plan:      Read-only. Only writes to .plans/ are allowed.
 * - review:    Each edit opens a VS Code diff, then an inline panel for approve/decline/feedback.
 * - auto-edit: All edits go through silently, no user interruption.
 *
 * Commands:  /plan, /review, /auto-edit
 * Status:    Current mode shown in footer (🔒 PLAN / 👁 REVIEW / ⚡ AUTO)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

type Mode = "plan" | "review" | "auto-edit";

interface BackupEntry {
  filePath: string;
  backupPath: string;
  isNewFile: boolean;
}

interface ReviewResult {
  action: "approve" | "approve-auto" | "decline" | "decline-feedback";
  feedback?: string;
}

interface ReviewItem {
  label: string;
  icon: string;
  action: ReviewResult["action"];
}

// ── Constants ───────────────────────────────────────────────────────────────

const MODE_CONFIG: Record<Mode, { label: string; color: string; emoji: string }> = {
  plan:       { label: "PLAN",   color: "warning", emoji: "🔒" },
  review:     { label: "REVIEW", color: "accent",  emoji: "👁" },
  "auto-edit": { label: "AUTO",  color: "success", emoji: "⚡" },
};

const EDIT_TOOLS = new Set(["write", "edit"]);

/** Paths allowed in plan mode (simple prefix match against absolute path). */
const PLAN_MODE_ALLOWED = [".plans/"];

function isAllowedInPlan(filePath: string, cwd: string): boolean {
  const abs = filePath.startsWith("/") ? filePath : join(cwd, filePath);
  return PLAN_MODE_ALLOWED.some((prefix) => abs.includes(prefix));
}

const REVIEW_ITEMS: ReviewItem[] = [
  { label: "Approve",               icon: "✓", action: "approve" },
  { label: "Approve & Auto-edit",   icon: "⚡", action: "approve-auto" },
  { label: "Decline (revert)",      icon: "✗", action: "decline" },
  { label: "Decline & feedback",    icon: "✎", action: "decline-feedback" },
];

const FEEDBACK_INDEX = REVIEW_ITEMS.length - 1;

// ── Helpers ─────────────────────────────────────────────────────────────────

const BRIDGE_FILE = join(tmpdir(), "pi-vscode-bridge.json");

interface BridgeInfo {
  url: string;
  token: string;
}

let bridgeCache: BridgeInfo | null | undefined;
let bridgeCacheTime = 0;

function getBridgeInfo(): BridgeInfo | null {
  // Small cache so we don't re-read the file for every review in a batch
  if (bridgeCache !== undefined && Date.now() - bridgeCacheTime < 5000) {
    return bridgeCache;
  }
  try {
    if (!existsSync(BRIDGE_FILE)) { bridgeCache = null; return null; }
    const raw = JSON.parse(readFileSync(BRIDGE_FILE, "utf-8"));
    bridgeCache = { url: raw.url, token: raw.token };
    bridgeCacheTime = Date.now();
    return bridgeCache;
  } catch {
    bridgeCache = null;
    return null;
  }
}

async function callVSCodeBridge(method: string, params?: Record<string, unknown>): Promise<boolean> {
  const bridge = getBridgeInfo();
  if (!bridge) return false;
  try {
    const res = await fetch(`${bridge.url}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pi-vscode-authorization": bridge.token,
      },
      body: JSON.stringify({ method, params: params || {} }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.result?.ok === true;
  } catch {
    return false;
  }
}

function getBackupDir(): string {
  const dir = join(tmpdir(), "pi-mode-manager");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

function getFilePath(input: Record<string, unknown>): string {
  return (input.path as string) || "";
}

// ── Review Panel Component ──────────────────────────────────────────────────

class ReviewPanel {
  private selected = 0;
  private feedbackInput: Input;

  constructor(private title: string) {
    this.feedbackInput = new Input();
  }

  onDone?: (result: ReviewResult | null) => void;

  private confirm(): void {
    const item = REVIEW_ITEMS[this.selected]!;
    if (item.action === "decline-feedback") {
      this.onDone?.({ action: "decline-feedback", feedback: this.feedbackInput.getValue() });
    } else {
      this.onDone?.({ action: item.action });
    }
  }

  handleInput(data: string): void {
    // Navigation keys — always intercepted
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(REVIEW_ITEMS.length - 1, this.selected + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.confirm();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.onDone?.(null);
      return;
    }

    // When feedback option is selected, route everything else to the Input component
    if (this.selected === FEEDBACK_INDEX) {
      this.feedbackInput.handleInput(data);
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Title
    lines.push(truncateToWidth(`  Review: ${this.title}`, width));
    lines.push("");

    // Options
    for (let i = 0; i < REVIEW_ITEMS.length; i++) {
      const isSel = i === this.selected;
      const num = (i + 1).toString();
      const icon = REVIEW_ITEMS[i]!.icon;
      const cursor = isSel ? "▶" : " ";
      const label = ` ${cursor} ${num}. ${icon}  ${REVIEW_ITEMS[i]!.label}`;
      lines.push(truncateToWidth(label, width));
    }

    // Feedback input — always visible so user knows it exists
    lines.push(truncateToWidth("  ───────────────────────────────────", width));

    const isFeedback = this.selected === FEEDBACK_INDEX;
    this.feedbackInput.focused = isFeedback;

    if (isFeedback) {
      const inputLines = this.feedbackInput.render(width - 4);
      if (inputLines.length === 0 || inputLines[0] === "") {
        lines.push(truncateToWidth("  ✎ |  (type your feedback here)", width));
      } else {
        for (const line of inputLines) {
          lines.push(`  ${line}`);
        }
      }
    } else {
      const current = this.feedbackInput.getValue();
      if (current) {
        lines.push(truncateToWidth(`  ✎    ${current}`, width));
      } else {
        lines.push(truncateToWidth("  ✎    (select 'Decline & feedback' to type)", width));
      }
    }

    lines.push("");
    lines.push(truncateToWidth("  ↑↓ select  enter confirm  esc cancel", width));

    return lines;
  }

  invalidate(): void {
    this.feedbackInput.invalidate();
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function modeManager(pi: ExtensionAPI): void {
  let currentMode: Mode = "review";
  const backups = new Map<string, BackupEntry>();

  // ── Status display ────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    const cfg = MODE_CONFIG[currentMode];
    ctx.ui.setStatus("mode-manager", ctx.ui.theme.fg(cfg.color, `${cfg.emoji} ${cfg.label}`));
  }

  function setMode(mode: Mode, ctx: ExtensionContext): void {
    if (mode === currentMode) return;
    const prev = currentMode;
    currentMode = mode;
    updateStatus(ctx);

    const cfg = MODE_CONFIG[mode];
    ctx.ui.notify(
      `Switched: ${MODE_CONFIG[prev].label} → ${ctx.ui.theme.fg(cfg.color, cfg.label)}`,
      "info"
    );
  }

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Switch to plan mode (read-only, .plans/ writes allowed)",
    handler: async (_args, ctx) => setMode("plan", ctx),
  });

  pi.registerCommand("review", {
    description: "Switch to review mode (approve each edit via diff)",
    handler: async (_args, ctx) => setMode("review", ctx),
  });

  pi.registerCommand("auto-edit", {
    description: "Switch to auto-edit mode (edits go through without prompts)",
    handler: async (_args, ctx) => setMode("auto-edit", ctx),
  });

  // ── Session lifecycle ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  // ── Tool call interception ────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    if (!isEditTool(toolName)) return;

    // Plan mode: only allow writes to whitelisted paths (e.g. .plans/)
    if (currentMode === "plan") {
      const filePath = getFilePath(event.input);
      if (filePath && isAllowedInPlan(filePath, ctx.cwd)) return;

      return {
        block: true,
        reason:
          `Plan mode is active (${MODE_CONFIG.plan.emoji} PLAN). ` +
          `Only writes to ${PLAN_MODE_ALLOWED.join(", ")} are allowed. ` +
          `Switch to REVIEW or AUTO mode for other changes: /review or /auto-edit`,
      };
    }

    // Auto-edit: let everything through
    if (currentMode === "auto-edit") return;

    // Review mode: backup the target file before the tool executes
    const filePath = getFilePath(event.input);
    if (!filePath) return;

    const backupDir = getBackupDir();
    const backupPath = join(backupDir, `${Date.now()}_${Buffer.from(event.toolCallId).toString("hex").slice(0, 8)}`);

    if (existsSync(filePath)) {
      writeFileSync(backupPath, readFileSync(filePath));
      backups.set(event.toolCallId, { filePath, backupPath, isNewFile: false });
    } else {
      backups.set(event.toolCallId, { filePath, backupPath, isNewFile: true });
    }
  });

  // ── Tool result interception (review mode prompt) ─────────────────────

  pi.on("tool_result", async (event, ctx) => {
    if (currentMode !== "review") return;
    if (!isEditTool(event.toolName)) return;

    const backup = backups.get(event.toolCallId);
    if (!backup) return;
    backups.delete(event.toolCallId);

    const { filePath, backupPath, isNewFile } = backup;

    // If the tool itself errored, skip review — let the LLM see the error
    if (event.isError) {
      tryCleanup(backupPath);
      return;
    }

    try {
      // ── Open VS Code diff ──────────────────────────────────────────
      if (isNewFile) {
        ctx.ui.notify(`New file: ${filePath}`, "info");
      } else {
        try {
          execSync(`code -d "${backupPath}" "${filePath}"`, { stdio: "ignore", timeout: 5000 });
        } catch {
          ctx.ui.notify("VS Code diff unavailable.", "warning");
        }
      }

      // ── Inline review panel ────────────────────────────────────────
      const result = await ctx.ui.custom<ReviewResult | null>(
        (_tui, _theme, _keybindings, done) => {
          const panel = new ReviewPanel(filePath);
          panel.onDone = done;
          return {
            render: (w: number) => panel.render(w),
            handleInput: (data: string) => {
              panel.handleInput(data);
              _tui.requestRender();
            },
            invalidate: () => panel.invalidate(),
          };
        }
      );

      if (!result) {
        // Cancelled (escape)
        revertEdit(backup);
        ctx.ui.notify("Review cancelled — reverted.", "warning");
        return {
          content: [{ type: "text", text: `Cancelled: edit to "${filePath}" was reverted.` }],
          isError: true,
        };
      }

      switch (result.action) {
        case "approve":
          ctx.ui.notify("Approved.", "success");
          break;

        case "approve-auto":
          currentMode = "auto-edit";
          updateStatus(ctx);
          ctx.ui.notify("Approved. Switched to AUTO mode.", "success");
          break;

        case "decline":
          revertEdit(backup);
          ctx.ui.notify("Declined — reverted.", "warning");
          ctx.abort();
          pi.sendMessage({
            customType: "review-rejection",
            content: `The user rejected your previous edit to "${filePath}". The change has been reverted. Follow the user's next instruction.`,
            display: true,
          }, { deliverAs: "nextTurn" });
          return {
            content: [{ type: "text", text: `❌ Edit to "${filePath}" was declined by user and reverted.` }],
            isError: true,
          };

        case "decline-feedback":
          revertEdit(backup);
          ctx.ui.notify("Declined + feedback sent.", "info");
          return {
            content: [{
              type: "text",
              text: `The user rejected your previous edit to "${filePath}". The change has been reverted.\n\nUser feedback: ${result.feedback?.trim() || "(no details)"}`,
            }],
            isError: true,
          };
      }
    } finally {
      tryCleanup(backupPath);
      // Close diff tabs in VS Code and switch back to original file
      if (!isNewFile) {
        try { execSync(`code -g "${filePath}"`, { stdio: "ignore", timeout: 3000 }); } catch { /* ok */ }
        callVSCodeBridge("closeDiffEditors").catch(() => {});
      }
    }
  });
}

// ── Utilities ───────────────────────────────────────────────────────────────

function revertEdit(backup: BackupEntry): void {
  if (backup.isNewFile) {
    try {
      if (existsSync(backup.filePath)) unlinkSync(backup.filePath);
    } catch { /* best effort */ }
  } else {
    try {
      writeFileSync(backup.filePath, readFileSync(backup.backupPath));
    } catch { /* best effort */ }
  }
}

function tryCleanup(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best effort */ }
}
