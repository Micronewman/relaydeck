import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.RELAYDECK_DATA_DIR || path.join(ROOT, '.relaydeck');
export const token = () => randomBytes(24).toString('base64url');
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export function equal(a, b) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function loadConfig(dir = DATA_DIR) {
  const file = path.join(dir, 'config.json');
  let config = readJson(file, null);
  if (!config) {
    config = { version: 1, deviceId: randomUUID(), deviceName: os.hostname(), accessCode: token(), port: 3030, host: '127.0.0.1', agents: [], pairings: [] };
    writeJson(file, config);
  }
  return config;
}
export function saveConfig(config, dir = DATA_DIR) { writeJson(path.join(dir, 'config.json'), config); }
export function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  const appDir = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  if (process.platform === 'win32' && fs.existsSync(appDir)) {
    const found = fs.readdirSync(appDir).map(dir => path.join(appDir, dir, 'codex.exe')).filter(file => fs.existsSync(file));
    found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found[0]) return found[0];
  }
  throw new Error('找不到 Codex。请安装 Codex CLI，或设置 CODEX_BIN 为 codex 可执行文件的完整路径。');
}
export function codexCommand(args = [], supplied) {
  let bin = supplied || findCodex();
  if (/\.(cmd|bat)$/i.test(bin)) {
    // npm's Windows shim is not directly executable by spawn without a shell.
    // Run its known official JS entrypoint instead of interpolating a command.
    const script = path.join(path.dirname(bin), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!fs.existsSync(script)) throw new Error('无法直接运行此 Codex 命令包装器。请将 CODEX_BIN 设置为 codex.exe 或 @openai/codex/bin/codex.js 的完整路径。');
    bin = script;
  }
  return /\.[cm]?js$/i.test(bin) ? { bin: process.execPath, args: [bin, ...args] } : { bin, args };
}
