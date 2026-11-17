import fs from 'node:fs';
import path from 'node:path';
import { CodexClient } from '../src/codex.js';
import { ROOT } from '../src/config.js';
import { LocalAgent } from '../src/local-agent.js';
const source = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev/live-smoke.json'), 'utf8'));
const args = ['app-server', '-c', 'thread_unload_delay_secs=0', '--listen', 'stdio://'];
const a = new CodexClient({ args }); const b = new CodexClient({ args });
const local = new LocalAgent({ client: a });
let id; let secondOwns = false;
try {
  await Promise.all([a.start(), b.start()]);
  // Fork only the isolated verification conversation created by this project's smoke test.
  const fork = await a.request('thread/fork', { threadId: source.threadId, excludeTurns: true }); id = fork.thread.id;
  local.loaded.add(id); local.metadata.set(id, fork.thread);
  let conflict;
  try { await b.request('thread/resume', { threadId: id, excludeTurns: true }); secondOwns = true; }
  catch (error) { conflict = { code: error.code, message: error.message, data: error.data }; }
  console.log(JSON.stringify({ step: 'before-release', competingResumeSucceeded: secondOwns, conflict }));
  const released = await local.releaseThread(id);
  const until = Date.now() + 10000; let loaded = true;
  while (loaded && Date.now() < until) {
    loaded = (await a.request('thread/loaded/list', {})).data.includes(id);
    if (loaded) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (loaded) throw new Error('Thread did not unload within 10 seconds');
  const resumed = await b.request('thread/resume', { threadId: id, excludeTurns: true }); secondOwns = true;
  console.log(JSON.stringify({ step: 'after-release', released: released.released, unloaded: !loaded, competingResumeSucceeded: resumed.thread.id === id }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (id) await (secondOwns ? b : a).request('thread/archive', { threadId: id }).catch(() => {});
  local.stop(); b.stop();
}
