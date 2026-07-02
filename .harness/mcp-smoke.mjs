// Live smoke test: connect to the user's real MCP servers via the Nyx client.
import * as esbuild from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'nyx-mcp-'));
const out = join(dir, 'client.mjs');
await esbuild.build({
  entryPoints: ['src/mcp/client.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
});
const m = await import(pathToFileURL(out).href);

const configs = await m.loadMcpConfigs(process.cwd(), undefined);
console.log('configs found:', configs.map((c) => c.name).join(', ') || '(none)');

const target = configs.find((c) => c.name === 'codebase-memory-mcp');
if (!target) {
  console.error('FAIL: codebase-memory-mcp not found in config');
  process.exit(1);
}

const manager = new m.McpManager((t) => console.log('  log:', t.slice(0, 120)));
await manager.refresh([target]);
const tools = manager.getTools();
console.log('tools discovered:', tools.length);
for (const t of tools.slice(0, 6)) {
  console.log(' -', t.wireName, '| perm:', t.permissionKey);
}
if (tools.length === 0) {
  console.error('FAIL: no tools');
  manager.disposeAll();
  process.exit(1);
}

const status = tools.find((t) => t.tool === 'index_status') ?? tools[0];
const result = await manager.call(status.server, status.tool, {});
console.log('call', status.tool, '→ ok:', result.ok);
console.log('result preview:', result.content.slice(0, 300));
manager.disposeAll();
rmSync(dir, { recursive: true, force: true });
console.log(result.content ? 'ALL PASS' : 'FAIL: empty result');
process.exit(result.content ? 0 : 1);
