const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const effortName = value => ({ none: '无额外推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: 'Ultra' }[value] || value || '默认');
const manual = '__relaydeck_manual__';

export function mountOptions(container, catalog, initial = {}, current = {}, prefix = 'options') {
  const id = name => `${prefix}-${name}`;
  const field = name => container.querySelector(`#${id(name)}`);
  const models = catalog.models || [];
  const baseModel = current.model || catalog.defaults?.model || '';
  container.innerHTML = `<div class="options-grid">
    <div class="option-field"><label for="${id('model')}">模型</label><select id="${id('model')}"><option value="">沿用当前配置${baseModel ? ' · ' + esc(baseModel) : ''}</option>${models.map(m => `<option value="${esc(m.model)}">${esc(m.name)}${m.name === m.model ? '' : ' · ' + esc(m.model)}</option>`).join('')}<option value="${manual}">手动输入模型 ID…</option></select></div>
    <div class="option-field" id="${id('custom-model-wrap')}" hidden><label for="${id('custom-model')}">自定义模型 ID</label><input id="${id('custom-model')}" maxlength="200" placeholder="填写 custom 服务实际支持的模型 ID" autocomplete="off"></div>
    <div class="option-field"><label for="${id('effort')}">推理强度</label><select id="${id('effort')}"></select></div>
    <div class="option-field" id="${id('custom-effort-wrap')}" hidden><label for="${id('custom-effort')}">自定义强度值</label><input id="${id('custom-effort')}" maxlength="50" placeholder="例如 high" autocomplete="off" pattern="[a-z][a-z0-9_-]*"></div>
  </div>
  <p class="option-description" id="${id('description')}"></p>
  <details class="advanced-options"><summary>更多选项</summary><label for="${id('tier')}">速度档位</label><select id="${id('tier')}"></select><p class="hint">速度档位以模型服务支持情况为准；快速档位可能增加用量。</p></details>
  <p class="hint option-provider">模型服务：${esc(catalog.defaults?.provider || '目标电脑配置')} · 设置仅影响这条会话</p>
  ${(catalog.warnings || []).map(w => `<p class="option-warning">${esc(w)}</p>`).join('')}
  <p class="hint">列表来自目标电脑的 Codex。使用 custom 服务时，实际支持的模型和参数仍以该服务为准。</p>`;
  if (initial.model && !models.some(m => m.model === initial.model)) { field('model').value = manual; field('custom-model').value = initial.model; }
  else field('model').value = initial.model || '';
  const selectedModel = () => field('model').value === manual ? field('custom-model').value.trim() : field('model').value;
  const descriptor = () => models.find(m => m.model === (selectedModel() || baseModel));
  function refreshChoices(effort = '', tier = '') {
    const model = descriptor(); const union = [...new Set(models.flatMap(m => m.efforts.map(e => e.value)))];
    const efforts = model ? model.efforts.map(e => e.value) : union;
    const defaultLabel = selectedModel() && model?.defaultReasoningEffort ? `模型默认 · ${effortName(model.defaultReasoningEffort)}` : `沿用当前配置${current.reasoningEffort || catalog.defaults?.effort ? ' · ' + effortName(current.reasoningEffort || catalog.defaults.effort) : ''}`;
    field('effort').innerHTML = `<option value="">${esc(defaultLabel)}</option>${efforts.map(e => `<option value="${esc(e)}">${esc(effortName(e))} (${esc(e)})</option>`).join('')}${!model ? `<option value="${manual}">手动输入强度…</option>` : ''}`;
    if (effort && !efforts.includes(effort) && !model) { field('effort').value = manual; field('custom-effort').value = effort; }
    else field('effort').value = efforts.includes(effort) ? effort : '';
    const tiers = model?.serviceTiers || [...new Map(models.flatMap(m => m.serviceTiers).map(t => [t.id, t])).values()];
    field('tier').innerHTML = `<option value="">沿用当前配置</option><option value="default">标准 (default)</option>${tiers.filter(t => t.id !== 'default').map(t => `<option value="${esc(t.id)}">${esc(t.id === 'priority' ? '快速' : t.name)} (${esc(t.id)})</option>`).join('')}`;
    field('tier').value = tier === 'default' || tiers.some(t => t.id === tier) ? tier : '';
    refreshVisibility(); refreshDescription();
  }
  function refreshVisibility() {
    const customModel = field('model').value === manual; const customEffort = field('effort').value === manual;
    field('custom-model-wrap').hidden = !customModel; field('custom-model').required = customModel;
    field('custom-effort-wrap').hidden = !customEffort; field('custom-effort').required = customEffort;
  }
  function refreshDescription() {
    const model = descriptor(); const e = field('effort').value;
    field('description').textContent = model?.efforts.find(option => option.value === e)?.description || model?.description || (field('model').value === manual ? '将按填写的 ID 请求你的模型服务；不会修改电脑的全局 Codex 配置。' : '保留目标会话或电脑配置，也可以为这条对话单独选择。');
  }
  field('model').addEventListener('change', () => refreshChoices());
  field('custom-model').addEventListener('change', () => refreshChoices(field('effort').value === manual ? field('custom-effort').value : field('effort').value, field('tier').value));
  field('effort').addEventListener('change', () => { refreshVisibility(); refreshDescription(); });
  refreshChoices(initial.effort || '', initial.serviceTier || '');
  return { values() {
    const effort = field('effort').value === manual ? field('custom-effort').value.trim() : field('effort').value;
    const model = selectedModel(); const serviceTier = field('tier').value;
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(serviceTier ? { serviceTier } : {}) };
  } };
}
