import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, ROOT, writeJson } from '../src/config.js';
const config = loadConfig(); const base = `http://127.0.0.1:${config.port}`;
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: config.accessCode }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function request(action, body) {
  const response = await fetch(`${base}/api/devices/${config.deviceId}/${action}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
let cwd, threadId;
if (process.argv.includes('--resume')) {
  ({ cwd, threadId } = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev/live-smoke.json'), 'utf8')));
} else {
  cwd = path.join(ROOT, '.dev', 'smoke', randomUUID()); fs.mkdirSync(cwd, { recursive: true });
  const created = await request('create', { cwd }); threadId = created.thread.id;
  writeJson(path.join(ROOT, '.dev/live-smoke.json'), { threadId, cwd, deviceId: config.deviceId });
  console.log(JSON.stringify({ stage: 'started', threadId, provider: created.thread.modelProvider, cwd }));
  await request('send', { threadId, clientId: randomUUID(), text: 'RelayDeck 接入验收：请仅在当前工作目录创建 relaydeck-smoke.txt，内容是 RELAYDECK_OK。可以请求一次当前命令的审批，用户会通过手机确认。不要访问其他目录、联网、创建子代理或修改其他文件。完成后只回复 RELAYDECK_OK。' });
}
const printed = new Set(); let passed = false;
try {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const read = await request(`thread?threadId=${encodeURIComponent(threadId)}`).catch(error => {
      if (/rollout.*empty/i.test(error.message)) return null;
      throw error;
    });
    if (!read) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
    for (const approval of read.approvals) if (!printed.has(approval.id)) {
      printed.add(approval.id); writeJson(path.join(ROOT, '.dev/pending-smoke.json'), { threadId, approval }); console.log(JSON.stringify({ stage: 'approval', approval }));
    }
    const last = read.turns.at(-1);
    if (last && last.status !== 'inProgress') {
      const file = path.join(cwd, 'relaydeck-smoke.txt'); const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
      passed = last.status === 'completed' && content === 'RELAYDECK_OK';
      console.log(JSON.stringify({ passed, status: last.status, fileVerified: content === 'RELAYDECK_OK', historyItems: last.items.map(i => i.type), error: last.error }));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!passed) { await request('interrupt', { threadId }).catch(() => {}); process.exitCode = 1; }
} finally { await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }); }
