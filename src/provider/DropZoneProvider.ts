import * as vscode from 'vscode';

interface DropItem {
  readonly label: string;
}

/**
 * A thin native tree view that serves as a no-Shift drop target for the chat.
 *
 * Extension webviews (like the Nyx chat) cannot receive Explorer drops without
 * the user holding Shift — that is a deliberate VS Code security limitation.
 * Native tree views, however, receive Explorer file/folder drops directly (no
 * Shift). This view exposes a single "drop here" row and forwards whatever is
 * dropped to the chat as attachments.
 */
export class DropZoneProvider
  implements vscode.TreeDataProvider<DropItem>, vscode.TreeDragAndDropController<DropItem>
{
  static readonly viewId = 'nyx.dropZone';

  // Explorer drags expose selected resources under `text/uri-list`; the other
  // entries cover different VS Code/Cursor versions and OS-file drops.
  readonly dropMimeTypes = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls', 'files'];
  readonly dragMimeTypes: string[] = [];

  constructor(private readonly onDrop: (uris: vscode.Uri[]) => Promise<void>) {}

  getChildren(element?: DropItem): DropItem[] {
    if (element) {
      return [];
    }
    return [{ label: 'Drop files or folders here to attach' }];
  }

  getTreeItem(element: DropItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('cloud-upload');
    item.tooltip = 'Drag files or folders from the Explorer here — no Shift needed. Or click to browse.';
    item.command = { command: 'nyx.pickAttachments', title: 'Attach files or folders' };
    return item;
  }

  async handleDrop(_target: DropItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const uris = await collectUris(dataTransfer);
    if (uris.length > 0) {
      await this.onDrop(uris);
    } else {
      void vscode.window.showWarningMessage('Nyx: could not read the dropped item(s). Try the 📎 button or right-click → “Add to Nyx context”.');
    }
  }
}

async function readItem(dt: vscode.DataTransfer, mime: string): Promise<string> {
  const item = dt.get(mime);
  if (!item) {
    return '';
  }
  try {
    return await item.asString();
  } catch {
    return typeof item.value === 'string' ? item.value : '';
  }
}

/** Extracts workspace/file URIs from a drop's data transfer, tolerant of format. */
async function collectUris(dt: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    let uri: vscode.Uri | undefined;
    try {
      uri = /^[a-zA-Z][\w+.-]*:\/\//.test(trimmed)
        ? vscode.Uri.parse(trimmed, true)
        : vscode.Uri.file(trimmed);
    } catch {
      uri = undefined;
    }
    if (uri && !seen.has(uri.toString())) {
      seen.add(uri.toString());
      out.push(uri);
    }
  };

  for (const mime of ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls']) {
    const raw = await readItem(dt, mime);
    if (!raw) {
      continue;
    }
    const text = raw.trim();
    let handledAsJson = false;
    if (text.startsWith('[')) {
      try {
        for (const entry of JSON.parse(text) as unknown[]) {
          if (typeof entry === 'string') {
            add(entry);
          } else if (entry && typeof entry === 'object') {
            const rec = entry as Record<string, unknown>;
            const val = rec.resource ?? rec.uri ?? rec.path ?? rec.fsPath;
            if (typeof val === 'string') {
              add(val);
            }
          }
        }
        handledAsJson = true;
      } catch {
        handledAsJson = false;
      }
    }
    if (!handledAsJson) {
      for (const line of text.split(/\r?\n/)) {
        add(line);
      }
    }
    if (out.length > 0) {
      return out;
    }
  }

  // OS files dropped from Finder/Explorer expose a `files` entry with a uri.
  const fileItem = dt.get('files');
  const asFile = fileItem?.asFile?.();
  if (asFile?.uri) {
    add(asFile.uri.toString());
  }
  return out;
}
