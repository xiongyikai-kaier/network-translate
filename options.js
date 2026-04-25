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
  inlineSelection: true,
  hideToast: false
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
  $("inlineSelection").checked = s.inlineSelection !== false;
  $("hideToast").checked = !!s.hideToast;
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
    inlineSelection: $("inlineSelection").checked,
    hideToast: $("hideToast").checked
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
});
