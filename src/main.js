import { createHub } from './hub.js';
import { tailscaleInfo } from './tailscale.js';
import { DATA_DIR } from './config.js';
const ts = await tailscaleInfo();
const hub = createHub({ publicUrl: process.env.RELAYDECK_PUBLIC_URL || ts.url || '' });
try {
  const address = await hub.listen(Number(process.env.PORT || hub.config.port));
  console.log(`RelayDeck 已启动: http://localhost:${address.port}`);
  console.log(`访问码保存在 ${DATA_DIR}，运行 npm run access 查看。`);
  if (ts.url) console.log(`Tailscale 地址（需要先开启 Serve）: ${ts.url}`);
} catch (error) { console.error(`启动失败: ${error.message}`); await hub.close(); process.exit(1); }
async function shutdown() { await hub.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
