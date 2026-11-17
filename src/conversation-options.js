import path from 'node:path';
import { readJson, writeJson } from './config.js';

export class ConversationOptions {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'conversation-options.json');
    const stored = readJson(this.file, {});
    const threads = stored.threads || {};
    const previous = [...Object.values(threads)].reverse().find(entry => entry.settings?.model)?.settings || {};
    this.data = { version: 2, threads, recentProjects: stored.recentProjects || [], lastSettings: stored.lastSettings?.model ? stored.lastSettings : { ...previous } };
  }
  get(id) { return this.data.threads[id] || null; }
  set(id, entry) {
    this.data.threads[id] = { ...this.get(id), ...entry };
    // Remember explicit model choices without letting a per-thread reset erase them.
    if (entry.settings?.model) this.data.lastSettings = { ...entry.settings };
    if (entry.mode === 'project' && entry.cwd) {
      this.data.recentProjects = [entry.cwd, ...this.data.recentProjects.filter(p => p !== entry.cwd)].slice(0, 12);
    }
    writeJson(this.file, this.data);
    return this.data.threads[id];
  }
}

function optionString(value, label, max) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}无效`);
  return value.trim();
}
export function validateOptions(input, catalog, currentModel) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('模型设置无效');
  const model = optionString(input.model, '模型名称', 200);
  let effort = optionString(input.effort, '推理强度', 50);
  const serviceTier = optionString(input.serviceTier, '速度选项', 60);
  const descriptor = catalog.models.find(m => m.model === (model || currentModel || catalog.defaults.model));
  if (model && !effort && descriptor?.defaultReasoningEffort) effort = descriptor.defaultReasoningEffort;
  if (effort && !/^[a-z][a-z0-9_-]*$/.test(effort)) throw new Error('推理强度格式无效');
  if (effort && descriptor?.efforts.length && !descriptor.efforts.some(e => e.value === effort)) throw new Error(`所选模型不支持 ${effort} 推理强度，请选择它支持的选项。`);
  if (serviceTier && !/^[a-z][a-z0-9_-]*$/.test(serviceTier)) throw new Error('速度选项格式无效');
  if (serviceTier && serviceTier !== 'default' && descriptor && !descriptor.serviceTiers.some(t => t.id === serviceTier)) throw new Error('所选模型没有提供该速度选项。');
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(serviceTier ? { serviceTier } : {}) };
}
