import * as vscode from 'vscode';
import { SidebarProvider } from './provider/SidebarProvider';
import { DropZoneProvider } from './provider/DropZoneProvider';
import { NyxCompletionProvider } from './autocomplete/completer';
import { checkForUpdates } from './updater';

const RIGHT_SIDE_PROMPT_KEY = 'nyx.rightSidePrompted';

/**
 * Reveals and focuses the Nyx view. VS Code auto-registers a `<viewId>.focus`
 * command for every contributed view; calling it un-hides the view even after it
 * was moved to the panel/secondary bar and then closed (the "it disappeared" case).
 */
async function showNyx(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    return;
  } catch {
    // fall through to revealing the container
  }
  try {
    await vscode.commands.executeCommand('workbench.view.extension.nyx');
  } catch {
    // ignore – best effort
  }
}

/**
 * Recovers a lost/hidden Nyx panel by resetting all view locations to their
 * defaults (VS Code has no per-view reset), then re-focuses Nyx on the left.
 */
async function resetNyxLocation(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.resetViewLocations');
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch {
    // ignore – still try to focus below
  }
  await showNyx();
  void vscode.window.showInformationMessage('Nyx panel location was reset — it is back in the left activity bar.');
}

/**
 * Relocates the Nyx view into the Secondary Side Bar (right), mirroring Cursor's
 * agent panel. VS Code 1.105 has no silent per-view move API, so we focus the
 * view first (avoids the "no view focused" error) and then open the built-in
 * destination picker, where the user chooses "Secondary Side Bar".
 */
async function moveNyxToRight(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch {
    // ignore – focusing is best-effort
  }
  try {
    await vscode.commands.executeCommand('workbench.action.moveFocusedView');
    return;
  } catch {
    // ignore – fall back to manual guidance below
  }
  void vscode.window.showInformationMessage(
    'To move Nyx, drag the Nyx icon onto the right (secondary) side bar. If it ever disappears, run “Nyx: Show Panel” or “Nyx: Reset Panel Location”.',
  );
}

async function maybePromptMoveRight(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(RIGHT_SIDE_PROMPT_KEY)) {
    return;
  }
  await context.globalState.update(RIGHT_SIDE_PROMPT_KEY, true);
  const move = 'Move to the right';
  const choice = await vscode.window.showInformationMessage(
    'Nyx can live in the right side bar, next to Cursor\u2019s own panel. Move it now? A picker will open \u2014 choose "Secondary Side Bar". If it ever disappears, run "Nyx: Show Panel" from the Command Palette.',
    move,
    'Keep on the left',
  );
  if (choice === move) {
    await moveNyxToRight();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => provider.dispose() },
    vscode.commands.registerCommand('nyx.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('nyx.moveToRight', () => {
      void moveNyxToRight();
    }),
    vscode.commands.registerCommand('nyx.show', () => {
      void showNyx();
    }),
    vscode.commands.registerCommand('nyx.resetLocation', () => {
      void resetNyxLocation();
    }),
    vscode.commands.registerCommand('nyx.refreshModels', () => {
      void provider.refreshModels();
    }),
    vscode.commands.registerCommand('nyx.attachToNyx', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = uris && uris.length > 0 ? uris : uri ? [uri] : [];
      if (targets.length > 0) {
        void provider.attachUris(targets);
      }
    }),
    vscode.commands.registerCommand('nyx.attachActiveFile', () => {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active) {
        void provider.attachUris([active]);
      }
    }),
    vscode.commands.registerCommand('nyx.attachSelection', () => {
      void provider.attachSelection();
    }),
    vscode.commands.registerCommand('nyx.pickAttachments', () => {
      void provider.pickAttachments();
    }),
    vscode.commands.registerCommand('nyx.buildIndex', () => {
      void provider.buildSemanticIndex(false);
    }),
    vscode.commands.registerCommand('nyx.rebuildIndex', () => {
      void provider.buildSemanticIndex(true);
    }),
    vscode.commands.registerCommand('nyx.checkForUpdates', () => {
      void checkForUpdates(context, true);
    }),
    vscode.commands.registerCommand('nyx.exportChat', () => {
      void provider.exportCurrentSession();
    }),
    vscode.commands.registerCommand('nyx.copyChat', () => {
      void provider.copySessionToClipboard();
    }),
    vscode.commands.registerCommand('nyx.quickEdit', () => {
      void provider.quickEdit();
    }),
    vscode.commands.registerCommand('nyx.runQueue', () => {
      void provider.startBatchRun();
    }),
  );
  void checkForUpdates(context);

  // Tab autocomplete (fill-in-the-middle on a small local model, opt-in).
  const completer = new NyxCompletionProvider();
  context.subscriptions.push(
    completer,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completer),
    vscode.commands.registerCommand('nyx.toggleAutocomplete', async () => {
      const cfg = vscode.workspace.getConfiguration('nyx');
      const next = !(cfg.get<boolean>('autocompleteEnabled') ?? false);
      await cfg.update('autocompleteEnabled', next, vscode.ConfigurationTarget.Global);
      completer.updateStatusItem();
      void vscode.window.setStatusBarMessage(`Nyx tab autocomplete: ${next ? 'on' : 'off'}`, 2500);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nyx.autocompleteEnabled') || e.affectsConfiguration('nyx.autocompleteModel')) {
        completer.updateStatusItem();
      }
    }),
  );

  // Native "drop files here" strip. Unlike the chat webview, a tree view accepts
  // Explorer drops without the Shift key, giving a reliable no-Shift attach path.
  const dropZone = new DropZoneProvider((uris) => provider.attachUris(uris));
  context.subscriptions.push(
    vscode.window.createTreeView(DropZoneProvider.viewId, {
      treeDataProvider: dropZone,
      dragAndDropController: dropZone,
      showCollapseAll: false,
    }),
  );

  // A permanent status-bar entry point so Nyx is always reachable, even if its
  // activity-bar icon disappears after the view is dragged out of its container.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(sparkle) Nyx';
  statusItem.tooltip = 'Show the Nyx panel';
  statusItem.command = 'nyx.show';
  statusItem.show();
  context.subscriptions.push(statusItem);

  void maybePromptMoveRight(context);
}

export function deactivate(): void {
  // no-op
}
