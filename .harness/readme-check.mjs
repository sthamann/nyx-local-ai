// README freshness gate: fails when README.md drifts from the actual product
// surface (settings, commands, tools, version). Run before every release:
//   node .harness/readme-check.mjs
import * as esbuild from 'esbuild';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const readme = readFileSync('README.md', 'utf8');
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL  ${msg}`);
};
const pass = (msg) => console.log(`ok    ${msg}`);

// 1. Every setting must be documented.
const settings = Object.keys(pkg.contributes.configuration.properties);
const missingSettings = settings.filter((k) => !readme.includes(`\`${k}\``));
missingSettings.length ? fail(`settings missing in README: ${missingSettings.join(', ')}`) : pass(`${settings.length} settings documented`);

// 2. Every command must be documented.
const commands = pkg.contributes.commands.map((c) => c.title.split(' (')[0]);
const missingCommands = commands.filter((t) => !readme.includes(t));
missingCommands.length ? fail(`commands missing in README: ${missingCommands.join(', ')}`) : pass(`${commands.length} commands documented`);

// 3. Version consistency: package.json ↔ README status line + vsix mentions ↔ MCP clientInfo.
const version = pkg.version;
if (!readme.includes(`**v${version}**`)) {
  fail(`README status line does not mention **v${version}**`);
} else {
  pass(`README status line at v${version}`);
}
const vsixMentions = [...readme.matchAll(/nyx-local-ai-(\d+\.\d+\.\d+)\.vsix/g)].map((m) => m[1]);
const staleVsix = vsixMentions.filter((v) => v !== version);
staleVsix.length ? fail(`stale .vsix version mentions in README: ${[...new Set(staleVsix)].join(', ')}`) : pass('all .vsix mentions match');
const mcpClient = readFileSync('src/mcp/client.ts', 'utf8');
mcpClient.includes(`version: '${version}'`) ? pass('mcp clientInfo version matches') : fail(`src/mcp/client.ts clientInfo is not '${version}'`);

// 4. Every built-in tool must appear in the README tools table.
const dir = mkdtempSync(join(tmpdir(), 'nyx-readme-'));
const stub = join(dir, 'vscode.js');
writeFileSync(stub, 'module.exports = new Proxy({}, { get: () => new Proxy(function(){}, { get: () => () => undefined }) });');
const entry = join(dir, 'e.js');
writeFileSync(entry, `export { toolSchemas } from '${process.cwd()}/src/agent/toolSchemas.ts';`);
const out = join(dir, 'b.mjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  alias: { vscode: stub, 'tesseract.js': stub, unpdf: stub },
  logLevel: 'silent',
});
const { toolSchemas } = await import(pathToFileURL(out).href);
const toolNames = toolSchemas.map((t) => t.function.name);
// browser_click/browser_type share a table row — accept either exact or shared-row mention.
const missingTools = toolNames.filter((n) => !readme.includes(`\`${n}\``));
missingTools.length ? fail(`tools missing in README: ${missingTools.join(', ')}`) : pass(`${toolNames.length} tools documented`);
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nREADME CHECK: ALL PASS' : `\nREADME CHECK: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
