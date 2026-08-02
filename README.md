# pi-agent-vscode-extensions

A collection of [pi](https://github.com/earendil-works/pi-mono) extensions maintained in this repo:

- [`mode-manager`](./extensions/mode-manager.ts) — three-mode editing control (plan / review / auto-edit)
- [`vscode-bridge`](./extensions/vscode-bridge.ts) — auto-injects the current VS Code editor context into pi
- [`coding-plan-usage-footer`](./extensions/coding-plan-usage-footer.ts) — displays coding-plan quota usage (GLM, MiniMax) in the pi footer, with 5h/weekly windows and reset times

## Installation

```bash
pi install git:github.com/tangx0b/pi-mode-manager
```

Or install locally:

```bash
pi install /path/to/pi-mode-manager
```

## mode-manager

Three-mode editing control.

### Modes

| Mode | Command | Behavior |
|------|---------|----------|
| 🔒 **Plan** | `/plan` | Read-only. Only writes to `.plans/` are allowed. |
| 👁 **Review** | `/review` | Each edit opens a VS Code diff, then approve/decline/correct inline. |
| ⚡ **Auto-edit** | `/auto-edit` | All edits go through silently. |

### Usage

In pi, switch modes via commands:

- `/plan` — plan mode
- `/review` — review mode (default)
- `/auto-edit` — auto-edit mode

#### Review Panel

When an edit is made in review mode, a diff opens in VS Code. Switch back to the terminal (`Ctrl+\``) to see the review panel:

```
  Review: /path/to/file.py

 ▶ 1. ✓  Approve
   2. ⚡ Approve & Auto-edit
   3. ✗  Decline (revert)
   4. ✎  Decline & feedback
  ───────────────────────────────────
  ✎    (select 'Decline & feedback' to type)

  ↑↓ select  enter enter confirm  esc cancel
```

- Select with `↑↓`, confirm with `Enter`, cancel with `Esc`
- Option 4: type feedback directly, Enter to decline + send feedback to LLM
- Option 2: approve this edit AND switch to auto-edit mode

## vscode-bridge

The companion VS Code extension (`vscode-send-context/`) writes the current editor state (file / line / column / selection) to `/tmp/pi-active-editor.json` on every edit. The `vscode-bridge` pi extension reads that file and:

- Shows `file:line` in the pi footer at all times
- Injects the editor context into the agent before each turn

See `vscode-send-context/` for the VS Code side of the bridge.

## coding-plan-usage-footer

Displays coding-plan quota usage in the pi footer for any registered provider (currently GLM Coding Plan and MiniMax Token Plan), so you can see when you are approaching the 5-hour or weekly limit before the API starts rejecting requests.

```
GLM lite | 5h 35% (4h12m) | 1w 20% (5d3h)
Minimax Plus | 5h 100% (积分计费) | 1w ∞
```

Display convention: percentages are **quota used** (e.g., "1w 20%" means 20% of the weekly quota has been consumed). Lower is better; 100% means exhausted. This matches zai's raw `percentage` field and the original glm-usage-footer output.

Refreshes every 60 seconds. Auto-stops when the active model is not a coding-plan provider (clearing the footer); auto-restarts when you switch back to one.

### What you see

- **`<provider> <plan>`** — e.g., `GLM lite`, `Minimax Plus`
- **5h** — quota-used percentage and time until reset, color-coded:
  - normal: used < 70%
  - warning (yellow): used 70–90%
  - error (red): used > 90% or exhausted
- **1w** — quota-used percentage and time until weekly reset (not color-coded)
- **Exhausted 5h** — different display per provider:
  - GLM: `5h 100% (1h23m)` — shows reset time, since requests are rejected when exhausted
  - MiniMax: `5h 100% (积分计费)` — usage falls back to credits, so show the mode
- **Unlimited weekly** (MiniMax only): `1w ∞`

### Requirements

- API keys stored in `~/.pi/agent/auth.json` under each provider id (`zai-coding-cn`, `minimax-cn`, ...)
- Each provider configured in `~/.pi/agent/models-store.json` (the extension only reads the base URL)
- No hardcoded secrets — credentials are loaded from disk at runtime

### How it works

The extension maintains a provider registry. When the active model's `provider` matches a registered provider, it polls that provider's quota endpoint every 60 seconds.

**GLM (`zai-coding-cn`):**
```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Authorization: <bare-key>
```
The response includes a `limits` array with a `unit` field that the extension maps to:
- `unit=3` → 5h rolling window
- `unit=6` → weekly window

(Inferred from plan quota sizes matching the publicly documented 5h / weekly limits for the lite plan; not officially documented by zai.)

**MiniMax (`minimax-cn`):**
```
GET https://api.minimaxi.com/v1/token_plan/remains
Authorization: Bearer <key>
```
The response includes `model_remains[]` entries. The extension picks `model_name: "general"` (the LLM bucket) and reads `current_interval_*` (5h) and `current_weekly_*` (weekly) fields. `current_*_status === 3` means the window is unlimited (no cap).

### Caveats

- zai does not document what `unit=3` / `unit=6` mean. If they ever change the encoding, the mapping will need to be updated.
- MiniMax's `current_*_usage_count` fields are misleadingly named — they return **remaining** counts, not consumed. The extension uses `current_*_remaining_percent` to avoid this confusion.
- MiniMax's weekly window is unlimited on the user's plan tier (`status: 3`), so only 5h is a hard cap. No monthly cap exists — only the 5h and weekly windows control Token Plan usage.

### Adding a new provider

Append to the `PROVIDERS` table in `coding-plan-usage-footer.ts`:

```ts
const PROVIDERS: Record<string, ProviderConfig> = {
  // ...
  "new-provider-id": {
    displayName: "NewProvider",
    fetchQuota: async (key, host): Promise<PlanSnapshot> => { /* ... */ },
  },
};
```

The default-export factory function never needs to change.

## License

MIT
