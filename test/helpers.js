import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodexClient } from '../src/codex.js';
import { LocalAgent } from '../src/local-agent.js';
import { createHub } from '../src/hub.js';
import { ROOT } from '../src/config.js';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error('Timed out waiting for test condition');
}
export function fakeAgent(id = 'test-local', name = '开发工作站', dataDir) {
  const ownDir = !dataDir; dataDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'relaydeck-agent-test-'));
  const local = new LocalAgent({ id, name, cwd: ROOT, dataDir, client: new CodexClient({ bin: process.execPath, args: [path.join(ROOT, 'test/fixtures/fake-codex.js')] }) });
  if (ownDir) { const stop = local.stop.bind(local); local.stop = () => { stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }; }
  return local;
}
export async function testHub() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaydeck-test-'));
  const config = { deviceId: 'test-local', deviceName: '开发工作站', accessCode: randomUUID(), port: 0, host: '127.0.0.1', agents: [], pairings: [] };
  const local = fakeAgent('test-local', '开发工作站', dataDir); const hub = createHub({ config, dataDir, local });
  const address = await hub.listen(0); await local.start(); const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request(route, body, { auth = true, method, headers = {} } = {}) {
    const response = await fetch(base + route, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data; try { data = await response.json(); } catch { data = null; }
    return { response, data };
  }
  const login = await request('/api/login', { code: config.accessCode }); cookie = login.response.headers.get('set-cookie').split(';')[0];
  return { hub, config, local, base, request, cookie, dataDir, async close() { await hub.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
