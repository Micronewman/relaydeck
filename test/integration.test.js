import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { testHub, fakeAgent, until, delay } from './helpers.js';
import { connectAgent } from '../src/remote-agent.js';

test('login, origin checks, static isolation and secure cookie', async () => {
  const t = await testHub();
  try {
    assert.equal((await t.request('/api/state', undefined, { auth: false })).response.status, 401);
    assert.equal((await t.request('/api/login', { code: 'wrong' }, { auth: false })).response.status, 401);
    assert.equal((await t.request('/api/pairings', {}, { headers: { Origin: 'https://attacker.invalid' } })).response.status, 403);
    assert.equal((await t.request('/api/login', { code: t.config.accessCode }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).response.status, 403);
    assert.equal((await fetch(t.base + '/.relaydeck/config.json')).status, 404);
    assert.equal((await fetch(t.base + '/%2e%2e%2f.relaydeck/config.json')).status, 403);
    const login = await t.request('/api/login', { code: t.config.accessCode }, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(login.response.headers.get('set-cookie'), /HttpOnly/); assert.match(login.response.headers.get('set-cookie'), /Secure/);
    const state = (await t.request('/api/state')).data;
    assert.equal(state.devices[0].online, true); assert.equal(state.accessCode, undefined);
    await t.request('/api/logout', {}); assert.equal((await t.request('/api/state')).response.status, 401);
  } finally { await t.close(); }
});

test('real JSON-RPC transport reads history and rejects invalid paths', async () => {
  const t = await testHub();
  try {
    const list = await t.request('/api/devices/test-local/threads'); assert.equal(list.data.threads[0].id, 'thread-demo');
    const thread = await t.request('/api/devices/test-local/thread?threadId=thread-demo'); assert.equal(thread.data.turns[0].items.length, 2);
    const bad = await t.request('/api/devices/test-local/create', { cwd: 'not-absolute' }); assert.equal(bad.response.status, 400);
    const good = await t.request('/api/devices/test-local/create', { cwd: process.cwd() }); assert.equal(good.response.status, 200);
    assert.equal(good.data.thread.modelProvider, 'custom');
    const notFlushedYet = await t.request(`/api/devices/test-local/thread?threadId=${good.data.thread.id}`);
    assert.equal(notFlushedYet.response.status, 200); assert.equal(notFlushedYet.data.thread.id, good.data.thread.id); assert.deepEqual(notFlushedYet.data.turns, []);
  } finally { await t.close(); }
});

test('one submission starts exactly one turn; duplicate IDs and concurrent turns are guarded', async () => {
  const t = await testHub();
  try {
    const message = { threadId: 'thread-demo', text: 'SLOW', clientId: randomUUID() };
    const [first, repeat] = await Promise.all([t.request('/api/devices/test-local/send', message), t.request('/api/devices/test-local/send', message)]);
    assert.equal(first.response.status, 200); assert.equal(repeat.data.turn.id, first.data.turn.id);
    const collision = await t.request('/api/devices/test-local/send', { ...message, text: 'different' }); assert.equal(collision.response.status, 409);
    const second = await t.request('/api/devices/test-local/send', { ...message, clientId: randomUUID() }); assert.equal(second.response.status, 400);
    await until(() => !t.local.running.has('thread-demo'));
    const read = await t.request('/api/devices/test-local/thread?threadId=thread-demo'); assert.equal(read.data.turns.length, 2);
    assert.equal(read.data.turns.at(-1).items.at(-1).text.includes('任务已完成'), true);
  } finally { await t.close(); }
});

test('approval survives browser disconnect, rejects stale replies; interrupt works', async () => {
  const t = await testHub();
  try {
    await t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'APPROVE', clientId: randomUUID() });
    await until(() => t.local.approvals.size === 1);
    const read = await t.request('/api/devices/test-local/thread?threadId=thread-demo'); const approval = read.data.approvals[0];
    assert.equal((await t.request('/api/devices/test-local/respond', { id: approval.id, decision: 'accept' })).response.status, 200);
    assert.equal((await t.request('/api/devices/test-local/respond', { id: approval.id, decision: 'accept' })).response.status, 400);
    await until(() => !t.local.running.size);
    await t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'SLOW', clientId: randomUUID() });
    assert.equal((await t.request('/api/devices/test-local/interrupt', { threadId: 'thread-demo' })).response.status, 200);
    await until(() => !t.local.running.size);
    const after = await t.request('/api/devices/test-local/thread?threadId=thread-demo'); assert.equal(after.data.turns.at(-1).status, 'interrupted');
    await t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'APPROVE', clientId: randomUUID() });
    await until(() => t.local.approvals.size === 1);
    const pending = [...t.local.approvals.values()][0];
    assert.equal((await t.request('/api/devices/test-local/respond', { id: pending.id, decision: 'decline' })).response.status, 200);
    await until(() => !t.local.running.size);
  } finally { await t.close(); }
});

test('remote device enrolls once, routes RPC, and loses access after revocation', async () => {
  const t = await testHub(); let connection;
  try {
    const pairing = (await t.request('/api/pairings', {})).data;
    const enrolled = await t.request('/api/agent/enroll', { code: pairing.code, name: '远程测试电脑' }, { auth: false }); assert.equal(enrolled.response.status, 200);
    const again = await t.request('/api/agent/enroll', { code: pairing.code, name: '重复' }, { auth: false }); assert.equal(again.response.status, 401);
    const local = fakeAgent(enrolled.data.id, '远程测试电脑');
    connection = await connectAgent({ hubUrl: t.base, credentials: enrolled.data, local, reconnect: false });
    await until(() => t.hub.state().devices.find(d => d.id === enrolled.data.id)?.online);
    const list = await t.request(`/api/devices/${enrolled.data.id}/threads`); assert.equal(list.data.threads.length, 1);
    const catalog = await t.request(`/api/devices/${enrolled.data.id}/models`); assert.equal(catalog.data.models.length, 2);
    const settings = await t.request(`/api/devices/${enrolled.data.id}/settings`, { threadId: 'thread-demo', settings: { model: 'test-reasoner', effort: 'xhigh' } }); assert.equal(settings.response.status, 200);
    const sent = await t.request(`/api/devices/${enrolled.data.id}/send`, { threadId: 'thread-demo', text: 'remote', clientId: randomUUID() }); assert.equal(sent.response.status, 200);
    const forwarded = await local.client.request('fixture/lastTurnParams'); assert.equal(forwarded.model, 'test-reasoner'); assert.equal(forwarded.effort, 'xhigh');
    await until(() => !local.running.size);
    const read = await t.request(`/api/devices/${enrolled.data.id}/thread?threadId=thread-demo`); assert.match(read.data.turns.at(-1).items.at(-1).text, /remote/);
    await t.request(`/api/devices/${enrolled.data.id}`, {}, { method: 'DELETE' });
    assert.equal((await t.request(`/api/devices/${enrolled.data.id}/threads`)).response.status, 503);
  } finally { connection?.close(); await t.close(); }
});

test('browser events stream is authenticated and tasks finish after it disconnects', async () => {
  const t = await testHub();
  try {
    const controller = new AbortController();
    const response = await fetch(t.base + '/api/events', { headers: { Cookie: t.cookie }, signal: controller.signal });
    const reader = response.body.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /connected/);
    await t.request('/api/devices/test-local/send', { threadId: 'thread-demo', text: 'SLOW', clientId: randomUUID() });
    controller.abort();
    await until(() => !t.local.running.size);
    const read = await t.request('/api/devices/test-local/thread?threadId=thread-demo'); assert.equal(read.data.turns.at(-1).status, 'completed');
  } finally { await t.close(); }
});

test('agent websocket rejects missing authentication', async () => {
  const t = await testHub();
  try {
    const code = await new Promise(resolve => {
      const socket = new WebSocket(t.base.replace('http:', 'ws:') + '/agent');
      socket.on('unexpected-response', (_, response) => { resolve(response.statusCode); socket.terminate(); }); socket.on('error', () => {});
    });
    assert.equal(code, 401);
  } finally { await t.close(); }
});
