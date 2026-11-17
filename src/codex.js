import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { codexCommand } from './config.js';

export class CodexClient extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.pending = new Map(); this.seq = 0;
    this.child = null; this.ready = null; this.stderr = ''; this.stopping = false;
  }
  async start() {
    if (this.ready) return this.ready;
    this.stopping = false;
    this.ready = this.initialize().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async initialize() {
    const command = codexCommand(this.options.args || ['app-server', '-c', 'thread_unload_delay_secs=0', '--listen', 'stdio://'], this.options.bin);
    // No shell interpolation: neither prompts nor paths become shell commands.
    const child = spawn(command.bin, command.args, {
      cwd: this.options.cwd || process.cwd(), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.options.env }
    });
    this.child = child;
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method) {
        this.emit(msg.id !== undefined ? 'request' : 'notification', msg);
      } else {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id); clearTimeout(pending.timer);
        if (msg.error) {
          const error = new Error(msg.error.message || 'Codex 请求失败');
          error.code = msg.error.code; error.data = msg.error.data; pending.reject(error);
        } else pending.resolve(msg.result);
      }
    });
    child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-8000); });
    const fail = error => {
      if (this.child !== child) return;
      this.child = null; this.ready = null;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); this.emit('disconnected', { message: error.message });
    };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Codex 连接已结束（${code ?? 'signal'}），重新连接后请先确认任务状态。`)));
    const result = await this.request('initialize', {
      clientInfo: { name: 'relaydeck', title: 'RelayDeck', version: '0.2.1' },
      capabilities: { experimentalApi: true }
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }
  send(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex 未连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 90000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error('Codex 请求超时；执行状态可能未知，请刷新会话后确认。');
        error.code = 'UNKNOWN_OUTCOME'; reject(error);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) { this.send({ id, result }); }
  reject(id, message) { this.send({ id, error: { code: -32601, message } }); }
  stop() { this.stopping = true; this.child?.stdin.end(); this.child?.kill(); }
}
