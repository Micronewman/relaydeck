import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ROOT, DATA_DIR, loadConfig, saveConfig, readJson, writeJson, token, hash, equal } from './config.js';
import { LocalAgent } from './local-agent.js';

const SESSION_AGE = 30 * 86400000;
const ACTIONS = new Set(['threads', 'thread', 'create', 'send', 'interrupt', 'respond', 'release', 'models', 'settings']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function problem(message, status = 400) { const error = new Error(message); error.status = status; return error; }
async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw problem('请求必须使用 JSON', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw problem('请求太大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw problem('无效的 JSON'); }
}
function json(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

export function createHub(options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  const config = options.config || loadConfig(dataDir);
  const local = options.local || new LocalAgent({ id: config.deviceId, name: config.deviceName, cwd: options.cwd || ROOT, dataDir });
  const remotes = new Map(); const streams = new Set(); const sessionsFile = path.join(dataDir, 'sessions.json');
  const requestsFile = path.join(dataDir, 'requests.json');
  const sessions = readJson(sessionsFile, {}); const ledger = readJson(requestsFile, {});
  const attempts = new Map(); const inFlight = new Map();
  let publicUrl = options.publicUrl || process.env.RELAYDECK_PUBLIC_URL || '';
  let stopping = false;
  const origins = () => {
    const port = server.address()?.port || config.port;
    const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
    if (publicUrl) allowed.add(new URL(publicUrl).origin);
    return allowed;
  };
  function allowedHost(req) { return [...origins()].some(origin => new URL(origin).host.toLowerCase() === (req.headers.host || '').toLowerCase()); }
  function validateOrigin(req) {
    if (req.headers.origin && !origins().has(req.headers.origin)) throw problem('拒绝跨站请求', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw problem('拒绝跨站请求', 403);
  }
  function sessionId(req) { return String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('rd_session='))?.slice(11); }
  function authenticate(req) {
    const sid = sessionId(req); const key = sid ? hash(sid) : '';
    if (!sessions[key] || sessions[key].expires < Date.now()) throw problem('请先输入访问码登录', 401);
    return key;
  }
  function saveSessions() {
    for (const [id, session] of Object.entries(sessions)) if (session.expires < Date.now()) delete sessions[id];
    writeJson(sessionsFile, sessions);
  }
  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) {
      if (!sessions[stream.key] || sessions[stream.key].expires < Date.now() || stream.res.writableLength > 2 * 1024 * 1024) { stream.res.end(); continue; }
      stream.res.write(payload);
    }
  }
  function deviceList() {
    const devices = [{ ...local.info(), local: true }];
    for (const entry of config.agents) {
      const remote = remotes.get(entry.id);
      devices.push({ id: entry.id, name: entry.name, local: false, online: false, ...remote?.info,
        id: entry.id, name: entry.name, online: !!remote?.info?.online && remote.ws.readyState === WebSocket.OPEN,
        lastSeen: remote?.lastSeen || entry.lastSeen || null });
    }
    return devices;
  }
  const state = () => ({ name: 'RelayDeck', version: '0.2.1', publicUrl, devices: deviceList() });
  local.on('event', event => broadcast({ deviceId: config.deviceId, ...event }));
  async function callDevice(id, action, params) {
    if (!ACTIONS.has(action)) throw problem('不支持的操作');
    if (id === config.deviceId) return local.handle(action, params);
    const remote = remotes.get(id);
    if (!remote || remote.ws.readyState !== WebSocket.OPEN) throw problem('设备离线，请先在目标电脑启动连接程序。', 503);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { remote.pending.delete(requestId); reject(problem('设备响应超时，执行状态可能未知；请重新读取会话确认。', 504)); }, 120000);
      remote.pending.set(requestId, { resolve, reject, timer });
      remote.ws.send(JSON.stringify({ type: 'request', id: requestId, action, params }));
    });
  }
  function persistLedger() {
    const entries = Object.entries(ledger).sort((a, b) => b[1].at - a[1].at);
    for (const [key] of entries.slice(1000)) delete ledger[key];
    writeJson(requestsFile, ledger);
  }
  async function sendOnce(deviceId, params) {
    if (typeof params.clientId !== 'string' || !/^[\w-]{10,100}$/.test(params.clientId)) throw problem('无效的消息标识');
    const key = `${deviceId}:${params.clientId}`; const fingerprint = hash(JSON.stringify([params.threadId, params.text]));
    if (ledger[key]) {
      if (ledger[key].fingerprint !== fingerprint) throw problem('消息标识已被使用', 409);
      if (inFlight.has(key)) return inFlight.get(key);
      if (ledger[key].status === 'accepted') return ledger[key].result;
      throw problem(ledger[key].error || '这条消息曾经提交，状态尚未确认。请刷新会话确认后再决定是否发送新消息。', 409);
    }
    ledger[key] = { fingerprint, status: 'pending', at: Date.now() }; persistLedger();
    const promise = callDevice(deviceId, 'send', params).then(result => {
      const acknowledgement = { turn: { id: result.turn.id, status: result.turn.status } };
      ledger[key] = { ...ledger[key], status: 'accepted', result: acknowledgement }; persistLedger();
      return acknowledgement;
    }).catch(error => {
      ledger[key] = { ...ledger[key], status: 'unconfirmed', error: error.message }; persistLedger(); throw error;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, promise); return promise;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      if (!allowedHost(req)) throw problem('未知的访问地址，请检查 RELAYDECK_PUBLIC_URL 配置。', 403);
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (route === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'relaydeck' });
      if (route.startsWith('/api/') && req.method !== 'GET') validateOrigin(req);
      if (route === '/api/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress || 'local';
        let rate = attempts.get(key);
        if (!rate || Date.now() > rate.reset) { rate = { count: 0, reset: Date.now() + 15 * 60000 }; attempts.set(key, rate); }
        if (rate.count >= 20) throw problem('尝试次数过多，请 15 分钟后重试。', 429);
        const input = await jsonBody(req);
        if (typeof input.code !== 'string' || !equal(input.code.trim(), config.accessCode)) { rate.count++; throw problem('访问码不正确', 401); }
        attempts.delete(key);
        const sid = token(); sessions[hash(sid)] = { expires: Date.now() + SESSION_AGE }; saveSessions();
        const secure = req.headers['x-forwarded-proto'] === 'https' || (publicUrl && req.headers.host === new URL(publicUrl).host);
        return json(res, 200, { ok: true }, { 'Set-Cookie': `rd_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE / 1000}${secure ? '; Secure' : ''}` });
      }
      if (route === '/api/agent/enroll' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (typeof body.code !== 'string' || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw problem('无效的配对信息');
        const index = config.pairings.findIndex(p => equal(p.hash, hash(body.code)) && p.expires > Date.now());
        if (index < 0) throw problem('配对码错误、已使用或已过期', 401);
        const secret = token(); const id = randomUUID();
        config.pairings.splice(index, 1); config.agents.push({ id, name: body.name.trim(), tokenHash: hash(secret), createdAt: Date.now() });
        saveConfig(config, dataDir); broadcast({ type: 'devices-changed' });
        return json(res, 200, { id, token: secret });
      }
      if (route.startsWith('/api/')) {
        const key = authenticate(req);
        if (route === '/api/logout' && req.method === 'POST') {
          delete sessions[key]; saveSessions();
          for (const stream of streams) if (stream.key === key) stream.res.end();
          return json(res, 200, { ok: true }, { 'Set-Cookie': 'rd_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        }
        if (route === '/api/state' && req.method === 'GET') return json(res, 200, state());
        if (route === '/api/events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`data: ${JSON.stringify({ type: 'connected', state: state() })}\n\n`);
          const stream = { res, key }; streams.add(stream); res.on('close', () => streams.delete(stream)); return;
        }
        if (route === '/api/pairings' && req.method === 'POST') {
          const code = token(); config.pairings = config.pairings.filter(p => p.expires > Date.now());
          config.pairings.push({ hash: hash(code), expires: Date.now() + 10 * 60000 }); saveConfig(config, dataDir);
          return json(res, 201, { code, expiresIn: 600, hubUrl: publicUrl || [...origins()][0] });
        }
        const revoke = route.match(/^\/api\/devices\/([^/]+)$/);
        if (revoke && req.method === 'DELETE') {
          const id = decodeURIComponent(revoke[1]);
          if (id === config.deviceId) throw problem('不能移除本机');
          config.agents = config.agents.filter(a => a.id !== id); saveConfig(config, dataDir);
          remotes.get(id)?.ws.close(1008, 'Device removed'); remotes.delete(id);
          broadcast({ type: 'devices-changed' }); return json(res, 200, { ok: true });
        }
        const match = route.match(/^\/api\/devices\/([^/]+)\/(threads|thread|create|send|interrupt|respond|release|models|settings)$/);
        if (match) {
          const id = decodeURIComponent(match[1]); const action = match[2];
          const read = ['threads', 'thread', 'models'].includes(action);
          if (req.method !== (read ? 'GET' : 'POST')) throw problem('请求方法错误', 405);
          const params = read ? Object.fromEntries(url.searchParams) : await jsonBody(req);
          const result = action === 'send' ? await sendOnce(id, params) : await callDevice(id, action, params);
          return json(res, 200, result);
        }
        throw problem('接口不存在', 404);
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw problem('请求方法错误', 405);
      const vendor = {
        '/vendor/marked.js': path.join(ROOT, 'node_modules/marked/lib/marked.esm.js'),
        '/vendor/purify.js': path.join(ROOT, 'node_modules/dompurify/dist/purify.es.mjs')
      };
      const publicDir = path.join(ROOT, 'public');
      const file = vendor[route] || path.resolve(publicDir, '.' + decodeURIComponent(route === '/' ? '/index.html' : route));
      if (!vendor[route] && !file.startsWith(publicDir + path.sep)) throw problem('无效路径', 403);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw problem('页面不存在', 404);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || (vendor[route] ? 'text/javascript; charset=utf-8' : 'application/octet-stream'), 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!allowedHost(req) || req.url !== '/agent' || req.headers.origin) return socket.destroy();
    const credential = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const agent = config.agents.find(a => credential && equal(a.tokenHash, hash(credential)));
    if (!agent) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, agent));
  });
  wss.on('connection', (ws, agent) => {
    const previous = remotes.get(agent.id); previous?.ws.close(1000, 'Replaced by a new connection');
    const remote = { ws, info: { online: false }, pending: new Map(), lastSeen: Date.now(), alive: true };
    remotes.set(agent.id, remote);
    ws.on('pong', () => { remote.alive = true; remote.lastSeen = Date.now(); });
    ws.on('error', () => {});
    ws.on('message', data => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { ws.close(1003, 'Invalid message'); return; }
      remote.lastSeen = Date.now();
      if (msg.type === 'hello' && msg.info && typeof msg.info === 'object') {
        remote.info = { ...msg.info, id: agent.id, name: agent.name }; broadcast({ type: 'devices-changed' });
      } else if (msg.type === 'result') {
        const pending = remote.pending.get(msg.id); if (!pending) return;
        remote.pending.delete(msg.id); clearTimeout(pending.timer);
        msg.error ? pending.reject(problem(String(msg.error), 400)) : pending.resolve(msg.result);
      } else if (msg.type === 'event' && msg.event && typeof msg.event === 'object') {
        if (!['agent-state', 'codex', 'approval', 'approval-resolved', 'notice', 'ownership', 'settings-changed'].includes(msg.event.type)) return;
        if (msg.event.type === 'agent-state') remote.info = { ...msg.event, id: agent.id, name: agent.name };
        const event = msg.event;
        if (event.type === 'ownership') {
          const loaded = new Set(remote.info.loadedThreads || []); const releasing = new Set(remote.info.releasingThreads || []);
          event.owned ? loaded.add(event.threadId) : loaded.delete(event.threadId);
          event.releasing ? releasing.add(event.threadId) : releasing.delete(event.threadId);
          remote.info.loadedThreads = [...loaded]; remote.info.releasingThreads = [...releasing];
        }
        if (event.type === 'approval') remote.info.approvals = [...(remote.info.approvals || []).filter(a => a.id !== event.approval.id), event.approval];
        if (event.type === 'approval-resolved') remote.info.approvals = (remote.info.approvals || []).filter(a => a.id !== event.id);
        if (event.type === 'codex') {
          const p = event.params || {}; remote.info.running ||= {};
          if (event.method === 'turn/started') remote.info.running[p.threadId] = p.turn.id;
          if (event.method === 'turn/completed') {
            delete remote.info.running[p.threadId];
            remote.info.approvals = (remote.info.approvals || []).filter(a => a.params.threadId !== p.threadId);
          }
          if (event.method === 'serverRequest/resolved') remote.info.approvals = (remote.info.approvals || []).filter(a => !a.id.endsWith(`:${p.requestId}`));
        }
        broadcast({ ...msg.event, deviceId: agent.id });
      }
    });
    ws.on('close', () => {
      for (const pending of remote.pending.values()) { clearTimeout(pending.timer); pending.reject(problem('设备连接断开，已提交任务可能仍在执行；请重连后查看。', 503)); }
      remote.pending.clear();
      if (remotes.get(agent.id) === remote) { remote.info.online = false; broadcast({ type: 'devices-changed' }); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.res.write(': keepalive\n\n');
    for (const remote of remotes.values()) {
      if (remote.ws.readyState !== WebSocket.OPEN) continue;
      if (!remote.alive) { remote.ws.terminate(); continue; }
      remote.alive = false; remote.ws.ping();
    }
  }, 25000);
  heartbeat.unref();
  return {
    server, config, local, state,
    setPublicUrl(url) { publicUrl = url; },
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      local.start().catch(error => { local.error = error.message; broadcast({ type: 'devices-changed' }); });
      return server.address();
    },
    async close() {
      if (stopping) return; stopping = true; clearInterval(heartbeat);
      for (const stream of streams) stream.res.end();
      for (const remote of remotes.values()) remote.ws.terminate();
      wss.close(); local.stop();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    }
  };
}
