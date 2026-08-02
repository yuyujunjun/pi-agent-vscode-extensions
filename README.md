# pi-agent-vscode-extensions

A collection of [pi](https://github.com/earendil-works/pi-mono) extensions maintained in this repo:

- [`mode-manager`](./extensions/mode-manager.ts) — three-mode editing control (plan / review / auto-edit)
- [`vscode-bridge`](./extensions/vscode-bridge.ts) — auto-injects the current VS Code editor context into pi
- [`glm-usage-footer`](./extensions/glm-usage-footer.ts) — displays GLM Coding Plan quota usage in the pi footer

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

## glm-usage-footer

Displays GLM Coding Plan quota usage in the pi footer, so you can see when you are approaching the 5-hour or weekly limit before the API starts returning errors.

```
GLM lite | 5h 100% | 1w 20%
```

Refreshes every 60 seconds. Auto-stops when the active model is not GLM (clearing the footer); auto-restarts when you switch back to a GLM model.

### Requirements

- A GLM Coding Plan API key stored in `~/.pi/agent/auth.json` under the `zai-coding-cn` provider
- The `zai-coding-cn` provider configured in `~/.pi/agent/models-store.json` (any GLM model entry is enough; the extension only reads the base URL)

### How it works

The extension calls zai's monitor endpoint once per minute:

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
```

The response includes a `limits` array. Each entry has a `unit` field that the extension maps to:

- `unit=3` → 5h rolling window
- `unit=6` → weekly window

(Inferred from plan quota sizes matching the publicly documented 5h / weekly limits for the lite plan; not officially documented by zai.)

If the API call fails (network error, 401, etc.) the footer shows `GLM | err: …` until the next refresh succeeds.

### Caveat

zai does not document what `unit=3` / `unit=6` mean, so if they ever change the encoding, the mapping will need to be updated. The extension prefers an absolute value (e.g. `2021/2000` for the 5h window) over a percentage in a future revision if the field semantics change.

## License

MIT
