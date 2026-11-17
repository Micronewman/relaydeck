import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function tailscaleBin() {
  const windows = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  return process.platform === 'win32' && fs.existsSync(windows) ? windows : 'tailscale';
}
export async function tailscaleInfo() {
  try {
    const { stdout } = await exec(tailscaleBin(), ['status', '--json'], { windowsHide: true, timeout: 10000 });
    const data = JSON.parse(stdout);
    return { running: data.BackendState === 'Running', url: data.Self?.DNSName ? `https://${data.Self.DNSName.replace(/\.$/, '')}` : null,
      ip: data.TailscaleIPs?.find(ip => !ip.includes(':')) || null, httpsConfigured: !!data.CertDomains?.length };
  } catch { return { running: false, url: null }; }
}
