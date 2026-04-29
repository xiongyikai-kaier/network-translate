const PROVIDER_PRESETS = {
  openai:       { protocol: "openai",    baseUrl: "https://api.openai.com/v1",            model: "gpt-4o-mini" },
  anthropic:    { protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1",         model: "claude-haiku-4-5" },
  deepseek:     { protocol: "openai",    baseUrl: "https://api.deepseek.com/v1",          model: "deepseek-v4-flash" },
  moonshot:     { protocol: "openai",    baseUrl: "https://api.moonshot.cn/v1",           model: "moonshot-v1-8k" },
  zhipu:        { protocol: "openai",    baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  siliconflow:  { protocol: "openai",    baseUrl: "https://api.siliconflow.cn/v1",        model: "Qwen/Qwen2.5-7B-Instruct" },
  openrouter:   { protocol: "openai",    baseUrl: "https://openrouter.ai/api/v1",         model: "openai/gpt-4o-mini" },
  custom:       { protocol: "openai",    baseUrl: "",                                     model: "" }
};

const DEFAULTS = {
  provider: "openai",
  apiProtocol: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  targetLang: "中文（简体）",
  sourceLang: "auto",
  displayMode: "bilingual",
  systemPrompt:
    "你是一个专业的翻译引擎。请将用户提供的文本翻译成{targetLang}，保持原意、语气与排版。仅输出译文，不要解释、不要加引号。如果输入是 JSON 数组，请输出同长度的 JSON 数组（每项是对应译文字符串），除此之外不要输出任何内容。",
  temperature: 0.2,
  maxTokens: 4096,
  anthropicVersion: "2023-06-01",
  batchSize: 20,
  maxCharsPerBatch: 3000,
  concurrency: 3,
  showFab: true,
  autoTranslateAllowlist: [],
  viewportFirst: true,
  maxCacheEntries: 5000,
  cacheExpireHours: 72,
  inlineSelection: true,
  hideToast: false,
  maxHistoryEntries: 200,
  historyEnabled: true,
  activeModelId: null
};

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("provider").value = s.provider;
  $("apiProtocol").value = s.apiProtocol || "openai";
  $("baseUrl").value = s.baseUrl;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("temperature").value = s.temperature;
  $("maxTokens").value = s.maxTokens;
  $("targetLang").value = s.targetLang;
  $("sourceLang").value = s.sourceLang;
  $("displayMode").value = s.displayMode;
  $("systemPrompt").value = s.systemPrompt;
  $("batchSize").value = s.batchSize;
  $("maxCharsPerBatch").value = s.maxCharsPerBatch;
  $("concurrency").value = s.concurrency;
  $("showFab").checked = s.showFab !== false;
  $("viewportFirst").checked = s.viewportFirst !== false;
  $("autoTranslateAllowlist").value = (s.autoTranslateAllowlist || []).join("\n");
  $("maxCacheEntries").value = s.maxCacheEntries;
  $("cacheExpireHours").value = s.cacheExpireHours || 72;
  $("inlineSelection").checked = s.inlineSelection !== false;
  $("hideToast").checked = !!s.hideToast;
  $("historyEnabled").checked = s.historyEnabled !== false;
  $("maxHistoryEntries").value = s.maxHistoryEntries || 200;
  toggleProtocolFields();
}

function collect() {
  return {
    provider: $("provider").value,
    apiProtocol: $("apiProtocol").value,
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    temperature: Number($("temperature").value) || 0.2,
    maxTokens: Math.max(64, Number($("maxTokens").value) || 4096),
    targetLang: $("targetLang").value.trim() || "中文（简体）",
    sourceLang: $("sourceLang").value,
    displayMode: $("displayMode").value,
    systemPrompt: $("systemPrompt").value,
    batchSize: Math.max(1, Number($("batchSize").value) || 20),
    maxCharsPerBatch: Math.max(200, Number($("maxCharsPerBatch").value) || 3000),
    concurrency: Math.max(1, Number($("concurrency").value) || 3),
    showFab: $("showFab").checked,
    viewportFirst: $("viewportFirst").checked,
    autoTranslateAllowlist: $("autoTranslateAllowlist").value
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxCacheEntries: Math.max(100, Number($("maxCacheEntries").value) || 5000),
    cacheExpireHours: Math.max(1, Number($("cacheExpireHours").value) || 72),
    inlineSelection: $("inlineSelection").checked,
    hideToast: $("hideToast").checked,
    historyEnabled: $("historyEnabled").checked,
    maxHistoryEntries: Math.max(10, Number($("maxHistoryEntries").value) || 200)
  };
}

function toggleProtocolFields() {
  const isAnthropic = $("apiProtocol").value === "anthropic";
  const row = document.getElementById("max-tokens-row");
  if (row) row.style.display = isAnthropic ? "" : "none";
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
}

async function save() {
  const data = collect();
  await chrome.storage.sync.set(data);
  setStatus("已保存 ✓", "ok");
  setTimeout(() => setStatus(""), 1800);
}

async function testConnection() {
  const data = collect();
  if (!data.apiKey) { setStatus("请先填写 API Key", "err"); return; }
  if (!data.baseUrl) { setStatus("请先填写 Base URL", "err"); return; }
  setStatus("测试中…");
  try {
    await chrome.storage.sync.set(data);
    const resp = await chrome.runtime.sendMessage({
      type: "LLM_TRANSLATE",
      payload: { texts: "Hello, world!", targetLang: data.targetLang, skipCache: true }
    });
    if (!resp?.ok) throw new Error(resp?.error || "未知错误");
    setStatus(`OK，测试译文：${String(resp.result).slice(0, 60)}`, "ok");
  } catch (err) {
    setStatus(`失败：${err?.message || err}`, "err");
  }
}

async function refreshCacheStats() {
  const el = $("cacheStats");
  if (!el) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "CACHE_STATS" });
    const s = resp?.stats || { count: 0, chars: 0, max: 0 };
    const kb = (s.chars / 1024).toFixed(1);
    const max = $("maxCacheEntries").value || s.max;
    el.textContent = `共 ${s.count} / ${max} 条 · 约 ${kb} KB`;
  } catch (_) {
    el.textContent = "";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  refreshCacheStats();

  $("guide-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("guide.html") });
  });

  $("provider").addEventListener("change", () => {
    const preset = PROVIDER_PRESETS[$("provider").value];
    if (!preset) return;
    if (preset.baseUrl) $("baseUrl").value = preset.baseUrl;
    if (preset.model) $("model").value = preset.model;
    if (preset.protocol) $("apiProtocol").value = preset.protocol;
    toggleProtocolFields();
  });
  $("apiProtocol").addEventListener("change", toggleProtocolFields);

  $("save").addEventListener("click", save);
  $("test").addEventListener("click", testConnection);
  $("reset").addEventListener("click", async () => {
    if (!confirm("恢复默认设置？（API Key 将被清空）")) return;
    await chrome.storage.sync.set(DEFAULTS);
    await load();
    setStatus("已恢复默认", "ok");
  });

  $("cacheRefresh")?.addEventListener("click", refreshCacheStats);
  $("cacheClear")?.addEventListener("click", async () => {
    if (!confirm("清空翻译缓存？下次翻译将全部重新调用大模型。")) return;
    await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
    setStatus("缓存已清空", "ok");
    refreshCacheStats();
  });

  $("btn-open-history")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
  });

  $("btn-history-clear")?.addEventListener("click", async () => {
    if (!confirm("确定要清空所有翻译历史记录吗？此操作不可恢复。")) return;
    try {
      await chrome.runtime.sendMessage({ type: "HISTORY_CLEAR" });
      setStatus("历史记录已清空", "ok");
    } catch (err) {
      setStatus(`清空失败：${err?.message || err}`, "err");
    }
  });

  $("btn-add-model")?.addEventListener("click", () => {
    showModelEditForm(null);
  });

  await loadModels();
});

let currentEditingModelId = null;

async function loadModels() {
  const container = $("models-list");
  if (!container) return;

  try {
    const [modelsResp, settingsResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_MODELS" }),
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" })
    ]);

    const models = modelsResp?.models || [];
    const activeId = settingsResp?.settings?.activeModelId;

    if (models.length === 0) {
      container.innerHTML = '<p class="hint" style="text-align:center;margin:16px 0;">暂无模型配置，点击上方按钮添加。</p>';
      return;
    }

    container.innerHTML = models
      .map((m) => {
        const isActive = m.id === activeId;
        const providerLabel = m.provider ? getProviderLabel(m.provider) : "自定义";
        return `
          <div class="model-card ${isActive ? "active" : ""}" data-id="${m.id}">
            <div class="model-header">
              <div class="model-name">
                ${m.name}
                ${isActive ? '<span class="model-active-badge">已激活</span>' : ""}
              </div>
              <div class="model-actions">
                ${!isActive ? `<button class="btn-activate" data-id="${m.id}">激活</button>` : ""}
                <button class="btn-edit-model" data-id="${m.id}">编辑</button>
                <button class="btn-delete-model" data-id="${m.id}" style="border-color:#f1b2ac;color:#c0271d;">删除</button>
              </div>
            </div>
            <div class="model-details">
              <div class="model-detail-item">
                <span class="model-detail-label">服务商：</span>
                <span>${providerLabel}</span>
              </div>
              <div class="model-detail-item">
                <span class="model-detail-label">模型：</span>
                <span>${m.model || "-"}</span>
              </div>
              <div class="model-detail-item">
                <span class="model-detail-label">协议：</span>
                <span>${m.apiProtocol === "anthropic" ? "Anthropic" : "OpenAI 兼容"}</span>
              </div>
              <div class="model-detail-item">
                <span class="model-detail-label">Base URL：</span>
                <span style="font-family:ui-monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.baseUrl || "-"}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".btn-activate").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        try {
          await chrome.runtime.sendMessage({
            type: "ACTIVATE_MODEL",
            payload: { id }
          });
          setStatus("已切换模型", "ok");
          await loadModels();
        } catch (err) {
          setStatus(`激活失败：${err?.message || err}`, "err");
        }
      });
    });

    container.querySelectorAll(".btn-edit-model").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const model = models.find((m) => m.id === id);
        if (model) showModelEditForm(model);
      });
    });

    container.querySelectorAll(".btn-delete-model").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("确定要删除此模型配置吗？")) return;
        const id = btn.dataset.id;
        try {
          await chrome.runtime.sendMessage({
            type: "DELETE_MODEL",
            payload: { id }
          });
          setStatus("已删除模型", "ok");
          await loadModels();
        } catch (err) {
          setStatus(`删除失败：${err?.message || err}`, "err");
        }
      });
    });
  } catch (err) {
    console.warn("加载模型列表失败:", err);
  }
}

function getProviderLabel(provider) {
  const labels = {
    openai: "OpenAI",
    anthropic: "Anthropic Claude",
    deepseek: "DeepSeek",
    moonshot: "Moonshot (Kimi)",
    zhipu: "智谱 GLM",
    siliconflow: "SiliconFlow",
    openrouter: "OpenRouter",
    custom: "自定义"
  };
  return labels[provider] || provider || "自定义";
}

function showModelEditForm(model) {
  currentEditingModelId = model?.id || null;
  const container = $("models-list");
  if (!container) return;

  const isEdit = !!model;
  const provider = model?.provider || "openai";
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;

  const html = `
    <div class="model-edit-form">
      <div class="field">
        <label>模型名称（用于区分）</label>
        <input id="model-name" type="text" placeholder="如：DeepSeek 翻译模型" value="${model?.name || ""}" />
      </div>
      <div class="field">
        <label>预设服务商</label>
        <select id="model-provider">
          <option value="openai" ${provider === "openai" ? "selected" : ""}>OpenAI</option>
          <option value="anthropic" ${provider === "anthropic" ? "selected" : ""}>Anthropic Claude</option>
          <option value="deepseek" ${provider === "deepseek" ? "selected" : ""}>DeepSeek</option>
          <option value="moonshot" ${provider === "moonshot" ? "selected" : ""}>Moonshot (Kimi)</option>
          <option value="zhipu" ${provider === "zhipu" ? "selected" : ""}>智谱 GLM</option>
          <option value="siliconflow" ${provider === "siliconflow" ? "selected" : ""}>SiliconFlow</option>
          <option value="openrouter" ${provider === "openrouter" ? "selected" : ""}>OpenRouter</option>
          <option value="custom" ${provider === "custom" ? "selected" : ""}>自定义</option>
        </select>
        <p class="hint">选择预设会自动填入 Base URL、模型名与 API 协议。</p>
      </div>
      <div class="field">
        <label>API 协议</label>
        <select id="model-apiProtocol">
          <option value="openai" ${(model?.apiProtocol || preset.protocol) === "openai" ? "selected" : ""}>OpenAI 兼容（/chat/completions）</option>
          <option value="anthropic" ${(model?.apiProtocol || preset.protocol) === "anthropic" ? "selected" : ""}>Anthropic（/messages）</option>
        </select>
      </div>
      <div class="field">
        <label>Base URL</label>
        <input id="model-baseUrl" type="text" placeholder="https://api.openai.com/v1" value="${model?.baseUrl || preset.baseUrl || ""}" />
      </div>
      <div class="field">
        <label>API Key</label>
        <input id="model-apiKey" type="password" placeholder="sk-..." value="${model?.apiKey || ""}" />
      </div>
      <div class="field">
        <label>模型名</label>
        <input id="model-model" type="text" placeholder="gpt-4o-mini" value="${model?.model || preset.model || ""}" />
      </div>
      <div class="field">
        <label>Temperature</label>
        <input id="model-temperature" type="number" step="0.1" min="0" max="2" value="${model?.temperature ?? 0.2}" />
      </div>
      <div class="field" id="model-max-tokens-row" style="display:${(model?.apiProtocol || preset.protocol) === "anthropic" ? "" : "none"};">
        <label>Max Tokens（仅 Anthropic 必填）</label>
        <input id="model-maxTokens" type="number" min="64" max="64000" value="${model?.maxTokens || 4096}" />
      </div>
      <div class="model-edit-actions">
        <button id="btn-save-model" class="primary">${isEdit ? "保存修改" : "添加模型"}</button>
        <button id="btn-cancel-model">取消</button>
      </div>
    </div>
  `;

  const editForm = container.querySelector(".model-edit-form");
  if (editForm) editForm.remove();
  container.insertAdjacentHTML("afterbegin", html);

  $("model-provider")?.addEventListener("change", () => {
    const p = PROVIDER_PRESETS[$("model-provider").value];
    if (!p) return;
    if (p.baseUrl) $("model-baseUrl").value = p.baseUrl;
    if (p.model) $("model-model").value = p.model;
    if (p.protocol) $("model-apiProtocol").value = p.protocol;
    toggleModelProtocolFields();
  });

  $("model-apiProtocol")?.addEventListener("change", toggleModelProtocolFields);

  $("btn-save-model")?.addEventListener("click", async () => {
    const name = $("model-name").value.trim();
    if (!name) {
      setStatus("请输入模型名称", "err");
      return;
    }
    const modelData = {
      id: currentEditingModelId,
      name: name,
      provider: $("model-provider").value,
      apiProtocol: $("model-apiProtocol").value,
      baseUrl: $("model-baseUrl").value.trim(),
      apiKey: $("model-apiKey").value.trim(),
      model: $("model-model").value.trim(),
      temperature: Number($("model-temperature").value) || 0.2,
      maxTokens: Math.max(64, Number($("model-maxTokens").value) || 4096)
    };
    try {
      await chrome.runtime.sendMessage({
        type: "SAVE_MODEL",
        payload: { model: modelData }
      });
      setStatus(currentEditingModelId ? "已保存模型" : "已添加模型", "ok");
      currentEditingModelId = null;
      await loadModels();
    } catch (err) {
      setStatus(`保存失败：${err?.message || err}`, "err");
    }
  });

  $("btn-cancel-model")?.addEventListener("click", () => {
    currentEditingModelId = null;
    const editForm = container.querySelector(".model-edit-form");
    if (editForm) editForm.remove();
  });
}

function toggleModelProtocolFields() {
  const isAnthropic = $("model-apiProtocol")?.value === "anthropic";
  const row = document.getElementById("model-max-tokens-row");
  if (row) row.style.display = isAnthropic ? "" : "none";
}
