// Model eval harness: benchmarks a local model on the skills Nyx actually
// needs — tool-call reliability, edit precision, and bug-judgment accuracy
// (incl. false-positive rate). Works against any OpenAI-compatible endpoint.
//
//   node .harness/eval.mjs --url http://localhost:11434/v1 --model qwen2.5-coder:32b
//   node .harness/eval.mjs --url http://192.168.1.77:8888/v1 --model deepseek-v4-flash-dspark --rounds 2
//
// Output: a per-category score table + total. Use it to compare machines/models
// objectively before making one your daily driver.
import * as esbuild from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- CLI args ----------------------------------------------------------------
const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] !== undefined) {
      args[m[1]] = m[2];
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[m[1]] = argv[++i];
    } else {
      args[m[1]] = 'true';
    }
  }
}
const URL_BASE = args.url ?? 'http://localhost:11434/v1';
const MODEL = args.model;
const ROUNDS = Number(args.rounds ?? 1);
const API_KEY = args.key;
if (!MODEL) {
  console.error('Usage: node .harness/eval.mjs --url <openai-base-url> --model <model-id> [--rounds N] [--key <bearer>]');
  process.exit(1);
}

// ---- Bundle the real Nyx client + schemas + prompt ------------------------------
const dir = mkdtempSync(join(tmpdir(), 'nyx-eval-'));
const stub = join(dir, 'vscode.js');
writeFileSync(stub, 'module.exports = new Proxy({}, { get: () => new Proxy(function(){}, { get: () => () => undefined }) });');
const entry = join(dir, 'entry.js');
writeFileSync(
  entry,
  `
export { streamChat, parseJsonLoose } from '${process.cwd()}/src/models/client.ts';
export { applyStringEdit, toolSchemas } from '${process.cwd()}/src/agent/tools.ts';
export { BASE_SYSTEM_PROMPT } from '${process.cwd()}/src/agent/agent.ts';
`,
);
const out = join(dir, 'bundle.mjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  alias: { vscode: stub, 'tesseract.js': stub, unpdf: stub },
  logLevel: 'silent',
});
const nyx = await import(pathToFileURL(out).href);

// ---- Model call helper ---------------------------------------------------------
async function ask({ system, user, tools, temperature = 0 }) {
  const toolNames = (tools ?? []).map((t) => t.function.name);
  const started = Date.now();
  const result = await nyx.streamChat(
    {
      endpoint: URL_BASE,
      apiKey: API_KEY,
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      tools,
      extractToolCallsFromContent: (tools ?? []).length > 0,
      toolNames,
      temperature,
      maxTokens: 1200,
      signal: AbortSignal.timeout(180000),
    },
    { onDelta: () => {} },
  );
  return { ...result, ms: Date.now() - started };
}

// ---- Task set -------------------------------------------------------------------
const FILE_A = `export function totalPrice(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.qty;\n  }\n  return sum;\n}\n\nexport function formatPrice(cents) {\n  return (cents / 100).toFixed(2) + ' EUR';\n}\n`;

const toolTasks = [
  {
    name: 'read a file',
    user: 'Read the file src/models/discovery.ts',
    check: (c) => c.name === 'read_file' && /src\/models\/discovery\.ts/.test(JSON.stringify(c.arguments)),
  },
  {
    name: 'list a directory',
    user: 'List the contents of the src/agent folder.',
    check: (c) => c.name === 'list_dir' && /src\/agent/.test(JSON.stringify(c.arguments)),
  },
  {
    name: 'regex search',
    user: "Search the codebase for the exact string 'stripSpecialTokens'.",
    check: (c) => (c.name === 'search_files' || c.name === 'semantic_search') && /stripSpecialTokens/.test(JSON.stringify(c.arguments)),
  },
  {
    name: 'run a command',
    user: 'Run the shell command `node --version` for me.',
    check: (c) => c.name === 'run_command' && /node --version/.test(JSON.stringify(c.arguments)),
  },
  {
    name: 'clarifying question',
    user: 'Add a config file to the project.',
    check: (c) => c.name === 'ask_user',
  },
];

const editTasks = [
  {
    name: 'rename variable',
    instruction: "In the file below, rename the variable `sum` to `total` (all occurrences) using edit_file with replace_all or precise edits. File path: src/pricing.js",
    expect: (updated) => /let total = 0/.test(updated) && /total \+= item\.price/.test(updated) && !/\bsum\b/.test(updated),
  },
  {
    name: 'change literal',
    instruction: "In the file below, change the currency suffix in formatPrice from ' EUR' to ' €' using edit_file. File path: src/pricing.js",
    expect: (updated) => /' €'/.test(updated) && !/' EUR'/.test(updated),
  },
  {
    name: 'add guard',
    instruction: 'In the file below, add a first line `if (!items) return 0;` to the body of totalPrice using edit_file. File path: src/pricing.js',
    expect: (updated) => /if \(!items\) return 0;/.test(updated),
  },
];

// Ground-truth snippets for bug judgment. `bug: false` snippets are the classic
// LLM pattern-match traps (closure timing, delta indentation).
const judgeTasks = [
  {
    name: 'closure-after-decl (correct)',
    bug: false,
    code: `await new Promise((resolve) => {\n  const timer = setTimeout(() => {\n    sub.dispose();\n    resolve();\n  }, 1500);\n  const sub = onEvent(() => {\n    clearTimeout(timer);\n    sub.dispose();\n    resolve();\n  });\n});`,
  },
  {
    name: 'uniform indent shift (correct)',
    bug: false,
    code: `const fileIndent = matched[0].match(/^\\s*/)[0];\nconst oldIndent = oldStr.split('\\n')[0].match(/^\\s*/)[0];\nconst replacement = newStr.split('\\n')\n  .map((l) => (l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l))\n  .join('\\n');`,
  },
  {
    name: 'map-filter chain (correct)',
    bug: false,
    code: `const active = users.filter((u) => u.active);\nconst names = active.map((u) => u.name.trim().toLowerCase());\nreturn [...new Set(names)];`,
  },
  {
    name: 'off-by-one (buggy)',
    bug: true,
    code: `// returns the last N lines of the file\nfunction lastLines(text, n) {\n  const lines = text.split('\\n');\n  return lines.slice(lines.length - n - 1).join('\\n');\n}`,
  },
  {
    name: 'await in forEach (buggy)',
    bug: true,
    code: `// waits for all uploads, then returns the count\nasync function uploadAll(files) {\n  let done = 0;\n  files.forEach(async (f) => {\n    await upload(f);\n    done++;\n  });\n  return done;\n}`,
  },
  {
    name: 'mutating sort (buggy)',
    bug: true,
    code: `// returns a sorted copy, leaving the input untouched\nfunction sortedCopy(arr) {\n  return arr.sort((a, b) => a - b);\n}`,
  },
];

// ---- Runners ---------------------------------------------------------------------
const scores = { tool: [], edit: [], judgeAcc: [], judgeFp: [], latencies: [] };

async function runToolTasks() {
  for (const task of toolTasks) {
    let pass = false;
    let detail = '';
    try {
      const r = await ask({ system: nyx.BASE_SYSTEM_PROMPT, user: task.user, tools: nyx.toolSchemas });
      scores.latencies.push(r.ms);
      const call = r.toolCalls[0];
      if (call) {
        pass = task.check({ name: call.name, arguments: call.arguments });
        detail = `${call.name}(${call.arguments.slice(0, 60)})`;
      } else {
        detail = `no tool call — said: ${r.content.slice(0, 60)}`;
      }
    } catch (e) {
      detail = `error: ${e.message.slice(0, 80)}`;
    }
    scores.tool.push(pass ? 1 : 0);
    console.log(`  [tool] ${pass ? 'PASS' : 'FAIL'}  ${task.name}  →  ${detail}`);
  }
}

async function runEditTasks() {
  for (const task of editTasks) {
    let pass = false;
    let detail = '';
    try {
      const user = `${task.instruction}\n\nCurrent content of src/pricing.js:\n\`\`\`js\n${FILE_A}\`\`\``;
      const r = await ask({ system: nyx.BASE_SYSTEM_PROMPT, user, tools: nyx.toolSchemas });
      scores.latencies.push(r.ms);
      let updated = FILE_A;
      let applied = 0;
      for (const call of r.toolCalls) {
        if (call.name !== 'edit_file') continue;
        const a = nyx.parseJsonLoose(call.arguments) ?? {};
        const res = nyx.applyStringEdit(updated, String(a.old_string ?? ''), String(a.new_string ?? ''), a.replace_all === true);
        if (res.ok) {
          updated = res.updated;
          applied++;
        } else {
          detail = `edit failed: ${res.error?.slice(0, 60)}`;
        }
      }
      if (applied > 0) {
        pass = task.expect(updated);
        if (!detail) detail = `${applied} edit(s) applied${pass ? '' : ', wrong result'}`;
      } else if (!detail) {
        detail = r.toolCalls.length ? `called ${r.toolCalls.map((c) => c.name).join(',')}` : 'no tool call';
      }
    } catch (e) {
      detail = `error: ${e.message.slice(0, 80)}`;
    }
    scores.edit.push(pass ? 1 : 0);
    console.log(`  [edit] ${pass ? 'PASS' : 'FAIL'}  ${task.name}  →  ${detail}`);
  }
}

async function runJudgeTasks() {
  for (const task of judgeTasks) {
    let verdict;
    let detail = '';
    try {
      const r = await ask({
        system:
          'You review code snippets. Analyze carefully — code that looks suspicious is often correct (closures, hoisting, async). Answer ONLY with JSON: {"bug": true|false, "reason": "<one sentence>"}',
        user: `Does this code contain a real bug (behavior differs from the stated intent)?\n\n\`\`\`js\n${task.code}\n\`\`\``,
      });
      scores.latencies.push(r.ms);
      const jsonMatch = r.content.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? nyx.parseJsonLoose(jsonMatch[0]) : undefined;
      verdict = parsed && typeof parsed.bug === 'boolean' ? parsed.bug : undefined;
      detail = parsed?.reason?.slice(0, 70) ?? r.content.slice(0, 70);
    } catch (e) {
      detail = `error: ${e.message.slice(0, 80)}`;
    }
    const correct = verdict === task.bug;
    scores.judgeAcc.push(correct ? 1 : 0);
    if (!task.bug) scores.judgeFp.push(verdict === true ? 1 : 0);
    console.log(`  [judge] ${correct ? 'PASS' : 'FAIL'}  ${task.name} (truth: ${task.bug ? 'bug' : 'ok'}, model: ${verdict ?? '?'}) — ${detail}`);
  }
}

// ---- Main ------------------------------------------------------------------------
console.log(`\nNyx model eval — ${MODEL} @ ${URL_BASE} (${ROUNDS} round(s))\n`);
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`— Round ${round} —`);
  await runToolTasks();
  await runEditTasks();
  await runJudgeTasks();
}

const pct = (arr) => (arr.length ? `${Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100)}%` : 'n/a');
const avgMs = scores.latencies.length ? Math.round(scores.latencies.reduce((a, b) => a + b, 0) / scores.latencies.length) : 0;
console.log('\n================ RESULTS ================');
console.log(`Tool-call success   : ${pct(scores.tool)}   (${scores.tool.length} tasks)`);
console.log(`Edit precision      : ${pct(scores.edit)}   (${scores.edit.length} tasks)`);
console.log(`Bug-judgment acc.   : ${pct(scores.judgeAcc)}   (${scores.judgeAcc.length} tasks)`);
console.log(`False-positive rate : ${pct(scores.judgeFp)}   (lower is better, ${scores.judgeFp.length} correct snippets)`);
console.log(`Avg. latency        : ${avgMs} ms/request`);
console.log('=========================================\n');
rmSync(dir, { recursive: true, force: true });
