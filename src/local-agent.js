import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CodexClient } from './codex.js';
import { DATA_DIR } from './config.js';
import { ConversationOptions, validateOptions } from './conversation-options.js';

function required(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}无效`);
  return value.trim();
}
export function threadSummary(thread) {
  return { id: thread.id, name: thread.name || (thread.preview || '新会话').slice(0, 100), cwd: thread.cwd,
    model: thread.model, modelProvider: thread.modelProvider, reasoningEffort: thread.reasoningEffort || null,
    updatedAt: thread.updatedAt, status: thread.status, source: thread.source };
}
export class LocalAgent extends EventEmitter {
  constructor({ id, name, client, cwd = process.cwd(), dataDir = DATA_DIR } = {}) {
    super(); this.id = id || randomUUID(); this.name = name || os.hostname(); this.cwd = cwd;
    this.client = client || new CodexClient({ cwd }); this.connected = false; this.error = null;
    this.approvals = new Map(); this.running = new Map(); this.loaded = new Set(); this.locks = new Set();
    this.metadata = new Map(); this.liveTurns = new Map();
    this.releasing = new Map(); this.releaseTimers = new Map();
    this.dataDir = dataDir; this.options = new ConversationOptions(dataDir); this.catalogCache = new Map();
    this.generation = randomUUID();
    this.client.on('notification', message => this.notification(message));
    this.client.on('request', message => this.serverRequest(message));
    this.client.on('disconnected', event => {
      this.connected = false; this.error = event.message; this.loaded.clear(); this.running.clear(); this.approvals.clear();
      this.generation = randomUUID(); this.liveTurns.clear(); this.metadata.clear();
      this.catalogCache.clear();
      for (const timer of this.releaseTimers.values()) clearTimeout(timer);
      this.releaseTimers.clear();
      this.emit('event', { type: 'agent-state', ...this.info() });
    });
  }
  info() {
    return { id: this.id, name: this.name, platform: os.platform(), online: this.connected, error: this.error,
      version: '0.2.1', capabilities: { conversationOptions: true },
      defaultCwd: this.cwd, running: Object.fromEntries(this.running), loadedThreads: [...this.loaded], releasingThreads: [...this.releasing.keys()],
      approvals: [...this.approvals.values()].map(({ rawId, ...a }) => a) };
  }
  summarize(thread) {
    const preference = this.options.get(thread.id);
    return { ...threadSummary(thread), mode: preference?.mode || 'project', settings: preference?.settings || {} };
  }
  async catalog({ provider, cwd } = {}) {
    if (provider != null && (typeof provider !== 'string' || provider.length > 100)) throw new Error('模型服务名称无效');
    if (cwd != null && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) throw new Error('配置目录必须是目标电脑上的有效绝对目录');
    const key = JSON.stringify([provider || '', cwd || '']); const cached = this.catalogCache.get(key);
    if (cached && cached.expires > Date.now()) return { ...cached.value, recentProjects: this.options.data.recentProjects, lastSettings: this.options.data.lastSettings };
    let config = {}; const warnings = [];
    try { config = (await this.client.request('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) })).config || {}; }
    catch { warnings.push('无法读取本机默认配置，仍可手动填写模型名称。'); }
    const defaults = { model: config.model || null, provider: provider || config.model_provider || null,
      effort: config.model_reasoning_effort || null, serviceTier: config.service_tier || null };
    let models = []; let cursor;
    try {
      do {
        const page = await this.client.request('model/list', { limit: 100, includeHidden: false,
          ...(defaults.provider ? { modelProvider: defaults.provider } : {}), ...(cursor ? { cursor } : {}) });
        models.push(...(page.data || []).map(m => ({ model: m.model, name: m.displayName || m.model, description: m.description || '',
          efforts: (m.supportedReasoningEfforts || []).map(e => ({ value: e.reasoningEffort, description: e.description || '' })),
          defaultReasoningEffort: m.defaultReasoningEffort || null,
          serviceTiers: (m.serviceTiers || []).map(t => ({ id: t.id, name: t.name, description: t.description || '' })) })));
        cursor = page.nextCursor;
      } while (cursor && models.length < 1000);
    } catch { warnings.push('此 Codex 版本或服务未返回完整模型列表，可手动输入模型 ID；可用性由模型服务决定。'); }
    const value = { defaults, models, warnings, recentProjects: this.options.data.recentProjects, lastSettings: this.options.data.lastSettings };
    this.catalogCache.set(key, { value, expires: Date.now() + 60000 });
    while (this.catalogCache.size > 50) this.catalogCache.delete(this.catalogCache.keys().next().value);
    return value;
  }
  async start() {
    if (this.connected) return;
    try {
      await this.client.start(); this.connected = true; this.error = null;
      this.emit('event', { type: 'agent-state', ...this.info() });
    } catch (error) { this.connected = false; this.error = error.message; throw error; }
  }
  notification({ method, params = {} }) {
    const threadId = params.threadId;
    const turnId = params.turnId || params.turn?.id;
    if (threadId && turnId) {
      if (!this.liveTurns.has(threadId)) this.liveTurns.set(threadId, new Map());
      const turns = this.liveTurns.get(threadId);
      if (!turns.has(turnId)) turns.set(turnId, { id: turnId, status: 'inProgress', items: [] });
      const turn = turns.get(turnId);
      if (method === 'turn/started') Object.assign(turn, { ...params.turn, items: turn.items });
      if (method === 'turn/completed') Object.assign(turn, { ...params.turn, items: params.turn.items?.length ? params.turn.items : turn.items });
      if (method === 'item/started' || method === 'item/completed') {
        const index = turn.items.findIndex(i => i.id === params.item.id);
        if (index < 0) turn.items.push(params.item); else turn.items[index] = { ...turn.items[index], ...params.item };
      }
      if (method === 'item/agentMessage/delta') {
        let item = turn.items.find(i => i.id === params.itemId);
        if (!item) { item = { id: params.itemId, type: 'agentMessage', text: '' }; turn.items.push(item); }
        item.text += params.delta;
      }
      if (method === 'item/commandExecution/outputDelta') {
        const item = turn.items.find(i => i.id === params.itemId);
        if (item) item.aggregatedOutput = ((item.aggregatedOutput || '') + params.delta).slice(-80000);
      }
      while (turns.size > 10) turns.delete(turns.keys().next().value);
    }
    if (method === 'turn/started') this.running.set(params.threadId, params.turn.id);
    if (method === 'turn/completed') {
      this.running.delete(params.threadId);
      for (const [id, request] of this.approvals) if (request.params.threadId === params.threadId) this.approvals.delete(id);
      this.scheduleRelease(params.threadId);
    }
    if (method === 'thread/closed') {
      this.forgetThread(params.threadId);
    }
    if (method === 'serverRequest/resolved') {
      for (const [id, request] of this.approvals) if (String(request.rawId) === String(params.requestId)) this.approvals.delete(id);
    }
    // Forward task events only; account/configuration notifications never leave the computer.
    if (/^(thread\/|turn\/|item\/|serverRequest\/|error$)/.test(method)) this.emit('event', { type: 'codex', method, params });
  }
  forgetThread(threadId) {
    this.loaded.delete(threadId); this.running.delete(threadId);
    this.metadata.delete(threadId); this.liveTurns.delete(threadId);
  }
  scheduleRelease(threadId) {
    clearTimeout(this.releaseTimers.get(threadId));
    const timer = setTimeout(() => {
      this.releaseTimers.delete(threadId);
      if (!this.loaded.has(threadId) || this.running.has(threadId)) return;
      if (this.locks.has(threadId)) { this.scheduleRelease(threadId); return; }
      this.releaseThread(threadId).catch(error => this.emit('event', { type: 'notice', threadId,
        message: `自动交还会话尚未完成：${error.message} 可点击“交还桌面”重试。` }));
    }, 150);
    timer.unref?.(); this.releaseTimers.set(threadId, timer);
  }
  async releaseThread(threadId) {
    if (this.releasing.has(threadId)) return this.releasing.get(threadId);
    if (this.running.has(threadId) || this.locks.has(threadId) || [...this.approvals.values()].some(a => a.params.threadId === threadId)) {
      throw new Error('任务仍在执行或等待确认。请先完成任务，或点击“停止”并等待结束后再交还。');
    }
    if (!this.loaded.has(threadId)) return { released: true };
    clearTimeout(this.releaseTimers.get(threadId)); this.releaseTimers.delete(threadId);
    const operation = (async () => {
      this.emit('event', { type: 'ownership', threadId, owned: true, releasing: true });
      const response = await this.client.request('thread/unsubscribe', { threadId });
      if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(response.status)) throw new Error('Codex 返回了未知的退订状态');
      // Do not report a handoff until the engine has actually dropped the writer.
      const deadline = Date.now() + 10000;
      while (response.status !== 'notLoaded' && this.loaded.has(threadId)) {
        const loaded = await this.client.request('thread/loaded/list', {});
        if (!loaded.data.includes(threadId)) break;
        if (Date.now() >= deadline) throw new Error('Codex 仍在等待会话卸载，请稍后重试');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      this.forgetThread(threadId);
      this.emit('event', { type: 'ownership', threadId, owned: false, releasing: false });
      return { released: true };
    })().catch(error => {
      this.emit('event', { type: 'ownership', threadId, owned: this.loaded.has(threadId), releasing: false });
      throw error;
    }).finally(() => this.releasing.delete(threadId));
    this.releasing.set(threadId, operation);
    return operation;
  }
  serverRequest(message) {
    const { method, params, id: rawId } = message;
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval'];
    if (supported.includes(method)) {
      const id = `${this.generation}:${rawId}`;
      const approval = { id, rawId, method, params, createdAt: Date.now() };
      this.approvals.set(id, approval);
      this.emit('event', { type: 'approval', approval: { id, method, params, createdAt: approval.createdAt } });
    } else if (method === 'item/tool/call') {
      this.client.respond(rawId, { success: false, contentItems: [{ type: 'inputText', text: 'RelayDeck does not implement desktop host dynamic tools. Use available native Codex shell and file tools instead, or ask the user to return to the desktop application for this tool.' }] });
      this.emit('event', { type: 'notice', threadId: params.threadId, message: `桌面专用工具 ${params.tool || ''} 暂不支持远程执行；Codex 已收到明确的失败结果。` });
    } else if (method === 'mcpServer/elicitation/request') {
      this.client.respond(rawId, { action: 'decline', content: null, _meta: null });
      this.emit('event', { type: 'notice', threadId: params.threadId, message: '此 MCP 表单暂不支持，已拒绝；请在桌面端完成该操作。' });
    } else this.client.reject(rawId, `RelayDeck does not support ${method}; use the original Codex client.`);
  }
  async history(threadId, cursor) {
    const mergeLive = page => {
      if (cursor) return page;
      for (const live of this.liveTurns.get(threadId)?.values() || []) {
        const index = page.turns.findIndex(t => t.id === live.id);
        if (index < 0) page.turns.push(live);
        else page.turns[index] = { ...page.turns[index], ...live, items: live.items.length ? live.items : page.turns[index].items };
      }
      return page;
    };
    try {
      const page = await this.client.request('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      return mergeLive({ turns: [...page.data].reverse(), nextCursor: page.nextCursor });
    } catch (error) {
      if (this.loaded.has(threadId) && /rollout.*(?:empty|not found)|not materialized|no rollout/i.test(error.message)) return mergeLive({ turns: [], nextCursor: null });
      if (error.code !== -32601 && !/unsupported|unknown variant|not supported/i.test(error.message)) throw error;
      const read = await this.client.request('thread/read', { threadId, includeTurns: true });
      return mergeLive({ turns: read.thread.turns || [], nextCursor: null });
    }
  }
  async handle(action, params = {}) {
    if (action === 'info') return this.info();
    await this.start();
    if (action === 'models') return this.catalog(params);
    if (action === 'threads') {
      const result = await this.client.request('thread/list', { limit: 30, modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], sortKey: 'updated_at',
        ...(params.cursor ? { cursor: required(params.cursor, '游标', 4000) } : {}),
        ...(params.search ? { searchTerm: required(params.search, '搜索词', 200) } : {}) });
      return { threads: result.data.map(thread => this.summarize(thread)), nextCursor: result.nextCursor };
    }
    if (action === 'thread') {
      const threadId = required(params.threadId, '会话');
      const readMetadata = this.client.request('thread/read', { threadId }).catch(error => {
        if (this.metadata.has(threadId) && /rollout.*(?:empty|not found)|not materialized|no rollout/i.test(error.message)) return { thread: this.metadata.get(threadId) };
        throw error;
      });
      const [read, page] = await Promise.all([readMetadata, this.history(threadId, params.cursor)]);
      return { thread: this.summarize(read.thread), ...page, owned: this.loaded.has(threadId), releasing: this.releasing.has(threadId), activeTurnId: this.running.get(threadId) || null,
        approvals: this.info().approvals.filter(a => a.params.threadId === threadId) };
    }
    if (action === 'create') {
      const mode = params.mode || (params.cwd ? 'project' : 'chat');
      if (!['chat', 'project'].includes(mode)) throw new Error('请选择普通聊天或项目任务');
      const cwd = mode === 'chat' ? path.join(this.dataDir, 'chats', randomUUID()) : required(params.cwd, '工作目录', 4000);
      if (mode === 'chat') fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录必须是目标电脑上已经存在的绝对目录。');
      const catalog = params.settings ? await this.catalog({ cwd }) : null;
      const settings = catalog ? validateOptions(params.settings, catalog) : {};
      // Model choices are scoped to this conversation; provider credentials and permissions stay local.
      const result = await this.client.request('thread/start', { cwd,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
        ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}) });
      this.loaded.add(result.thread.id);
      this.metadata.set(result.thread.id, result.thread);
      this.options.set(result.thread.id, { mode, cwd, settings });
      return { thread: this.summarize(result.thread) };
    }
    if (action === 'settings') {
      const threadId = required(params.threadId, '会话');
      if (this.running.has(threadId) || this.locks.has(threadId)) throw new Error('请等待当前任务结束后再修改模型设置。');
      const read = this.metadata.has(threadId) ? { thread: this.metadata.get(threadId) } : await this.client.request('thread/read', { threadId });
      const catalog = await this.catalog({ provider: read.thread.modelProvider, cwd: read.thread.cwd });
      const settings = params.reset === true ? {} : validateOptions(params.settings, catalog, read.thread.model);
      if (this.running.has(threadId) || this.locks.has(threadId)) throw new Error('任务已开始，请等待完成后修改设置。');
      this.options.set(threadId, { settings });
      const thread = this.summarize(read.thread);
      this.emit('event', { type: 'settings-changed', threadId, settings });
      return { thread, settings };
    }
    if (action === 'send') {
      const threadId = required(params.threadId, '会话');
      const text = required(params.text, '消息', 64000);
      const clientId = required(params.clientId, '消息标识', 100);
      if (this.releasing.has(threadId)) await this.releasing.get(threadId);
      clearTimeout(this.releaseTimers.get(threadId)); this.releaseTimers.delete(threadId);
      if (this.locks.has(threadId) || this.running.has(threadId)) throw new Error('此会话正在执行任务，请等待完成或停止后再发送。');
      this.locks.add(threadId);
      try {
        if (!this.loaded.has(threadId)) {
          const recent = await this.history(threadId);
          if (recent.turns.some(t => t.status === 'inProgress')) throw new Error('此会话记录显示仍有任务执行中。请先在原客户端结束任务并关闭该会话，再从手机继续。电脑和手机也可以同时使用 RelayDeck 网页。');
          const resumed = await this.client.request('thread/resume', { threadId, excludeTurns: true });
          this.metadata.set(threadId, resumed.thread);
          this.loaded.add(threadId);
        }
        const settings = this.options.get(threadId)?.settings || {};
        const result = await this.client.request('turn/start', { threadId, clientUserMessageId: clientId,
          input: [{ type: 'text', text, text_elements: [] }], ...settings });
        const liveStatus = this.liveTurns.get(threadId)?.get(result.turn.id)?.status;
        if (result.turn.status === 'inProgress' && !['completed', 'interrupted', 'failed'].includes(liveStatus)) this.running.set(threadId, result.turn.id);
        if (!this.running.has(threadId)) this.scheduleRelease(threadId);
        return { turn: result.turn };
      } catch (error) {
        if (!this.running.has(threadId) && error.code !== 'UNKNOWN_OUTCOME') this.scheduleRelease(threadId);
        if (/active writer|already.*another app|thread.*in use/i.test(error.message)) {
          const conflict = new Error('该会话仍被原生 Codex 窗口占用。请在原生端关闭这条会话，再从手机重试；或者电脑和手机都使用 RelayDeck 网页，共享同一连接。');
          conflict.status = 409; throw conflict;
        }
        throw error;
      } finally { this.locks.delete(threadId); }
    }
    if (action === 'release') return this.releaseThread(required(params.threadId, '会话'));
    if (action === 'interrupt') {
      const threadId = required(params.threadId, '会话');
      const turnId = this.running.get(threadId);
      if (!turnId) throw new Error('没有由此连接执行中的任务。无法停止其他客户端的任务。');
      await this.client.request('turn/interrupt', { threadId, turnId });
      return { ok: true };
    }
    if (action === 'respond') {
      const approval = this.approvals.get(required(params.id, '审批标识', 200));
      if (!approval) throw new Error('该请求已处理或已过期，请刷新会话。');
      let result;
      if (approval.method === 'item/tool/requestUserInput') {
        const answers = {};
        for (const question of approval.params.questions || []) {
          const answer = params.answers?.[question.id];
          answers[question.id] = { answers: [required(answer, '回答', 10000)] };
        }
        result = { answers };
      } else if (approval.method === 'item/permissions/requestApproval') {
        if (!['accept', 'decline'].includes(params.decision)) throw new Error('无效的审批决定');
        result = { permissions: params.decision === 'accept' ? approval.params.permissions : {}, scope: 'turn' };
      } else {
        if (!['accept', 'decline', 'cancel'].includes(params.decision)) throw new Error('无效的审批决定');
        const available = approval.params.availableDecisions;
        const decision = params.decision === 'decline' && available && !available.includes('decline') && available.includes('cancel') ? 'cancel' : params.decision;
        if (available && !available.includes(decision)) throw new Error('Codex 不接受此审批选项。');
        result = { decision };
      }
      this.client.respond(approval.rawId, result); this.approvals.delete(approval.id);
      this.emit('event', { type: 'approval-resolved', id: approval.id });
      return { ok: true };
    }
    throw new Error('不支持的操作');
  }
  stop() { for (const timer of this.releaseTimers.values()) clearTimeout(timer); this.releaseTimers.clear(); this.client.stop(); }
}
