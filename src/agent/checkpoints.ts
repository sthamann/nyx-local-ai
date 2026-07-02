import * as vscode from 'vscode';

/** Pre-edit file states captured at one user-message boundary. */
export interface Checkpoint {
  id: string;
  /** Index into the model message history where this checkpoint was taken. */
  messageIndex: number;
  /** Relative path → original content (undefined = file did not exist). */
  files: Map<string, string | undefined>;
}

export interface SerializedCheckpoint {
  id: string;
  messageIndex: number;
  files: Array<{ path: string; content: string | null }>;
}

/**
 * Workspace checkpoints, one per user message. Before the agent's first
 * modification of a file within a run, the original content is captured; a
 * restore rewrites every captured file (or deletes files that didn't exist).
 */
export class CheckpointStore {
  private checkpoints: Checkpoint[] = [];
  private active: Checkpoint | undefined;

  /** Starts a new checkpoint at a user-message boundary. */
  begin(messageIndex: number): string {
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.active = { id, messageIndex, files: new Map() };
    this.checkpoints.push(this.active);
    return id;
  }

  /** Records a file's pre-edit content (first write per checkpoint wins). */
  recordFile(relPath: string, content: string | undefined): void {
    if (this.active && !this.active.files.has(relPath)) {
      this.active.files.set(relPath, content);
    }
  }

  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === id);
  }

  /**
   * Restores the workspace to the state at `id`: applies the captured
   * originals of that checkpoint and every later one (newest first, so the
   * oldest capture of each file wins). Returns the touched files.
   */
  async restore(id: string, root: vscode.Uri | undefined): Promise<{ restored: string[]; messageIndex: number } | undefined> {
    const idx = this.checkpoints.findIndex((c) => c.id === id);
    if (idx < 0) {
      return undefined;
    }
    // Oldest capture per file across [idx, end].
    const originals = new Map<string, string | undefined>();
    for (let i = this.checkpoints.length - 1; i >= idx; i--) {
      for (const [file, content] of this.checkpoints[i].files) {
        originals.set(file, content);
      }
    }
    const restored: string[] = [];
    for (const [relPath, content] of originals) {
      const uri = relPath.startsWith('/') || !root ? vscode.Uri.file(relPath) : vscode.Uri.joinPath(root, relPath);
      try {
        if (content === undefined) {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } else {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        }
        restored.push(relPath);
      } catch {
        // Keep going; report what we could restore.
      }
    }
    const messageIndex = this.checkpoints[idx].messageIndex;
    this.checkpoints = this.checkpoints.slice(0, idx);
    this.active = undefined;
    return { restored, messageIndex };
  }

  /** Oldest captured original per file across ALL checkpoints of the session. */
  originals(): Map<string, string | undefined> {
    const out = new Map<string, string | undefined>();
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      for (const [file, content] of this.checkpoints[i].files) {
        out.set(file, content);
      }
    }
    return out;
  }

  /** Restores a single file to its session-start state (delete if it didn't exist). */
  async restoreFile(relPath: string, root: vscode.Uri | undefined): Promise<boolean> {
    const originals = this.originals();
    if (!originals.has(relPath)) {
      return false;
    }
    const content = originals.get(relPath);
    const uri = relPath.startsWith('/') || !root ? vscode.Uri.file(relPath) : vscode.Uri.joinPath(root, relPath);
    try {
      if (content === undefined) {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } else {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      }
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.checkpoints = [];
    this.active = undefined;
  }

  serialize(): SerializedCheckpoint[] {
    return this.checkpoints.map((c) => ({
      id: c.id,
      messageIndex: c.messageIndex,
      files: [...c.files.entries()].map(([p, content]) => ({ path: p, content: content ?? null })),
    }));
  }

  load(data: SerializedCheckpoint[] | undefined): void {
    this.active = undefined;
    this.checkpoints = (data ?? []).map((c) => ({
      id: c.id,
      messageIndex: c.messageIndex,
      files: new Map(c.files.map((f) => [f.path, f.content === null ? undefined : f.content])),
    }));
  }
}
