import { execFileSync } from 'node:child_process';
import { CodexClient } from '../src/codex.js';
import { codexCommand, loadConfig } from '../src/config.js';
import { tailscaleInfo } from '../src/tailscale.js';
console.log(`Node.js: ${process.version}`);
const ts = await tailscaleInfo(); console.log(`Tailscale: ${ts.running ? '已连接' : '未连接或未安装'}`);
if (ts.url) console.log(`预期访问地址: ${ts.url}`);
const config = loadConfig();
try { const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) }); console.log(`RelayDeck 服务: ${r.ok ? '正在运行' : '响应异常'}`); } catch { console.log('RelayDeck 服务: 尚未启动'); }
const client = new CodexClient();
client.on('request', msg => client.reject(msg.id, 'Diagnostics are read-only'));
try {
  const command = codexCommand(['--version']);
  console.log(`Codex: ${execFileSync(command.bin, command.args, { encoding: 'utf8', windowsHide: true }).trim()}`);
  await client.start();
  const result = await client.request('thread/list', { limit: 1, modelProviders: [], sourceKinds: ['cli','vscode','appServer','exec','unknown'] });
  console.log(`App Server: 握手及会话读取成功${result.data[0] ? `，最近会话 provider=${result.data[0].modelProvider}` : '，尚无会话'}`);
} catch (error) { console.error(`Codex 接入失败: ${error.message}`); process.exitCode = 1; }
finally { client.stop(); }
