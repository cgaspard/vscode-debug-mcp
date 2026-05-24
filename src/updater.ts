import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

const REPO = 'cgaspard/vscode-debug-mcp';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const LAST_CHECK_KEY = 'debugMcp.updater.lastCheck';
const DISMISSED_VERSION_KEY = 'debugMcp.updater.dismissedVersion';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
  html_url: string;
}

// "v1.2.3" / "1.2.3-rc.1" -> [1,2,3, "rc.1"]
function parseSemver(v: string): { core: [number, number, number]; pre?: string } | undefined {
  const cleaned = v.replace(/^v/, '');
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
}

function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] > b.core[i]) return true;
    if (a.core[i] < b.core[i]) return false;
  }
  // Cores equal. Pre-release < release (e.g. 1.0.0-rc.1 < 1.0.0)
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  if (a.pre && b.pre) return a.pre > b.pre;
  return false;
}

function httpGetJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'vscode-debug-mcp-updater',
          Accept: 'application/vnd.github+json',
          ...headers
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpGetJson(res.headers.location, headers));
        }
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`GitHub returned HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('GitHub request timeout')));
  });
}

function httpDownload(url: string, dest: string, progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'vscode-debug-mcp-updater',
          Accept: 'application/octet-stream'
        }
      },
      async (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpDownload(res.headers.location, dest, progress));
        }
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length'] ?? 0);
        let received = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          received += c.length;
          if (progress && total) {
            const pct = Math.round((received / total) * 100);
            progress.report({ message: `Downloading… ${pct}%` });
          }
        });
        res.on('end', async () => {
          try {
            await fs.writeFile(dest, Buffer.concat(chunks));
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Download timeout')));
  });
}

async function fetchLatestRelease(): Promise<GitHubRelease | undefined> {
  try {
    const data = (await httpGetJson(RELEASES_API)) as GitHubRelease;
    if (data?.draft) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

function pickVsixAsset(release: GitHubRelease): ReleaseAsset | undefined {
  return release.assets.find((a) => a.name.endsWith('.vsix'));
}

async function installVsix(file: string): Promise<void> {
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
}

export interface CheckOptions {
  silent?: boolean; // if true, suppress UI when no update / errors
  force?: boolean;  // if true, bypass interval throttle
}

export async function checkForUpdate(context: vscode.ExtensionContext, opts: CheckOptions = {}): Promise<void> {
  const pkg = context.extension.packageJSON as { version: string };
  const currentVersion: string = pkg.version;

  if (!opts.force) {
    const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
  }
  await context.globalState.update(LAST_CHECK_KEY, Date.now());

  const release = await fetchLatestRelease();
  if (!release) {
    if (!opts.silent) {
      vscode.window.showWarningMessage('Debug MCP: could not reach GitHub to check for updates.');
    }
    return;
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  if (!isNewer(latestVersion, currentVersion)) {
    if (!opts.silent) {
      vscode.window.showInformationMessage(
        `Debug MCP is up to date (v${currentVersion}).`
      );
    }
    return;
  }

  if (!opts.force) {
    const dismissed = context.globalState.get<string>(DISMISSED_VERSION_KEY);
    if (dismissed === latestVersion) return;
  }

  const asset = pickVsixAsset(release);
  const installable = Boolean(asset);

  const actions: string[] = [];
  if (installable) actions.push('Install update');
  actions.push('View release', 'Skip this version', 'Remind me later');

  const message = `Debug MCP v${latestVersion} is available (you have v${currentVersion}).`;
  const answer = await vscode.window.showInformationMessage(message, ...actions);

  if (answer === 'View release') {
    await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    return;
  }
  if (answer === 'Skip this version') {
    await context.globalState.update(DISMISSED_VERSION_KEY, latestVersion);
    return;
  }
  if (answer !== 'Install update' || !asset) return;

  try {
    const tmpFile = path.join(os.tmpdir(), `vscode-debug-mcp-${latestVersion}.vsix`);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Debug MCP ${latestVersion}`,
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Downloading…' });
        await httpDownload(asset.browser_download_url, tmpFile, progress);
        progress.report({ message: 'Installing…' });
        await installVsix(tmpFile);
      }
    );
    const reload = await vscode.window.showInformationMessage(
      `Debug MCP v${latestVersion} installed. Reload window to activate.`,
      'Reload now',
      'Later'
    );
    if (reload === 'Reload now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Debug MCP update failed: ${msg}. You can try again or download the .vsix manually from the GitHub release.`);
    await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  }
}
