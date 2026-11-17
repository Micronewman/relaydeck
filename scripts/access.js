import { loadConfig, DATA_DIR } from '../src/config.js';
const config = loadConfig();
console.log(`\nRelayDeck 访问码：\n\n${config.accessCode}\n\n请仅在自己的手机上输入。凭据存储位置：${DATA_DIR}\n`);
