const vscode = require("vscode");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const os = require("os");

const tmp = os.tmpdir();
const STATE_FILE = tmp + "/pi-active-editor.json";
const BRIDGE_FILE = tmp + "/pi-vscode-bridge.json";
const BRIDGE_TOKEN = crypto.randomBytes(24).toString("hex");

let server = null;

/**
 * VS Code companion extension for pi.
 *
 *   - Writes /tmp/pi-active-editor.json on every editor/selection change
 *   - Runs a local HTTP bridge so pi can command VS Code (e.g. close diff tabs)
 *   - Provides Ctrl+Alt+Enter for explicit context paste
 */
function activate(context) {
  // ── Auto-track active editor ────────────────────────────────────
  function writeState() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      try { fs.unlinkSync(STATE_FILE); } catch {}
      return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        file: vscode.workspace.asRelativePath(doc.uri, false),
        language: doc.languageId,
        line: sel.active.line + 1,
        column: sel.active.character + 1,
        selected: sel.isEmpty ? null : doc.getText(sel),
        timestamp: Date.now(),
      }));
    } catch {}
  }

  vscode.window.onDidChangeActiveTextEditor(() => writeState());
  vscode.window.onDidChangeTextEditorSelection(() => writeState());
  writeState();

  // ── HTTP bridge ──────────────────────────────────────────────────
  async function closeDiffEditors() {
    const toClose = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) toClose.push(tab);
      }
    }
    for (const tab of toClose) {
      try { await vscode.window.tabGroups.close(tab, true); } catch {}
    }
  }

  async function handleRPC(method, _params) {
    switch (method) {
      case "closeDiffEditors":
        await closeDiffEditors();
        return { ok: true };
      case "ping":
        return { ok: true };
      default:
        return { ok: false, error: `Unknown method: ${method}` };
    }
  }

  server = http.createServer(async (req, res) => {
    // Only POST /rpc
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404);
      res.end();
      return;
    }

    // Auth
    const auth = req.headers["x-pi-vscode-authorization"];
    if (auth !== BRIDGE_TOKEN) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    // Parse body
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const { method, params } = JSON.parse(body);
        const result = await handleRPC(method, params || {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ url, token: BRIDGE_TOKEN }));
    } catch {}
  });
  server.on("error", () => { /* port conflict etc. — ignore */ });

  context.subscriptions.push({
    dispose: () => {
      if (server) {
        server.close();
        server = null;
      }
      try { fs.unlinkSync(BRIDGE_FILE); } catch {}
    },
  });

  // ── Manual send (Ctrl+Alt+Enter) ────────────────────────────────
  const disposable = vscode.commands.registerCommand("pi.sendContext", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor.");
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const filePath = vscode.workspace.asRelativePath(document.uri, false);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    let selectedText;
    let rangeDescription;
    if (selection.isEmpty) {
      const line = document.lineAt(selection.start.line);
      const lineText = line.text.trim();
      if (lineText) {
        selectedText = line.text;
        rangeDescription = `line ${startLine}`;
      } else {
        selectedText = "";
        rangeDescription = `line ${startLine}`;
      }
    } else {
      selectedText = document.getText(selection);
      rangeDescription = startLine === endLine
        ? `line ${startLine}`
        : `lines ${startLine}-${endLine}`;
    }

    let contextMsg;
    if (selectedText.trim()) {
      const oneline = selectedText.replace(/\n/g, " ↵ ");
      contextMsg = `@${filePath}:${rangeDescription}  →  ${oneline}`;
    } else {
      contextMsg = `@${filePath}`;
    }

    const terminal = vscode.window.activeTerminal || vscode.window.terminals[0];
    if (!terminal) {
      vscode.window.showErrorMessage("No terminal found.");
      return;
    }
    terminal.show();
    await vscode.env.clipboard.writeText(contextMsg);
    await vscode.commands.executeCommand("workbench.action.terminal.paste");
  });

  context.subscriptions.push(disposable);
}

function deactivate() {
  if (server) {
    server.close();
    server = null;
  }
  try { fs.unlinkSync(STATE_FILE); } catch {}
  try { fs.unlinkSync(BRIDGE_FILE); } catch {}
}

module.exports = { activate, deactivate };
