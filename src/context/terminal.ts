import * as vscode from 'vscode';

export interface TerminalCapture {
  /** Terminal tab name, e.g. "zsh". */
  name: string;
  /** The visible scrollback text (tail-truncated to maxChars). */
  text: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures the scrollback of the active integrated terminal.
 *
 * VS Code has no stable buffer-read API, so this uses the select-all →
 * copy-selection commands and reads the clipboard, restoring the user's
 * clipboard afterwards. The short sleeps give the terminal service time to
 * apply each command.
 */
export async function captureActiveTerminal(maxChars = 12000): Promise<TerminalCapture | undefined> {
  const terminal = vscode.window.activeTerminal ?? vscode.window.terminals[0];
  if (!terminal) {
    return undefined;
  }
  const previousClipboard = await vscode.env.clipboard.readText();
  try {
    terminal.show(true);
    await sleep(60);
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await sleep(60);
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await sleep(60);
    await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
    let text = (await vscode.env.clipboard.readText()).replace(/\s+$/, '');
    if (text === previousClipboard.replace(/\s+$/, '')) {
      // Copy did not change the clipboard — most likely an empty terminal.
      text = '';
    }
    if (text.length > maxChars) {
      text = `… [older output truncated]\n${text.slice(-maxChars)}`;
    }
    return { name: terminal.name, text };
  } catch {
    return undefined;
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
  }
}
