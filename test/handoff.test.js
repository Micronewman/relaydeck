import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testHub, until, delay } from './helpers.js';

test('completed turns release the engine writer; history reads never reacquire it', async () => {
  const t = await testHub();
  try {
    const send = () => t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'handoff', clientId: randomUUID() });
    assert.equal((await send()).response.status, 200);
    await until(() => !t.local.loaded.has('thread-demo') && !t.local.releasing.has('thread-demo'));
    assert.deepEqual((await t.local.client.request('thread/loaded/list')).data, []);
    const history = await t.request('/api/devices/test-local/thread?threadId=thread-demo');
    assert.equal(history.data.owned, false); assert.equal(history.data.turns.at(-1).status, 'completed');
    assert.deepEqual((await t.local.client.request('thread/loaded/list')).data, []);
    // Continuing must explicitly resume again after automatic handoff.
    assert.equal((await send()).response.status, 200);
    await until(() => !t.local.loaded.has('thread-demo') && !t.local.releasing.has('thread-demo'));
    assert.equal((await t.request('/api/devices/test-local/thread?threadId=thread-demo')).data.turns.length, 3);
  } finally { await t.close(); }
});

test('manual handoff refuses an active task and pending approval without interrupting them', async () => {
  const t = await testHub();
  try {
    await t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'APPROVE', clientId: randomUUID() });
    await until(() => t.local.approvals.size === 1);
    const refused = await t.request('/api/devices/test-local/release', { threadId: 'thread-demo' });
    assert.equal(refused.response.status, 400); assert.equal(t.local.running.has('thread-demo'), true); assert.equal(t.local.approvals.size, 1);
    const id = [...t.local.approvals.keys()][0]; await t.request('/api/devices/test-local/respond', { id, decision: 'accept' });
    await until(() => !t.local.running.size);
    assert.equal((await t.request('/api/devices/test-local/release', { threadId: 'thread-demo' })).data.released, true);
    assert.equal(t.local.loaded.has('thread-demo'), false);
  } finally { await t.close(); }
});

test('send waits for an in-flight handoff rather than racing engine unload', async () => {
  const t = await testHub();
  try {
    await t.local.client.request('thread/resume', { threadId: 'thread-demo' }); t.local.loaded.add('thread-demo');
    const release = t.local.releaseThread('thread-demo');
    const sent = t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'after release', clientId: randomUUID() });
    assert.equal((await release).released, true); assert.equal((await sent).response.status, 200);
    await until(() => !t.local.running.size && !t.local.loaded.size);
    const history = await t.request('/api/devices/test-local/thread?threadId=thread-demo'); assert.match(history.data.turns.at(-1).items.at(-1).text, /after release/);
  } finally { await t.close(); }
});

test('native-client ownership is explained and never forcibly taken over', async () => {
  const t = await testHub();
  try {
    await t.local.client.request('fixture/claim', { threadId: 'thread-demo' });
    const conflict = await t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'must not execute', clientId: randomUUID() });
    assert.equal(conflict.response.status, 409); assert.match(conflict.data.error, /原生 Codex/);
    const history = await t.request('/api/devices/test-local/thread?threadId=thread-demo'); assert.equal(history.data.turns.length, 1);
    assert.equal((await t.request('/api/devices/test-local/release', { threadId: 'thread-demo' })).data.released, true);
    const stillOwned = await t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'still blocked', clientId: randomUUID() });
    assert.equal(stillOwned.response.status, 409);
  } finally { await t.close(); }
});
