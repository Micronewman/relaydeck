import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAgent } from '../src/local-agent.js';
import { ROOT } from '../src/config.js';
if (!process.argv.includes('--execute')) {
  console.log('这项测试会使用本机 Codex 配置调用模型，并仅在 .dev/smoke 下创建测试文件。执行：node scripts/smoke-codex.js --execute');
  process.exit(0);
}
const cwd = path.join(ROOT, '.dev', 'smoke', randomUUID()); fs.mkdirSync(cwd, { recursive: true });
const local = new LocalAgent({ cwd }); let threadId; let completion; let needsApproval = false;
local.on('event', event => {
  if (event.type === 'approval') { needsApproval = true; console.log('此配置需要交互审批，本脚本不会自动批准。请改用 node scripts/live-smoke.js，在网页中审批测试会话。'); local.handle('respond', { id: event.approval.id, decision: 'decline' }).catch(() => {}); }
  if (event.type === 'codex' && event.method === 'turn/completed' && event.params.threadId === threadId) completion = event.params.turn;
  if (event.type === 'codex' && event.method === 'error') console.log(JSON.stringify({ error: event.params.error?.message }));
});
try {
  await local.start(); const created = await local.handle('create', { cwd }); threadId = created.thread.id;
  console.log(JSON.stringify({ stage: 'created', provider: created.thread.modelProvider, threadId }));
  await local.handle('send', { threadId, clientId: randomUUID(), text: '这是 RelayDeck 的接入验收测试。仅在当前工作目录创建 relaydeck-smoke.txt，内容为 RELAYDECK_OK。不要访问其他目录、联网或修改其他文件。完成后只回复 RELAYDECK_OK。' });
  const deadline = Date.now() + 180000;
  while (!completion && !needsApproval && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  if (needsApproval) throw new Error('需要交互审批，请使用已启动的工作台和 live-smoke.js 完成测试。');
  if (!completion) throw new Error('真实 Codex 任务在 180 秒内未完成');
  const file = path.join(cwd, 'relaydeck-smoke.txt'); const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  if (completion.status !== 'completed' || content !== 'RELAYDECK_OK') throw new Error(`真实执行未通过：status=${completion.status}, file=${content === 'RELAYDECK_OK'}, error=${completion.error?.message || 'none'}`);
  // Read it back through the same history API used by the phone.
  const history = await local.handle('thread', { threadId });
  console.log(JSON.stringify({ passed: true, status: completion.status, verifiedFile: file, historyTurns: history.turns.length }));
  await local.client.request('thread/archive', { threadId });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (threadId && local.running.has(threadId)) await local.handle('interrupt', { threadId }).catch(() => {}); local.stop(); }
