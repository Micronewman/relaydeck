import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LocalAgent } from '../src/local-agent.js';
import { ROOT } from '../src/config.js';
if (!process.argv.includes('--execute')) {
  console.log('此验证会调用当前配置的模型，测试普通聊天与推理强度参数。执行：node scripts/options-probe.js --execute'); process.exit(0);
}
const local = new LocalAgent({ dataDir: path.join(ROOT, '.dev', 'options-probe', randomUUID()) });
let threadId;
try {
  await local.start(); const catalog = await local.handle('models');
  const model = catalog.defaults.model; const descriptor = catalog.models.find(m => m.model === model);
  const effort = descriptor?.efforts.find(e => e.value === 'low')?.value || descriptor?.defaultReasoningEffort;
  if (!model || !effort) throw new Error('无法确定当前配置模型的可用推理强度');
  const created = await local.handle('create', { mode: 'chat', settings: { model, effort } }); threadId = created.thread.id;
  console.log(JSON.stringify({ step: 'created', mode: created.thread.mode, pathProvided: false, model: created.thread.model, effort: created.thread.reasoningEffort, isolatedDirectoryExists: fs.existsSync(created.thread.cwd) }));
  await local.handle('send', { threadId, clientId: randomUUID(), text: '这是聊天参数接入测试。不要使用工具、不要读取或修改文件。只回复：RELAYDECK_SETTINGS_OK' });
  const deadline = Date.now() + 120000;
  while ((local.running.has(threadId) || local.loaded.has(threadId)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  const read = await local.handle('thread', { threadId }); const turn = read.turns.at(-1);
  const text = turn?.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n') || '';
  const passed = turn?.status === 'completed' && text.includes('RELAYDECK_SETTINGS_OK') && read.thread.model === model && read.thread.reasoningEffort === effort && !read.owned;
  console.log(JSON.stringify({ passed, status: turn?.status, model: read.thread.model, effort: read.thread.reasoningEffort, writerReleased: !read.owned }));
  if (!passed) throw new Error('聊天参数验证未通过');
  await local.client.request('thread/archive', { threadId });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (threadId && local.running.has(threadId)) await local.handle('interrupt', { threadId }).catch(() => {}); local.stop(); }
