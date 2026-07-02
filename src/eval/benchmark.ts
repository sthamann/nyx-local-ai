import { streamChat, parseJsonLoose } from '../models/client';
import { applyStringEdit } from '../agent/tools';
import { toolSchemas } from '../agent/toolSchemas';
import { BASE_SYSTEM_PROMPT } from '../agent/agent';
import type { BenchmarkScores, ModelInfo } from '../types';

const FILE_A = `export function totalPrice(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.qty;\n  }\n  return sum;\n}\n\nexport function formatPrice(cents) {\n  return (cents / 100).toFixed(2) + ' EUR';\n}\n`;

interface ToolTask {
  user: string;
  check: (name: string, args: string) => boolean;
}

const TOOL_TASKS: ToolTask[] = [
  { user: 'Read the file src/models/discovery.ts', check: (n, a) => n === 'read_file' && a.includes('discovery.ts') },
  { user: "Search the codebase for the exact string 'stripSpecialTokens'.", check: (n, a) => (n === 'search_files' || n === 'semantic_search') && a.includes('stripSpecialTokens') },
  { user: 'Run the shell command `node --version` for me.', check: (n, a) => n === 'run_command' && a.includes('node --version') },
];

const EDIT_TASKS = [
  {
    instruction: "In the file below, change the currency suffix in formatPrice from ' EUR' to ' €' using edit_file. File path: src/pricing.js",
    expect: (updated: string) => updated.includes("' €'") && !updated.includes("' EUR'"),
  },
  {
    instruction: 'In the file below, add a first line `if (!items) return 0;` to the body of totalPrice using edit_file. File path: src/pricing.js',
    expect: (updated: string) => updated.includes('if (!items) return 0;'),
  },
];

const JUDGE_TASKS = [
  {
    bug: false,
    code: `await new Promise((resolve) => {\n  const timer = setTimeout(() => {\n    sub.dispose();\n    resolve();\n  }, 1500);\n  const sub = onEvent(() => { clearTimeout(timer); sub.dispose(); resolve(); });\n});`,
  },
  {
    bug: false,
    code: `const active = users.filter((u) => u.active);\nconst names = active.map((u) => u.name.trim().toLowerCase());\nreturn [...new Set(names)];`,
  },
  {
    bug: true,
    code: `// waits for all uploads, then returns the count\nasync function uploadAll(files) {\n  let done = 0;\n  files.forEach(async (f) => { await upload(f); done++; });\n  return done;\n}`,
  },
  {
    bug: true,
    code: `// returns a sorted copy, leaving the input untouched\nfunction sortedCopy(arr) {\n  return arr.sort((a, b) => a - b);\n}`,
  },
];

/**
 * Compact in-product benchmark (9 requests): tool-call reliability, edit
 * precision (edits are really applied through the fuzzy matcher), and
 * bug-judgment accuracy incl. false-positive rate on correct-looking traps.
 * Same prompt/schemas/parsers as real agent runs.
 */
export async function runBenchmark(
  model: ModelInfo,
  onProgress: (text: string) => void,
  signal: AbortSignal,
): Promise<BenchmarkScores> {
  const toolNames = toolSchemas.map((t) => t.function.name);
  const latencies: number[] = [];

  const ask = async (system: string, user: string, useTools: boolean): Promise<{ content: string; calls: Array<{ name: string; arguments: string }> }> => {
    const started = Date.now();
    const result = await streamChat(
      {
        endpoint: model.endpoint,
        apiKey: model.apiKey,
        model: model.id,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools: useTools ? toolSchemas : undefined,
        extractToolCallsFromContent: useTools,
        toolNames,
        temperature: 0,
        maxTokens: 1200,
        ollamaNumCtx: model.provider === 'ollama' ? model.numCtx : undefined,
        signal,
      },
      { onDelta: () => {} },
    );
    latencies.push(Date.now() - started);
    return { content: result.content, calls: result.toolCalls };
  };

  let toolPass = 0;
  for (let i = 0; i < TOOL_TASKS.length; i++) {
    onProgress(`Benchmark ${i + 1}/9: tool calls…`);
    try {
      const r = await ask(BASE_SYSTEM_PROMPT, TOOL_TASKS[i].user, true);
      const call = r.calls[0];
      if (call && TOOL_TASKS[i].check(call.name, call.arguments)) {
        toolPass++;
      }
    } catch {
      // counts as fail
    }
  }

  let editPass = 0;
  for (let i = 0; i < EDIT_TASKS.length; i++) {
    onProgress(`Benchmark ${TOOL_TASKS.length + i + 1}/9: edits…`);
    try {
      const user = `${EDIT_TASKS[i].instruction}\n\nCurrent content of src/pricing.js:\n\`\`\`js\n${FILE_A}\`\`\``;
      const r = await ask(BASE_SYSTEM_PROMPT, user, true);
      let updated = FILE_A;
      for (const call of r.calls) {
        if (call.name !== 'edit_file') {
          continue;
        }
        const a = (parseJsonLoose(call.arguments) ?? {}) as Record<string, unknown>;
        const res = applyStringEdit(updated, String(a.old_string ?? ''), String(a.new_string ?? ''), a.replace_all === true);
        if (res.ok) {
          updated = res.updated;
        }
      }
      if (EDIT_TASKS[i].expect(updated)) {
        editPass++;
      }
    } catch {
      // fail
    }
  }

  let judgePass = 0;
  let fpCount = 0;
  let correctSnippets = 0;
  for (let i = 0; i < JUDGE_TASKS.length; i++) {
    onProgress(`Benchmark ${TOOL_TASKS.length + EDIT_TASKS.length + i + 1}/9: bug judgment…`);
    const task = JUDGE_TASKS[i];
    if (!task.bug) {
      correctSnippets++;
    }
    try {
      const r = await ask(
        'You review code snippets. Analyze carefully — code that looks suspicious is often correct (closures, hoisting, async). Answer ONLY with JSON: {"bug": true|false, "reason": "<one sentence>"}',
        `Does this code contain a real bug (behavior differs from the stated intent)?\n\n\`\`\`js\n${task.code}\n\`\`\``,
        false,
      );
      const jsonMatch = r.content.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? (parseJsonLoose(jsonMatch[0]) as { bug?: unknown } | undefined) : undefined;
      const verdict = typeof parsed?.bug === 'boolean' ? parsed.bug : undefined;
      if (verdict === task.bug) {
        judgePass++;
      }
      if (!task.bug && verdict === true) {
        fpCount++;
      }
    } catch {
      // fail
    }
  }

  const pct = (n: number, of: number): number => (of > 0 ? Math.round((n / of) * 100) : 0);
  return {
    tool: pct(toolPass, TOOL_TASKS.length),
    edit: pct(editPass, EDIT_TASKS.length),
    judge: pct(judgePass, JUDGE_TASKS.length),
    fp: pct(fpCount, correctSnippets),
    avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    at: Date.now(),
  };
}
