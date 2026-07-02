import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

export interface RunResult {
  ok: boolean;
  output: string;
  /** True when the process was killed (cancel / kill button / timeout). */
  killed: boolean;
  exitCode: number | null;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called with each output chunk for live streaming into the UI. */
  onChunk?: (chunk: string) => void;
}

interface BackgroundProc {
  proc: ChildProcess;
  command: string;
  output: string;
  running: boolean;
  exitCode: number | null;
}

const MAX_BUFFER = 2 * 1024 * 1024;

/**
 * Runs shell commands as killable child processes with live output streaming.
 * Foreground runs stream and resolve on exit; background runs keep collecting
 * output that the agent can poll via check_process.
 */
export class ProcessManager {
  private readonly background = new Map<string, BackgroundProc>();
  private readonly foreground = new Map<string, ChildProcess>();
  private counter = 0;

  /** Runs a command to completion (streamed, killable via signal or kill()). */
  run(command: string, options: RunOptions): Promise<RunResult> {
    const id = `p${++this.counter}`;
    return new Promise<RunResult>((resolve) => {
      const proc = spawn(command, { shell: true, cwd: options.cwd, detached: process.platform !== 'win32' });
      this.foreground.set(id, proc);
      let output = '';
      let killed = false;
      let settled = false;

      const append = (data: Buffer): void => {
        const text = data.toString();
        if (output.length < MAX_BUFFER) {
          output += text;
        }
        options.onChunk?.(text);
      };
      proc.stdout?.on('data', append);
      proc.stderr?.on('data', append);

      const kill = (): void => {
        killed = true;
        killTree(proc);
      };
      const timer = setTimeout(kill, options.timeoutMs);
      const onAbort = (): void => kill();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.foreground.delete(id);
        resolve({ ok: !killed && exitCode === 0, output, killed, exitCode });
      };
      proc.on('error', (e) => {
        output += `\n${e.message}`;
        finish(null);
      });
      proc.on('close', (code) => finish(code));
    });
  }

  /** Starts a long-running command in the background; output is buffered. */
  startBackground(command: string, cwd: string | undefined, onChunk?: (chunk: string) => void): string {
    const id = `bg${++this.counter}`;
    const proc = spawn(command, { shell: true, cwd, detached: process.platform !== 'win32' });
    const entry: BackgroundProc = { proc, command, output: '', running: true, exitCode: null };
    const append = (data: Buffer): void => {
      const text = data.toString();
      if (entry.output.length < MAX_BUFFER) {
        entry.output += text;
      }
      onChunk?.(text);
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('error', (e) => {
      entry.output += `\n${e.message}`;
      entry.running = false;
    });
    proc.on('close', (code) => {
      entry.running = false;
      entry.exitCode = code;
    });
    this.background.set(id, entry);
    return id;
  }

  /** Snapshot of a background process (output so far + status). */
  check(id: string): { found: boolean; running?: boolean; output?: string; exitCode?: number | null; command?: string } {
    const entry = this.background.get(id);
    if (!entry) {
      return { found: false };
    }
    return { found: true, running: entry.running, output: entry.output, exitCode: entry.exitCode, command: entry.command };
  }

  /** Kills a background process (or a foreground one by its stream id). */
  kill(id: string): boolean {
    const bg = this.background.get(id);
    if (bg) {
      killTree(bg.proc);
      return true;
    }
    const fg = this.foreground.get(id);
    if (fg) {
      killTree(fg);
      return true;
    }
    return false;
  }

  killAll(): void {
    for (const entry of this.background.values()) {
      killTree(entry.proc);
    }
    for (const proc of this.foreground.values()) {
      killTree(proc);
    }
  }

  listRunning(): Array<{ id: string; command: string }> {
    const out: Array<{ id: string; command: string }> = [];
    for (const [id, entry] of this.background) {
      if (entry.running) {
        out.push({ id, command: entry.command });
      }
    }
    return out;
  }
}

/** Kills the whole process group so shell children (e.g. dev servers) die too. */
function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      proc.kill();
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}
