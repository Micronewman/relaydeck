import { CodexClient } from '../src/codex.js';
const client = new CodexClient();
client.on('request', msg => client.reject(msg.id, 'Read-only integration probe'));
try {
  const init = await client.start();
  const list = await client.request('thread/list', { limit: 3, modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], sortKey: 'updated_at' });
  console.log(JSON.stringify({ connected: true, userAgent: init.userAgent, threadCountInPage: list.data.length, providers: [...new Set(list.data.map(t => t.modelProvider))] }));
  if (list.data[0]) {
    const threadId = list.data[0].id;
    const read = await client.request('thread/read', { threadId });
    const turns = await client.request('thread/turns/list', { threadId, limit: 2, sortDirection: 'desc', itemsView: 'full' });
    console.log(JSON.stringify({ metadataReadable: !!read.thread, historyMode: read.thread.historyMode, turnsReadable: turns.data.length, statuses: turns.data.map(t => t.status), itemTypes: [...new Set(turns.data.flatMap(t => t.items.map(i => i.type)))] }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.stop(); }
