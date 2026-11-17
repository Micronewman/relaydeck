import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { DATA_DIR, readJson, writeJson } from './config.js';
import { LocalAgent } from './local-agent.js';

export async function connectAgent({ hubUrl, credentials, local, reconnect = true }) {
  let socket; let timer; let stopped = false; let attempt = 0;
  const url = new URL('/agent', hubUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const onEvent = event => send({ type: 'event', event }); local.on('event', onEvent);
  function connect() {
    if (stopped) return;
    socket = new WebSocket(url, { headers: { Authorization: `Bearer ${credentials.token}` }, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15000 });
    socket.on('open', () => {
      attempt = 0; send({ type: 'hello', info: local.info() });
      local.start().then(() => send({ type: 'hello', info: local.info() })).catch(error => { console.error(`Codex: ${error.message}`); send({ type: 'hello', info: local.info() }); });
    });
    socket.on('message', async data => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'request') return;
      const replySocket = socket;
      try {
        const result = await local.handle(msg.action, msg.params);
        if (replySocket.readyState === WebSocket.OPEN) replySocket.send(JSON.stringify({ type: 'result', id: msg.id, result }));
      } catch (error) {
        if (replySocket.readyState === WebSocket.OPEN) replySocket.send(JSON.stringify({ type: 'result', id: msg.id, error: error.message }));
      }
    });
    socket.on('error', error => { if (!stopped) console.error(`连接: ${error.message}`); });
    socket.on('close', () => {
      if (!stopped && reconnect) timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt++) + Math.random() * 1000);
    });
  }
  connect();
  return { close() { stopped = true; clearTimeout(timer); local.off('event', onEvent); socket?.close(); local.stop(); } };
}

async function main() {
  const argv = process.argv.slice(2); const arg = key => { const at = argv.indexOf(key); return at < 0 ? null : argv[at + 1]; };
  const file = path.join(DATA_DIR, 'agent.json'); let credentials = readJson(file, null);
  const hubUrl = arg('--hub') || credentials?.hubUrl;
  if (!hubUrl) throw new Error('首次运行请使用 npm run agent -- --hub https://你的电脑.ts.net --code 配对码 --name 设备名');
  const url = new URL(hubUrl);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程连接必须使用 HTTPS（通过 Tailscale Serve）。');
  if (!credentials || arg('--code')) {
    const code = arg('--code'); if (!code) throw new Error('需要统一服务页面生成的一次性配对码。');
    const name = arg('--name') || os.hostname();
    const response = await fetch(new URL('/api/agent/enroll', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }), signal: AbortSignal.timeout(15000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '配对失败');
    credentials = { ...result, hubUrl: url.origin, name }; writeJson(file, credentials);
  } else if (new URL(credentials.hubUrl).origin !== url.origin) throw new Error('更换统一服务需要新的 --code 配对码。');
  const local = new LocalAgent({ id: credentials.id, name: credentials.name });
  const connection = await connectAgent({ hubUrl: url.origin, credentials, local });
  console.log(`RelayDeck 连接程序已启动: ${credentials.name} → ${url.origin}`);
  console.log('关闭此进程会断开设备并停止此进程中的 Codex。');
  const shutdown = () => { connection.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
