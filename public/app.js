import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { mountOptions, effortName } from '/options.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const state = { devices: [], deviceId: null, threadId: null, thread: null, threads: [], turns: [], cursor: null, historyCursor: null, historyExpanded: false, activeTurnId: null, approvals: [], owned: false, releasing: false, connected: false, sending: false, search: '', authenticated: false, publicUrl: '' };
let events, toastTimer, renderTimer, searchTimer, threadListVersion = 0, historyVersion = 0, approvalSignature = '';
let optionsDialogVersion = 0, optionsForm = null;
const device = () => state.devices.find(d => d.id === state.deviceId);
const selection = () => `${state.deviceId}/${state.threadId}`;
const draftKey = () => `rd-draft:${selection()}`;
const computerIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
async function api(route, params, method = params ? 'POST' : 'GET') {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 135000);
  let response;
  try {
    response = await fetch(`/api${route}`, { method, credentials: 'same-origin', cache: 'no-store', headers: params ? { 'Content-Type': 'application/json' } : {}, body: params ? JSON.stringify(params) : undefined, signal: controller.signal });
  } catch (error) { throw new Error(error.name === 'AbortError' ? '请求超时。任务状态可能未知，请刷新会话确认，不要重复发送。' : '无法连接工作台。请检查电脑服务和手机的 Tailscale 连接。'); }
  finally { clearTimeout(timer); }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && route !== '/login') showLogin();
    throw new Error(result.error || `请求失败（${response.status}）`);
  }
  return result;
}
function deviceApi(action, params, method) {
  const prefix = `/devices/${encodeURIComponent(state.deviceId)}/${action}`;
  if (method === 'GET') return api(`${prefix}?${new URLSearchParams(params || {})}`);
  return api(prefix, params || {});
}
function showLogin() {
  state.authenticated = false; events?.close(); events = null;
  $('login').hidden = false; $('app').hidden = true;
  state.turns = []; state.approvals = []; state.thread = null; state.threadId = null;
  $('messages').replaceChildren(); $('approvals').replaceChildren(); $('message-input').value = '';
  approvalSignature = '';
  if ($('modal').open) $('modal').close();
}
async function init() {
  try {
    const result = await api('/state'); state.authenticated = true; applyState(result);
    $('login').hidden = true; $('app').hidden = false; $('access-code').value = '';
    connectEvents();
    const saved = localStorage.getItem('rd-device');
    await chooseDevice(state.devices.some(d => d.id === saved) ? saved : state.devices[0]?.id);
  } catch (error) { showLogin(); if (!/登录/.test(error.message)) $('login-error').textContent = error.message; }
}
function applyState(result) {
  state.devices = result.devices || []; state.publicUrl = result.publicUrl || '';
  renderDevices();
  if (state.threadId) {
    state.approvals = (device()?.approvals || []).filter(a => a.params.threadId === state.threadId);
    if (device()?.running?.[state.threadId]) state.activeTurnId = device().running[state.threadId];
    if (Array.isArray(device()?.loadedThreads)) state.owned = device().loadedThreads.includes(state.threadId);
    state.releasing = device()?.releasingThreads?.includes(state.threadId) || false;
    renderApprovals(); renderComposer();
  }
}
async function refreshState() { if (!state.authenticated) return; applyState(await api('/state')); }
function connection(connected) {
  state.connected = connected; $('connection-label').textContent = connected ? '工作台已连接' : '正在重新连接…';
  $('connection-dot').classList.toggle('offline', !connected); renderComposer();
}
function connectEvents() {
  events?.close(); events = new EventSource('/api/events');
  events.onerror = () => connection(false);
  events.onmessage = event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'connected') {
      connection(true); applyState(message.state);
      if (state.threadId) refreshThread().catch(error => toast(error.message));
      return;
    }
    if (message.type === 'devices-changed') { refreshState().catch(() => {}); return; }
    const d = state.devices.find(d => d.id === message.deviceId);
    if (message.type === 'agent-state' && d) { Object.assign(d, message); renderDevices(); renderComposer(); }
    if (message.type === 'approval' && d) {
      d.approvals ||= []; d.approvals = [...d.approvals.filter(a => a.id !== message.approval.id), message.approval];
    }
    if (message.type === 'approval-resolved' && d) d.approvals = (d.approvals || []).filter(a => a.id !== message.id);
    if (message.type === 'ownership' && d) {
      const loaded = new Set(d.loadedThreads || []); const releasing = new Set(d.releasingThreads || []);
      message.owned ? loaded.add(message.threadId) : loaded.delete(message.threadId);
      message.releasing ? releasing.add(message.threadId) : releasing.delete(message.threadId);
      d.loadedThreads = [...loaded]; d.releasingThreads = [...releasing];
    }
    if (message.deviceId !== state.deviceId) return;
    if (message.type === 'settings-changed' && message.threadId === state.threadId) {
      if (state.thread) state.thread.settings = message.settings;
      renderComposer(); return;
    }
    if (message.type === 'ownership' && message.threadId === state.threadId) {
      state.owned = message.owned; state.releasing = message.releasing; renderComposer(); return;
    }
    if (message.type === 'approval' || message.type === 'approval-resolved') {
      state.approvals = (d?.approvals || []).filter(a => a.params.threadId === state.threadId); renderApprovals(); return;
    }
    if (message.type === 'notice') { if (message.threadId === state.threadId) toast(message.message); return; }
    if (message.type !== 'codex') return;
    const { method, params } = message;
    if (method === 'thread/started' || method === 'thread/name/updated') refreshThreads().catch(() => {});
    if (params.threadId !== state.threadId) return;
    if (method === 'serverRequest/resolved') {
      state.approvals = state.approvals.filter(a => !a.id.endsWith(`:${params.requestId}`));
      if (d) d.approvals = (d.approvals || []).filter(a => !a.id.endsWith(`:${params.requestId}`));
      renderApprovals(); return;
    }
    if (method === 'turn/started') {
      state.activeTurnId = params.turn.id; state.owned = true;
      if (d) { d.running ||= {}; d.running[state.threadId] = params.turn.id; }
      if (!state.turns.find(t => t.id === params.turn.id)) state.turns.push({ ...params.turn, items: [] });
    } else if (method === 'turn/completed') {
      const turn = state.turns.find(t => t.id === params.turn.id);
      if (turn) { turn.status = params.turn.status; turn.error = params.turn.error; }
      state.activeTurnId = null; if (d?.running) delete d.running[state.threadId];
      state.approvals = []; if (d) d.approvals = (d.approvals || []).filter(a => a.params.threadId !== state.threadId);
      renderApprovals(); refreshThread().catch(() => {}); refreshThreads().catch(() => {});
    } else if (method === 'item/started' || method === 'item/completed') {
      const turn = ensureTurn(params.turnId); const index = turn.items.findIndex(i => i.id === params.item.id);
      if (index < 0) turn.items.push(params.item); else turn.items[index] = { ...turn.items[index], ...params.item };
    } else if (method === 'item/agentMessage/delta') {
      const turn = ensureTurn(params.turnId); let item = turn.items.find(i => i.id === params.itemId);
      if (!item) { item = { type: 'agentMessage', id: params.itemId, text: '' }; turn.items.push(item); }
      item.text += params.delta;
    } else if (method === 'item/commandExecution/outputDelta') {
      const item = ensureTurn(params.turnId).items.find(i => i.id === params.itemId);
      if (item) item.aggregatedOutput = ((item.aggregatedOutput || '') + params.delta).slice(-80000);
    } else if (method === 'error') {
      $('task-error').hidden = false; $('task-error').textContent = params.error?.message || '任务出现错误，请查看会话。';
    }
    scheduleMessages(); renderComposer();
  };
}
function ensureTurn(id) {
  let turn = state.turns.find(t => t.id === id);
  if (!turn) { turn = { id, status: 'inProgress', items: [] }; state.turns.push(turn); }
  return turn;
}
function renderDevices() {
  $('devices').innerHTML = state.devices.map(d => `<button class="device ${d.id === state.deviceId ? 'active' : ''}" data-device="${esc(d.id)}"><span class="device-icon">${computerIcon}</span><span class="device-text"><span class="device-name">${esc(d.name)}</span><span class="device-meta"><span class="dot ${d.online ? '' : 'offline'}"></span>${d.online ? '在线' : '离线'} · ${d.local ? '统一服务本机' : esc(d.platform || '远程设备')}</span></span></button>`).join('');
}
async function chooseDevice(id) {
  if (!id) return;
  saveDraft(); state.deviceId = id; state.threadId = null; state.thread = null; state.turns = []; state.approvals = []; state.activeTurnId = null; state.releasing = false; state.search = ''; state.threads = [];
  localStorage.setItem('rd-device', id); $('search').value = ''; $('device-name').textContent = device()?.name || '设备';
  $('app').classList.remove('devices-open', 'view-chat'); $('app').classList.add('view-threads');
  renderDevices(); renderHeader(); renderMessages(); renderApprovals(); renderComposer();
  await refreshThreads();
}
function relativeTime(seconds) {
  if (!seconds) return ''; const gap = Date.now() - seconds * 1000;
  if (gap < 60000) return '刚刚'; if (gap < 3600000) return `${Math.floor(gap / 60000)} 分钟前`;
  if (gap < 86400000) return `${Math.floor(gap / 3600000)} 小时前`;
  return new Date(seconds * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
function renderThreads() {
  $('thread-count').textContent = state.threads.length ? state.threads.length : '';
  $('threads').innerHTML = state.threads.length ? state.threads.map(t => `<button class="thread ${t.id === state.threadId ? 'active' : ''}" data-thread="${esc(t.id)}"><div class="thread-name">${esc(t.name)}</div><div class="thread-meta"><span class="thread-path">${t.mode === 'chat' ? '普通聊天' : esc((t.cwd || '').split(/[\\/]/).filter(Boolean).at(-1) || '工作目录')}</span><span>${relativeTime(t.updatedAt)}</span></div></button>`).join('') : '<p class="small-empty">暂无匹配的会话。<br>可以开始一段新对话。</p>';
  $('more-threads').hidden = !state.cursor;
}
async function refreshThreads(older = false) {
  if (!state.deviceId) return;
  const version = ++threadListVersion; const id = state.deviceId;
  if (!older && !state.threads.length) $('threads').innerHTML = '<p class="small-empty">正在读取本机会话…</p>';
  try {
    const result = await deviceApi('threads', { ...(older && state.cursor ? { cursor: state.cursor } : {}), ...(state.search ? { search: state.search } : {}) }, 'GET');
    if (version !== threadListVersion || id !== state.deviceId) return;
    state.threads = older ? [...state.threads, ...result.threads.filter(t => !state.threads.some(old => old.id === t.id))] : result.threads;
    state.cursor = result.nextCursor; renderThreads();
  } catch (error) { if (id === state.deviceId && version === threadListVersion) { $('threads').innerHTML = `<p class="small-empty">${esc(error.message)}</p>`; $('more-threads').hidden = true; } }
}
function saveDraft() {
  if (!state.threadId) return;
  try { const text = $('message-input').value; text ? localStorage.setItem(draftKey(), text) : localStorage.removeItem(draftKey()); } catch {}
}
async function chooseThread(id) {
  saveDraft(); state.threadId = id; state.thread = state.threads.find(t => t.id === id) || null; state.turns = []; state.approvals = []; state.activeTurnId = null; state.historyCursor = null; state.historyExpanded = false; state.owned = false; state.releasing = false;
  $('app').classList.add('view-chat'); $('app').classList.remove('view-threads');
  $('message-input').value = localStorage.getItem(draftKey()) || ''; $('task-error').hidden = true;
  renderThreads(); renderHeader(); renderApprovals(); renderComposer();
  $('messages').innerHTML = '<div class="empty-state"><p>正在读取对话…</p></div>';
  await refreshThread(); $('messages').scrollTop = $('messages').scrollHeight;
}
async function refreshThread(older = false) {
  if (!state.threadId) return;
  const key = selection(); const version = ++historyVersion;
  const result = await deviceApi('thread', { threadId: state.threadId, ...(older && state.historyCursor ? { cursor: state.historyCursor } : {}) }, 'GET');
  if (key !== selection() || version !== historyVersion) return;
  const box = $('messages'); const oldHeight = box.scrollHeight; const oldTop = box.scrollTop;
  state.thread = result.thread; state.owned = result.owned; state.releasing = !!result.releasing; state.activeTurnId = result.activeTurnId;
  state.approvals = result.approvals || [];
  if (older) {
    state.turns = [...result.turns.filter(t => !state.turns.some(old => old.id === t.id)), ...state.turns];
    state.historyCursor = result.nextCursor; state.historyExpanded = true;
  } else if (state.historyExpanded) {
    const fresh = new Map(result.turns.map(t => [t.id, t]));
    state.turns = [...state.turns.map(t => fresh.get(t.id) || t), ...result.turns.filter(t => !state.turns.some(old => old.id === t.id))];
  } else { state.turns = result.turns; state.historyCursor = result.nextCursor; }
  renderHeader(); renderMessages(); renderApprovals(); renderComposer();
  if (older) box.scrollTop = oldTop + box.scrollHeight - oldHeight;
}
function renderHeader() {
  $('chat-title').textContent = state.thread?.name || '随时接上，继续向前。';
  $('chat-subtitle').textContent = state.thread ? `${device()?.name || ''}  /  ${state.thread.mode === 'chat' ? '普通聊天 · 独立聊天目录' : state.thread.cwd || ''}` : '选择一段对话，或开始新的任务';
}
function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true, gfm: true }), { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'], ALLOWED_ATTR: ['href', 'title', 'start'] });
}
function tool(label, output, id, status) {
  const text = String(output || ''); const visible = text.length > 24000 ? '[仅展示最后 24000 字符]\n' + text.slice(-24000) : text;
  return `<details class="tool-item" data-item="${esc(id)}"><summary>${esc(label)}${status === 'inProgress' ? ' · 执行中' : ''}</summary><pre class="tool-output">${esc(visible || '暂无输出')}</pre></details>`;
}
function renderItem(item) {
  if (item.type === 'userMessage') {
    const text = (item.content || []).map(x => x.text || (['image', 'localImage'].includes(x.type) ? '[图片]' : '')).filter(Boolean).join('\n');
    return `<article class="message user"><div class="message-content">${esc(text)}</div></article>`;
  }
  if (item.type === 'agentMessage') return `<article class="message assistant"><div class="message-role"><img src="/icon.svg" alt="">CODEX ${item.phase === 'commentary' ? '· 进度' : ''}</div><div class="message-content markdown">${markdown(item.text)}</div></article>`;
  if (item.type === 'commandExecution') return tool('终端 · ' + (item.command || '').slice(0, 95), `${item.command || ''}\n\n${item.aggregatedOutput || ''}${item.exitCode != null ? `\n\n退出码：${item.exitCode}` : ''}`, item.id, item.status);
  if (item.type === 'fileChange') return tool('文件变更 · ' + (item.changes || []).length, (item.changes || []).map(c => `${c.path}\n${c.diff || c.kind?.type || ''}`).join('\n\n'), item.id, item.status);
  if (item.type === 'plan') return `<article class="message"><div class="message-role">执行计划</div><div class="message-content markdown">${markdown(item.text)}</div></article>`;
  if (item.type === 'reasoning') return item.summary?.length ? tool('思考摘要', item.summary.join('\n'), item.id) : '';
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return tool(`工具 · ${item.tool || item.server || '调用'}`, JSON.stringify(item.error || item.result || item.contentItems || item.arguments || {}, null, 2), item.id, item.status);
  if (item.type === 'webSearch') return tool('网页搜索', item.query || JSON.stringify(item.action || {}), item.id, item.status);
  if (item.type === 'contextCompaction') return '<p class="hint">会话上下文已整理</p>';
  return '';
}
function scheduleMessages() { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = null; renderMessages(); }, 80); }
function renderMessages() {
  const box = $('messages'); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const openItems = new Set([...box.querySelectorAll('details[open]')].map(el => el.dataset.item));
  if (!state.threadId) {
    box.innerHTML = '<div class="empty-state"><div class="empty-orbit"><img src="/icon.svg" alt=""></div><p class="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h3>想法在路上，任务在电脑上。</h3><p>选择左侧的一段对话，继续上次的工作。<br>也可以给这台电脑安排一个新任务。</p><button class="primary" data-action="new">＋ 开始新对话</button></div>'; return;
  }
  let html = state.historyCursor ? '<button class="history-button" data-action="history">↑ 加载更早的消息</button>' : '';
  html += state.turns.map(turn => (turn.items || []).map(renderItem).join('') + (turn.error ? `<p class="turn-error">${esc(turn.error.message)}</p>` : '') + (turn.status === 'interrupted' ? '<p class="hint">此轮任务已中断</p>' : '')).join('');
  if (state.activeTurnId) html += '<div class="typing" aria-label="任务执行中"><span></span><span></span><span></span></div>';
  if (!state.turns.length) html += state.thread?.mode === 'chat' ? '<div class="empty-state"><h3>开始聊聊。</h3><p>直接提问、讨论想法或整理思路。<br>这条聊天使用独立目录，无需选择项目。</p></div>' : '<div class="empty-state"><h3>准备就绪。</h3><p>描述你想完成的事情，Codex 将在此工作目录中执行。</p></div>';
  box.innerHTML = html;
  for (const detail of box.querySelectorAll('details')) if (openItems.has(detail.dataset.item)) detail.open = true;
  for (const anchor of box.querySelectorAll('a')) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function renderComposer() {
  $('composer-wrap').hidden = !state.threadId;
  const externalBusy = !state.owned && state.turns.some(t => t.status === 'inProgress');
  const busy = !!state.activeTurnId || externalBusy;
  // The backend queues a send behind an in-flight handoff. Keep the button
  // stable so a handoff between pointer-down and pointer-up cannot eat a tap.
  $('send-button').disabled = state.sending || !state.connected || !device()?.online || busy || !$('message-input').value.trim();
  $('stop-button').hidden = !state.activeTurnId;
  $('release-button').hidden = !state.owned || busy || !state.turns.length;
  $('release-button').disabled = state.releasing || state.sending;
  $('release-button').textContent = state.releasing ? '正在交还…' : '交还桌面';
  const selected = state.thread?.settings || {};
  const model = selected.model || state.thread?.model;
  const effort = selected.effort || state.thread?.reasoningEffort;
  $('model-label').textContent = `${model || state.thread?.modelProvider || '本机配置'} · ${effortName(effort)}${selected.serviceTier === 'priority' ? ' · 快速' : ''}`;
  $('model-label').title = $('model-label').textContent;
  $('model-settings-button').disabled = !state.threadId || busy || state.sending || state.releasing || !device()?.online;
  $('message-input').placeholder = state.thread?.mode === 'chat' ? '聊点什么，或者直接提问…' : '告诉这台电脑，接下来做什么…';
  $('task-status').hidden = !state.threadId;
  $('task-status').textContent = !device()?.online ? '设备离线' : state.approvals.length ? '等待确认' : busy ? '执行中' : state.releasing ? '正在交还' : '就绪';
  $('task-status').classList.toggle('busy', busy || !!state.approvals.length);
  if (!state.sending) $('send-state').textContent = externalBusy ? '请在原客户端结束任务并关闭此会话' : busy ? '任务执行中，离开页面不会取消任务' : state.releasing ? '正在释放会话占用…' : '任务结束后自动交还会话 · 两端可同时使用网页';
}
function renderApprovals() {
  const signature = JSON.stringify(state.approvals);
  if (signature === approvalSignature) { renderComposer(); return; }
  approvalSignature = signature;
  $('approvals').innerHTML = state.approvals.map(a => {
    const p = a.params;
    if (a.method === 'item/tool/requestUserInput') return `<form class="approval question-form" data-id="${esc(a.id)}"><h3>Codex 需要你的回答</h3>${(p.questions || []).map(q => `<label>${esc(q.question)}${q.options?.length ? `<select data-option="${esc(q.id)}"><option value="">选择建议，或在下方输入</option>${q.options.map(o => `<option value="${esc(o.label)}">${esc(o.label)}${o.description ? ' — ' + esc(o.description) : ''}</option>`).join('')}</select>` : ''}<input data-question="${esc(q.id)}" type="${q.isSecret ? 'password' : 'text'}" required placeholder="输入你的回答" autocomplete="off"></label>`).join('')}<button type="submit" class="primary">提交回答</button></form>`;
    const permission = a.method === 'item/permissions/requestApproval';
    const details = p.command || (permission ? JSON.stringify(p.permissions, null, 2) : p.grantRoot || p.networkApprovalContext && JSON.stringify(p.networkApprovalContext) || '文件变更审批');
    return `<div class="approval"><h3>${permission ? '需要额外权限' : '需要你确认操作'}</h3><p>${esc(p.reason || '请核对以下操作后决定是否允许。')}</p><pre>${esc(details)}</pre><button class="primary" data-approval="${esc(a.id)}" data-decision="accept">允许本次</button><button data-approval="${esc(a.id)}" data-decision="decline">拒绝</button></div>`;
  }).join('');
  renderComposer();
}
async function sendMessage(event) {
  event.preventDefault(); if ($('send-button').disabled) return;
  const text = $('message-input').value.trim(); const key = selection(); const sentDraftKey = draftKey();
  state.sending = true; $('task-error').hidden = true; $('send-state').textContent = '正在发送，等待电脑确认…'; renderComposer();
  try {
    const result = await deviceApi('send', { threadId: state.threadId, text, clientId: crypto.randomUUID() });
    localStorage.removeItem(sentDraftKey);
    if (selection() === key) { $('message-input').value = ''; state.activeTurnId = result.turn.status === 'inProgress' ? result.turn.id : null; state.owned = true; await refreshThread(); }
  } catch (error) {
    if (selection() === key) { $('task-error').hidden = false; $('task-error').textContent = error.message + ' 消息保留在输入框；请先刷新会话确认是否已接收，再决定是否重新发送。'; }
    else toast(error.message);
  } finally { state.sending = false; renderComposer(); }
}
function modal(html) { $('modal-content').innerHTML = html; if (!$('modal').open) $('modal').showModal(); }
async function newThreadDialog() {
  if (!device()?.online) return toast('设备离线，请先启动目标电脑的连接程序。');
  if (!device()?.capabilities?.conversationOptions) return toast('这台电脑的连接程序需要更新到 0.2.0 后才能使用新版新建对话。');
  const version = ++optionsDialogVersion; const targetDevice = state.deviceId; optionsForm = null;
  modal(`<h2>开始新对话</h2><p>连接到 <strong>${esc(device().name)}</strong>。可以随便聊聊，也可以进入一个项目。</p><form id="new-thread-form">
    <fieldset class="mode-switch"><legend>对话类型</legend><label><input type="radio" name="conversation-mode" value="chat" checked><span><strong>普通聊天</strong><small>无需选择项目</small></span></label><label><input type="radio" name="conversation-mode" value="project"><span><strong>项目任务</strong><small>在指定目录工作</small></span></label></fieldset>
    <p id="chat-mode-hint" class="hint">系统会在这台电脑上自动分配独立聊天目录。模型权限沿用本机配置。</p>
    <div id="project-path" hidden><label for="new-cwd">目标电脑上的项目目录</label><input id="new-cwd" list="recent-projects" value="${esc(state.thread?.mode !== 'chat' && state.thread?.cwd || device().defaultCwd || '')}" placeholder="例如 E:\\projects\\my-project"><datalist id="recent-projects"></datalist></div>
    <div id="new-options" class="dialog-options"><p class="hint">正在读取这台电脑的模型选项…</p></div>
    <div class="dialog-actions"><button type="button" class="secondary" data-action="close">取消</button><button id="create-thread-button" class="primary" type="submit" disabled>开始聊天</button></div></form>`);
  try {
    const catalog = await deviceApi('models', {}, 'GET');
    if (version !== optionsDialogVersion || targetDevice !== state.deviceId || !$('modal').open || !$('new-options')) return;
    optionsForm = mountOptions($('new-options'), catalog, catalog.lastSettings || {}, {}, 'new');
    $('recent-projects').innerHTML = (catalog.recentProjects || []).map(p => `<option value="${esc(p)}"></option>`).join('');
    $('create-thread-button').disabled = false;
  } catch (error) {
    if (version !== optionsDialogVersion || !$('new-options')) return;
    $('new-options').innerHTML = `<p class="option-warning">${esc(error.message)} 可以先沿用本机配置。</p>`;
    $('create-thread-button').disabled = false;
  }
}
async function settingsDialog() {
  if (!state.threadId) return;
  if (!device()?.capabilities?.conversationOptions) return toast('请先把这台电脑的连接程序更新到 0.2.0，再选择模型和强度。');
  const version = ++optionsDialogVersion; const key = selection(); optionsForm = null;
  modal('<h2>模型与推理强度</h2><p>只修改当前会话，从下一条消息开始生效。</p><form id="settings-form"><div id="edit-options" class="dialog-options"><p class="hint">正在读取可用选项…</p></div><div class="dialog-actions"><button type="button" class="secondary" data-action="reset-settings">沿用会话配置</button><button type="button" class="secondary" data-action="close">取消</button><button id="save-settings-button" class="primary" type="submit" disabled>保存</button></div></form>');
  try {
    const catalog = await deviceApi('models', { ...(state.thread?.modelProvider ? { provider: state.thread.modelProvider } : {}), ...(state.thread?.cwd ? { cwd: state.thread.cwd } : {}) }, 'GET');
    if (version !== optionsDialogVersion || selection() !== key || !$('modal').open || !$('edit-options')) return;
    optionsForm = mountOptions($('edit-options'), catalog, state.thread?.settings || {}, state.thread || {}, 'edit');
    $('save-settings-button').disabled = false;
  } catch (error) {
    if (version !== optionsDialogVersion || selection() !== key || !$('edit-options')) return;
    $('edit-options').innerHTML = `<p class="option-warning">${esc(error.message)} 请关闭后重试，已有设置不会改变。</p>`;
  }
}
async function pairDialog() {
  modal('<h2>添加另一台电脑</h2><p>正在生成一次性配对码…</p>');
  const result = await api('/pairings', {});
  const hubUrl = result.hubUrl;
  modal(`<h2>添加另一台电脑</h2><p>把源码包解压到另一台电脑，确认 Node.js 和 Codex 可用，并登录同一个 Tailscale 网络。在解压目录执行（Windows）：</p><pre>npm.cmd ci --omit=dev\nnpm.cmd run agent -- --hub ${esc(hubUrl)} --code ${esc(result.code)} --name "我的笔记本"</pre><p>配对码有效期 10 分钟，只能使用一次。后续只需执行 <code>npm.cmd run agent</code>，不用再次配对。保持此程序运行。</p><p>新增执行电脑不需要开启 Serve。手机继续使用原来的工作台地址。仅复制代码，不要复制 <code>.relaydeck</code> 或 <code>node_modules</code> 文件夹。</p><div class="dialog-actions"><button class="primary" data-action="close">知道了</button></div>`);
}
function helpDialog() {
  modal(`<h2>让工作台随身可用</h2><p>iPhone 连接 Tailscale 后，用 Safari 打开下方地址，再选择“分享 → 添加到主屏幕”。</p><pre>${esc(state.publicUrl || location.origin)}</pre><p>统一服务和目标电脑需要保持开机。手机锁屏或断网不会主动取消已被电脑接收的任务；回到页面会重新读取状态。</p><p>电脑和手机都打开 RelayDeck 网页，可以同步查看同一对话并轮流发送。一次只执行一项任务。</p><p>原生 Codex 窗口使用独立连接。RelayDeck 在任务结束后自动释放会话，原生端可点“重试”继续；也可点击“交还桌面”。反向切回手机时，需要原生端关闭该会话，单纯停止任务不一定释放占用。不会强行抢占原生客户端。</p><p>桌面专用动态工具、MCP 交互表单与推送通知暂不支持。权限沿用本机 Codex 配置，支持的审批会在聊天界面显示。</p>${device() && !device().local ? '<button class="secondary" data-action="remove-device">移除当前远程设备</button>' : ''}<div class="dialog-actions"><button class="primary" data-action="close">知道了</button></div>`);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.device) return await chooseDevice(button.dataset.device);
    if (button.dataset.thread) return await chooseThread(button.dataset.thread);
    if (button.dataset.approval) {
      button.disabled = true;
      await deviceApi('respond', { id: button.dataset.approval, decision: button.dataset.decision });
      state.approvals = state.approvals.filter(a => a.id !== button.dataset.approval); renderApprovals(); return;
    }
    const action = button.dataset.action;
    if (action === 'devices') { $('app').classList.add('devices-open'); $('panel-overlay').hidden = false; }
    if (action === 'back') { $('app').classList.remove('view-chat'); $('app').classList.add('view-threads'); }
    if (action === 'new') await newThreadDialog();
    if (action === 'settings') await settingsDialog();
    if (action === 'reset-settings') {
      const result = await deviceApi('settings', { threadId: state.threadId, reset: true }); state.thread = result.thread;
      $('modal').close(); renderComposer(); toast('已取消网页覆盖，后续沿用会话和本机配置。');
    }
    if (action === 'refresh') { await refreshState(); await refreshThreads(); if (state.threadId) await refreshThread(); }
    if (action === 'history') { button.disabled = true; await refreshThread(true); }
    if (action === 'close') { optionsDialogVersion++; $('modal').close(); }
    if (action === 'pair') await pairDialog();
    if (action === 'help') helpDialog();
    if (action === 'remove-device') {
      if (!confirm('移除此设备并撤销连接凭据？正在执行的任务不会因此被停止。')) return;
      await api(`/devices/${state.deviceId}`, {}, 'DELETE'); $('modal').close(); await refreshState(); await chooseDevice(state.devices[0].id);
    }
    if (action === 'logout') {
      await api('/logout', {});
      for (const key of Object.keys(localStorage)) if (key.startsWith('rd-draft:')) localStorage.removeItem(key);
      showLogin();
    }
  } catch (error) { button.disabled = false; toast(error.message); }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'new-thread-form') {
    event.preventDefault(); const button = event.target.querySelector('[type=submit]'); button.disabled = true;
    const selectedDevice = state.deviceId;
    const mode = event.target.querySelector('[name=conversation-mode]:checked').value;
    try { const result = await deviceApi('create', { mode, ...(mode === 'project' ? { cwd: $('new-cwd').value } : {}), ...(optionsForm ? { settings: optionsForm.values() } : {}) }); $('modal').close(); if (selectedDevice === state.deviceId) { await refreshThreads(); await chooseThread(result.thread.id); } }
    catch (error) { toast(error.message); button.disabled = false; }
  }
  if (event.target.id === 'settings-form') {
    event.preventDefault(); if (!optionsForm) return;
    const button = $('save-settings-button'); button.disabled = true; const key = selection();
    try {
      const result = await deviceApi('settings', { threadId: state.threadId, settings: optionsForm.values() });
      if (selection() === key) state.thread = result.thread;
      $('modal').close(); renderComposer(); toast('模型设置已保存，从下一条消息开始生效。');
    } catch (error) { toast(error.message); button.disabled = false; }
  }
  if (event.target.matches('.question-form')) {
    event.preventDefault(); const form = event.target; const answers = Object.fromEntries([...form.querySelectorAll('[data-question]')].map(input => [input.dataset.question, input.value]));
    form.querySelector('button').disabled = true;
    try { await deviceApi('respond', { id: form.dataset.id, answers }); state.approvals = state.approvals.filter(a => a.id !== form.dataset.id); renderApprovals(); }
    catch (error) { toast(error.message); form.querySelector('button').disabled = false; }
  }
});
document.addEventListener('change', event => {
  if (event.target.name === 'conversation-mode') {
    const project = event.target.value === 'project'; $('project-path').hidden = !project;
    $('new-cwd').required = project; $('chat-mode-hint').hidden = project;
    $('create-thread-button').textContent = project ? '创建项目对话' : '开始聊天';
  }
  if (event.target.dataset.option) {
    const form = event.target.closest('form'); const input = [...form.querySelectorAll('[data-question]')].find(i => i.dataset.question === event.target.dataset.option);
    if (input) input.value = event.target.value;
  }
});
$('panel-overlay').onclick = () => $('app').classList.remove('devices-open');
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login-error').textContent = ''; $('login-button').disabled = true;
  try { await api('/login', { code: $('access-code').value }); await init(); } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-button').disabled = false; }
};
$('composer').onsubmit = sendMessage;
$('message-input').oninput = () => { saveDraft(); renderComposer(); };
$('message-input').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer:fine)').matches) { event.preventDefault(); $('composer').requestSubmit(); }
};
$('stop-button').onclick = async () => { $('stop-button').disabled = true; try { await deviceApi('interrupt', { threadId: state.threadId }); } catch (error) { toast(error.message); } finally { $('stop-button').disabled = false; } };
$('release-button').onclick = async () => { $('release-button').disabled = true; try { await deviceApi('release', { threadId: state.threadId }); state.owned = false; state.releasing = false; toast('会话已交还。原生 Codex 中点击“重试”即可继续。'); renderComposer(); } catch (error) { toast(error.message); $('release-button').disabled = false; } };
$('more-threads').onclick = () => refreshThreads(true);
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = $('search').value; refreshThreads(); }, 300); };
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.authenticated) { refreshState().catch(() => {}); if (state.threadId) refreshThread().catch(() => {}); }
});
window.addEventListener('online', () => { if (state.authenticated) { connectEvents(); refreshThreads(); } else init(); });
window.addEventListener('offline', () => connection(false));
// iOS keyboard changes the visual viewport, not always the layout viewport.
function resizeViewport() { if (window.visualViewport && matchMedia('(max-width:760px)').matches) document.documentElement.style.setProperty('--vh', `${window.visualViewport.height}px`); }
window.visualViewport?.addEventListener('resize', resizeViewport); resizeViewport();
setInterval(() => {
  if (!document.hidden && state.authenticated) { refreshState().catch(() => {}); if (state.threadId) refreshThread().catch(() => {}); }
}, 15000);
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
init();
