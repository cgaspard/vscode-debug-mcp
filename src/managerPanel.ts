import * as vscode from 'vscode';
import { reportAll, installerById, type HarnessStatusReport, type HarnessContext, type Scope } from './harness';
import { ClaudeCodeInstaller } from './harnesses/claudeCode';

/**
 * Webview-based manager: shows every supported harness with its user- and
 * project-scope state, and Install / Uninstall buttons for each scope. The
 * config writing goes through the HarnessInstaller implementations; this file
 * is only the UI and the message plumbing.
 */
export class ManagerPanel {
  public static current: ManagerPanel | undefined;
  private static readonly viewType = 'vscodeDebugMcp.manager';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionPath: string;
  private disposables: vscode.Disposable[] = [];
  private busy = false;

  static show(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal(column);
      void ManagerPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ManagerPanel.viewType,
      'Debug MCP — Harnesses',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ManagerPanel.current = new ManagerPanel(panel, context.extensionPath);
  }

  private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
    this.panel = panel;
    this.extensionPath = extensionPath;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    void this.refresh();
  }

  /** Build the context for installer calls: extension path + current workspace. */
  private ctx(): HarnessContext {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return { extensionPath: this.extensionPath, projectDir: folder?.uri.fsPath };
  }

  private async onMessage(msg: any): Promise<void> {
    if (this.busy) return;
    switch (msg?.type) {
      case 'refresh':
        await this.refresh();
        break;
      case 'install':
        await this.runAction('install', msg.id, msg.scope, msg.includeSkill);
        break;
      case 'uninstall':
        await this.runAction('uninstall', msg.id, msg.scope);
        break;
      case 'openConfig':
        if (typeof msg.path === 'string') {
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (err) {
            vscode.window.showWarningMessage(`Could not open ${msg.path}: ${err instanceof Error ? err.message : err}`);
          }
        }
        break;
    }
  }

  private async runAction(action: 'install' | 'uninstall', id: string, scope: Scope, includeSkill?: boolean): Promise<void> {
    const installer = installerById(id as any);
    if (!installer) return;
    const ctx = this.ctx();

    // Conflict warning: installing at project scope while user scope is already
    // configured means the project entry shadows/duplicates the user one.
    if (action === 'install' && scope === 'project') {
      const report = (await reportAll(ctx)).find((r) => r.installer.id === id);
      if (report?.status.user.configured) {
        const proceed = await vscode.window.showWarningMessage(
          `${installer.displayName} is already configured at user scope. A project entry will also apply here and may duplicate it. Add the project entry anyway?`,
          { modal: true },
          'Add to project'
        );
        if (proceed !== 'Add to project') return;
      }
    }

    this.busy = true;
    this.post({ type: 'busy', busy: true });
    try {
      let result;
      if (action === 'install') {
        result =
          installer instanceof ClaudeCodeInstaller && scope === 'user'
            ? await installer.installUser(ctx, includeSkill ?? true)
            : await installer.install(ctx, scope);
      } else {
        result = await installer.uninstall(ctx, scope);
      }

      if (result.ok) {
        vscode.window.showInformationMessage(
          `${installer.displayName} (${scope}): ${result.messages.join('. ')}. Reload the harness to pick up changes.`
        );
      } else {
        vscode.window.showErrorMessage(`${installer.displayName} (${scope}): ${result.error}`);
      }
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    const ctx = this.ctx();
    const reports = await reportAll(ctx);
    const rows = await Promise.all(reports.map((r) => this.toRow(r)));
    if (!this.panel.webview.html) {
      this.panel.webview.html = this.html(this.panel.webview);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.post({ type: 'state', rows, projectName: folder?.name ?? null });
  }

  private async toRow(r: HarnessStatusReport): Promise<any> {
    const supportsSkill = r.installer instanceof ClaudeCodeInstaller;
    return {
      id: r.installer.id,
      name: r.installer.displayName,
      blurb: r.installer.blurb,
      detected: r.status.detected,
      scopes: r.installer.scopes,
      user: r.status.user,
      project: r.status.project ?? null,
      supportsSkill,
      skillInstalled: supportsSkill ? await (r.installer as ClaudeCodeInstaller).skillInstalled() : false
    };
  }

  private post(message: any): void {
    void this.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
  h1 { font-size: 1.2em; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 14px; font-size: 0.9em; }
  .toolbar { margin-bottom: 14px; }

  /* Each harness is a distinct card so rows read as separate blocks. */
  .card { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
          border: 1px solid var(--vscode-panel-border); border-radius: 8px;
          padding: 14px 16px; margin-bottom: 14px;
          display: flex; gap: 18px; align-items: flex-start; }
  .info { flex: 1 1 auto; min-width: 0; }
  .actions { flex: 0 0 auto; display: flex; flex-direction: column; gap: 10px; align-items: stretch; min-width: 210px; }

  .name { font-size: 1.06em; font-weight: 600; margin: 0 0 3px; }
  .blurb { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 0 0 8px; }
  .badges { display: inline-flex; gap: 6px; flex-wrap: wrap; vertical-align: middle; margin-left: 4px; }
  .badge { font-size: 0.72em; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); }
  .badge.on { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; border-color: transparent; }
  .badge.off { opacity: 0.55; }
  .badge.warn { background: var(--vscode-editorWarning-foreground, #d29922); color: #000; border-color: transparent; }
  .scopeline { font-size: 0.8em; margin-top: 6px; }
  .scopeline .lbl { font-weight: 600; }
  .path { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.76em;
          color: var(--vscode-descriptionForeground); word-break: break-all; }
  .path a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .path a:hover { text-decoration: underline; }
  .detail { font-size: 0.76em; color: var(--vscode-descriptionForeground); margin-top: 1px; }

  .group { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; }
  .group .gtitle { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.04em;
                   color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .btnrow { display: flex; gap: 6px; }
  button { font-family: inherit; font-size: 0.88em; padding: 4px 12px; border: none; border-radius: 4px;
           cursor: pointer; white-space: nowrap; flex: 1 1 auto;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.4; cursor: default; }
  label.skill { font-size: 0.78em; display: flex; align-items: center; gap: 5px; margin-top: 6px; }
  .na { font-size: 0.76em; color: var(--vscode-descriptionForeground); font-style: italic; }
  .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>Manage AI harnesses</h1>
  <p class="sub">Install or remove the Debug MCP server in each AI coding tool. <b>User</b> scope applies everywhere; <b>project</b> scope writes into the current workspace and is committed with the repo.</p>
  <div class="toolbar"><button class="secondary" id="refresh" style="flex:0 0 auto;">Refresh</button></div>
  <div id="cards"><p class="empty">Loading…</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let busy = false;
  let projectName = null;
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'busy') { busy = m.busy; setDisabled(busy); }
    else if (m.type === 'state') { projectName = m.projectName; render(m.rows); }
  });

  function setDisabled(d) { document.querySelectorAll('button').forEach((b) => { b.disabled = d; }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

  function badge(on, onText, offText, warn) {
    const cls = warn ? 'warn' : (on ? 'on' : 'off');
    return '<span class="badge ' + cls + '">' + (warn ? offText : (on ? onText : offText)) + '</span>';
  }

  // Render the User / Project action group for one scope of one harness.
  function group(id, scope, st, supported, skillToggle) {
    const title = scope === 'user' ? 'User (all projects)' : ('Project' + (projectName ? ' — ' + esc(projectName) : ''));
    if (!supported) {
      return '<div class="group"><div class="gtitle">' + title + '</div><div class="na">Not applicable</div></div>';
    }
    if (scope === 'project' && !st) {
      return '<div class="group"><div class="gtitle">' + title + '</div><div class="na">Open a folder to enable</div></div>';
    }
    const installLabel = st && st.configured ? (st.stale ? 'Update' : 'Reconfigure') : 'Install';
    return '<div class="group">' +
      '<div class="gtitle">' + title + '</div>' +
      '<div class="btnrow">' +
        '<button class="install" data-id="' + id + '" data-scope="' + scope + '">' + installLabel + '</button>' +
        '<button class="secondary uninstall" data-id="' + id + '" data-scope="' + scope + '"' + (st && st.configured ? '' : ' disabled') + '>Uninstall</button>' +
      '</div>' + (skillToggle || '') +
    '</div>';
  }

  function scopeLine(label, st) {
    if (!st) return '';
    const b = st.stale ? badge(false, '', 'Needs update', true) : badge(st.configured, 'Configured', 'Not configured');
    return '<div class="scopeline"><span class="lbl">' + label + ':</span> ' + b +
      '<div class="path"><a data-path="' + esc(st.configPath) + '" class="open">' + esc(st.configPath) + '</a></div>' +
      (st.detail ? '<div class="detail">' + esc(st.detail) + '</div>' : '') +
    '</div>';
  }

  function render(rows) {
    const root = document.getElementById('cards');
    root.innerHTML = '';
    rows.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'card';
      const supportsUser = r.scopes.indexOf('user') !== -1;
      const supportsProject = r.scopes.indexOf('project') !== -1;
      const detBadge = (r.id === 'generic') ? '' : badge(r.detected, 'Detected', 'Not detected');
      const skillToggle = r.supportsSkill
        ? '<label class="skill"><input type="checkbox" id="skill-' + r.id + '"' + (r.skillInstalled ? ' checked' : '') + ' /> also install usage skill</label>'
        : '';

      card.innerHTML =
        '<div class="info">' +
          '<div class="name">' + esc(r.name) + ' <span class="badges">' + detBadge + '</span></div>' +
          '<div class="blurb">' + esc(r.blurb) + '</div>' +
          (supportsUser ? scopeLine('User', r.user) : '') +
          (supportsProject ? scopeLine('Project', r.project) : '') +
        '</div>' +
        '<div class="actions">' +
          group(r.id, 'user', r.user, supportsUser, skillToggle) +
          group(r.id, 'project', r.project, supportsProject, '') +
        '</div>';
      root.appendChild(card);
    });

    root.querySelectorAll('.install').forEach((b) => b.addEventListener('click', () => {
      const id = b.getAttribute('data-id');
      const scope = b.getAttribute('data-scope');
      const skillEl = document.getElementById('skill-' + id);
      vscode.postMessage({ type: 'install', id, scope, includeSkill: skillEl ? skillEl.checked : undefined });
    }));
    root.querySelectorAll('.uninstall').forEach((b) => b.addEventListener('click', () => {
      vscode.postMessage({ type: 'uninstall', id: b.getAttribute('data-id'), scope: b.getAttribute('data-scope') });
    }));
    root.querySelectorAll('.open').forEach((a) => a.addEventListener('click', () => {
      vscode.postMessage({ type: 'openConfig', path: a.getAttribute('data-path') });
    }));
    if (busy) setDisabled(true);
  }

  vscode.postMessage({ type: 'refresh' });
</script>
</body>
</html>`;
  }

  private dispose(): void {
    ManagerPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
