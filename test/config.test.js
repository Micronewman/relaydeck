import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexCommand } from '../src/config.js';
test('Windows npm shim resolves to official Node entrypoint without a shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaydeck-shim-'));
  try {
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '// test');
    const command = codexCommand(['app-server'], path.join(dir, 'codex.cmd'));
    assert.equal(command.bin, process.execPath); assert.deepEqual(command.args, [script, 'app-server']);
    assert.throws(() => codexCommand([], path.join(dir, 'other', 'codex.cmd')), /CODEX_BIN/);
    assert.deepEqual(codexCommand(['--version'], '/opt/codex'), { bin: '/opt/codex', args: ['--version'] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
