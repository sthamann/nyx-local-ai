import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = 'sthamann/nyx-local-ai';
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
const LAST_CHECK_KEY = 'nyx.lastUpdateCheck';
const SKIP_KEY = 'nyx.skipVersion';

function parseVersion(v: string): number[] {
  return v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0);
    }
  }
  return false;
}

/**
 * Once a day: compares the newest GitHub release against the installed
 * version and offers a one-click in-editor update (download the .vsix, install
 * via the built-in command, reload). No telemetry — a single anonymous
 * releases API call, disable with nyx.updateCheck.
 */
export async function checkForUpdates(context: vscode.ExtensionContext, force = false): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('nyx');
  if (!force && !(cfg.get<boolean>('updateCheck') ?? true)) {
    return;
  }
  const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
  if (!force && Date.now() - last < CHECK_INTERVAL_MS) {
    return;
  }
  await context.globalState.update(LAST_CHECK_KEY, Date.now());

  let latestTag: string;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as { tag_name?: string };
    latestTag = data.tag_name ?? '';
  } catch {
    return; // offline — perfectly fine for a local-first tool
  }

  const current = String(context.extension.packageJSON.version ?? '0.0.0');
  if (!latestTag || !isNewer(latestTag, current)) {
    if (force) {
      void vscode.window.showInformationMessage(`Nyx ${current} is up to date.`);
    }
    return;
  }
  if (!force && context.globalState.get<string>(SKIP_KEY) === latestTag) {
    return;
  }

  const update = 'Update now';
  const notes = 'Release notes';
  const skip = 'Skip this version';
  const choice = await vscode.window.showInformationMessage(
    `Nyx ${latestTag} is available (you have v${current}).`,
    update,
    notes,
    skip,
  );
  if (choice === notes) {
    void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${REPO}/releases/tag/${latestTag}`));
    return;
  }
  if (choice === skip) {
    await context.globalState.update(SKIP_KEY, latestTag);
    return;
  }
  if (choice !== update) {
    return;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating Nyx to ${latestTag}…` },
      async () => {
        const url = `https://github.com/${REPO}/releases/download/${latestTag}/nyx-local-ai.vsix`;
        const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!res.ok) {
          throw new Error(`download failed: HTTP ${res.status}`);
        }
        const file = path.join(os.tmpdir(), `nyx-local-ai-${latestTag}.vsix`);
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        await fs.rm(file, { force: true }).catch(() => undefined);
      },
    );
    const reload = 'Reload window';
    const pick = await vscode.window.showInformationMessage(`Nyx ${latestTag} installed.`, reload);
    if (pick === reload) {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Nyx update failed: ${e instanceof Error ? e.message : String(e)}. You can update manually via the install script.`,
    );
  }
}
