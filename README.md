# pi-mode-manager

Three-mode editing control extension for [pi](https://github.com/earendil-works/pi-mono).

## Modes

| Mode | Command | Behavior |
|------|---------|----------|
| 🔒 **Plan** | `/plan` | Read-only. Only writes to `.plans/` are allowed. |
| 👁 **Review** | `/review` | Each edit opens a VS Code diff, then approve/decline/correct inline. |
| ⚡ **Auto-edit** | `/auto-edit` | All edits go through silently. |

## Installation

```bash
pi install git:github.com/tangx0b/pi-mode-manager
```

Or install locally:

```bash
pi install /path/to/pi-mode-manager
```

## Usage

In pi, switch modes via commands:

- `/plan` — plan mode
- `/review` — review mode (default)
- `/auto-edit` — auto-edit mode

### Review Panel

When an edit is made in review mode, a diff opens in VS Code. Switch back to the terminal (`Ctrl+\``) to see the review panel:

```
  Review: /path/to/file.py

 ▶ 1. ✓  Approve
   2. ⚡ Approve & Auto-edit
   3. ✗  Decline (revert)
   4. ✎  Decline & feedback
  ───────────────────────────────────
  ✎    (select 'Decline & feedback' to type)

  ↑↓ select  enter confirm  esc cancel
```

- Select with `↑↓`, confirm with `Enter`, cancel with `Esc`
- Option 4: type feedback directly, Enter to decline + send feedback to LLM
- Option 2: approve this edit AND switch to auto-edit mode

## License

MIT
