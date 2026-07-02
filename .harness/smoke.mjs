// Throwaway smoke test for pure logic: run with `node .harness/smoke.mjs`.
// Bundles src modules with a vscode stub, then exercises parsing/edit logic.
import * as esbuild from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'nyx-smoke-'));
const stub = join(dir, 'vscode.js');
writeFileSync(stub, 'module.exports = new Proxy({}, { get: () => new Proxy(function(){}, { get: () => () => undefined }) });');

const entry = join(dir, 'entry.js');
writeFileSync(
  entry,
  `
export { extractEmbeddedToolCalls, parseJsonLoose, repairJson, parseDsmlToolCalls, stripSpecialTokens } from '${process.cwd()}/src/models/client.ts';
export { applyStringEdit } from '${process.cwd()}/src/agent/tools.ts';
export { chunkFile } from '${process.cwd()}/src/context/semanticIndex.ts';
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

const m = await import(pathToFileURL(out).href);
let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log('PASS', name);
  } else {
    failures++;
    console.error('FAIL', name);
  }
}

// --- extractEmbeddedToolCalls (#4) ---
const tools = ['read_file', 'edit_file', 'ask_user'];
const mixed = 'I will read the file now:\n```json\n{"name":"read_file","arguments":{"path":"src/a.ts"}}\n```\nThen I continue.';
const r1 = m.extractEmbeddedToolCalls(mixed, tools);
check('embedded fenced call detected', r1 && r1.calls.length === 1 && r1.calls[0].name === 'read_file');
check('prose preserved', r1 && r1.strippedContent.includes('I will read the file now:') && !r1.strippedContent.includes('read_file'));

const bare = 'Let me check. {"name": "read_file", "arguments": {"path": "x.md"}} done.';
const r2 = m.extractEmbeddedToolCalls(bare, tools);
check('bare embedded call detected', r2 && r2.calls.length === 1 && JSON.parse(r2.calls[0].arguments).path === 'x.md');

const noCall = 'Here is JSON: {"foo": 1} — not a tool.';
check('plain JSON not misread', m.extractEmbeddedToolCalls(noCall, tools) === null);

// --- repairJson / parseJsonLoose (#21) ---
check('trailing comma repaired', m.parseJsonLoose('{"a": 1,}').a === 1);
check('python literals repaired', m.parseJsonLoose('{"a": True, "b": None}').a === true);

// --- applyStringEdit fuzzy matching (#18) ---
const file = 'function foo() {\n    const x = 1;\n    return x;\n}\n';
const exact = m.applyStringEdit(file, 'const x = 1;', 'const x = 2;', false);
check('exact edit works', exact.ok && exact.updated.includes('const x = 2;'));

// Model got indentation wrong (2 spaces instead of 4):
const fuzzy = m.applyStringEdit(file, '  const x = 1;\n  return x;', '  const x = 42;\n  return x;', false);
check('fuzzy whitespace edit works', fuzzy.ok && fuzzy.fuzzy === true && fuzzy.updated.includes('    const x = 42;'));
check('fuzzy keeps file indent', fuzzy.ok && fuzzy.updated.includes('    return x;'));

const missing = m.applyStringEdit(file, 'const y = 9;', 'z', false);
check('missing edit reports hint', !missing.ok && /not found/.test(missing.error));

// --- DeepSeek DSML tool calls (V4 "tool_calls" / V3.2 "function_calls") ---
const BAR = '\uFF5C';
const dsmlV4 =
  `Ich schaue mir die Datei an.\n` +
  `<${BAR}DSML${BAR}tool_calls>\n` +
  `<${BAR}DSML${BAR}invoke name="read_file">\n` +
  `<${BAR}DSML${BAR}parameter name="path" string="true">src/agent/tools.ts</${BAR}DSML${BAR}parameter>\n` +
  `<${BAR}DSML${BAR}parameter name="limit" string="false">50</${BAR}DSML${BAR}parameter>\n` +
  `</${BAR}DSML${BAR}invoke>\n` +
  `</${BAR}DSML${BAR}tool_calls><${BAR}end\u2581of\u2581sentence${BAR}>`;
const d1 = m.parseDsmlToolCalls(dsmlV4);
check('DSML v4 call parsed', d1 && d1.calls.length === 1 && d1.calls[0].name === 'read_file');
check(
  'DSML params typed correctly',
  d1 && JSON.parse(d1.calls[0].arguments).path === 'src/agent/tools.ts' && JSON.parse(d1.calls[0].arguments).limit === 50,
);
check('DSML prose kept, tokens stripped', d1 && d1.strippedContent === 'Ich schaue mir die Datei an.');

// ASCII-pipe variant + unterminated block (stream cut off mid-call)
const dsmlAscii = 'Text davor <|DSML|tool_calls>\n<|DSML|invoke name="list_dir">\n<|DSML|parameter name="path" string="true">.</|DSML|parameter>\n';
const d2 = m.parseDsmlToolCalls(dsmlAscii);
check('DSML ascii/unterminated parsed', d2 && d2.calls.length === 1 && d2.calls[0].name === 'list_dir');

// V3.2 variant
const dsmlV32 = `<${BAR}DSML${BAR}function_calls>\n<${BAR}DSML${BAR}invoke name="get_diagnostics">\n</${BAR}DSML${BAR}invoke>\n</${BAR}DSML${BAR}function_calls>`;
const d3 = m.parseDsmlToolCalls(dsmlV32);
check('DSML v3.2 block parsed', d3 && d3.calls.length === 1 && d3.calls[0].name === 'get_diagnostics');

check('no false DSML positives', m.parseDsmlToolCalls('Normaler Text ohne Markup') === null);

// --- stripSpecialTokens: orphan closing tags & control tokens (memory poisoning) ---
const poisoned = 'Projekt-Bug-Analyse gestartet\n  J_READ_CHARS) };\n  }\n}\n</' + BAR + 'DSML' + BAR + 'tool_calls>';
const cleaned = m.stripSpecialTokens(poisoned);
check('orphan DSML closing tag stripped', !cleaned.includes('DSML') && cleaned.includes('J_READ_CHARS'));

const eos = `Fertig.<${BAR}end\u2581of\u2581sentence${BAR}>`;
check('end-of-sentence token stripped', m.stripSpecialTokens(eos) === 'Fertig.');

const spaced = 'code hier </ ' + BAR + ' DSML ' + BAR + ' tool_calls>';
check('spaced DSML variant stripped', !m.stripSpecialTokens(spaced).includes('DSML'));

check('normal code untouched', m.stripSpecialTokens('a | b || c <div>|</div>') === 'a | b || c <div>|</div>');

// Invoke block without outer tool_calls wrapper (split across reasoning/content)
const invokeOnly = `<${BAR}DSML${BAR}invoke name="read_file">\n<${BAR}DSML${BAR}parameter name="path" string="true">a.ts</${BAR}DSML${BAR}parameter>\n</${BAR}DSML${BAR}invoke>`;
const d4 = m.parseDsmlToolCalls(invokeOnly);
check('DSML invoke without wrapper parsed', d4 && d4.calls.length === 1 && JSON.parse(d4.calls[0].arguments).path === 'a.ts');

// --- structure-aware chunking ---
const code =
  'import x from "y";\n\n' +
  'export function alpha() {\n' + '  return 1;\n'.repeat(15) + '}\n\n' +
  'export class Beta {\n' + '  method() { return 2; }\n'.repeat(20) + '}\n\n' +
  'function gamma() {\n' + '  return 3;\n'.repeat(15) + '}\n';
const chunks = m.chunkFile(code);
check('structural chunks found', chunks.length >= 3);
const alphaChunk = chunks.find((c) => c.text.includes('function alpha'));
check('function boundary respected', alphaChunk && !alphaChunk.text.includes('class Beta'));
const flat = 'word '.repeat(30) + '\n' + ('line\n'.repeat(120));
check('fallback windowing works', m.chunkFile(flat).length >= 2);

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
