import { loadConfig } from '../src/config.js';
const config = loadConfig(); const base = `http://127.0.0.1:${config.port}`;
try {
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: config.accessCode }) });
  if (!login.ok) throw new Error('登录失败');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  console.log(`在另一台电脑的项目目录执行（10 分钟内有效）：\n\nnpm run agent -- --hub ${result.hubUrl} --code ${result.code} --name "我的笔记本"\n\n后续启动只需 npm run agent`);
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
} catch (error) { console.error(`无法生成配对码：${error.message}。请先启动统一服务。`); process.exitCode = 1; }
