// background.js — Service Worker (MV3)
// 负责：右键菜单、命令快捷键、与 LLM API 通信（绕过 content script 的 CORS 限制）

const DEFAULT_SETTINGS = {
  enabled: true,
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
  activeModelId: null,
  models: []
};

async function getSettings() {
  const data = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...data };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...existing };
  // 清理旧键：从 v0.1 的全局开关 + 黑名单，迁移到 v0.2 的白名单模型
  if ("autoTranslate" in existing) {
    delete merged.autoTranslate;
    await chrome.storage.sync.remove("autoTranslate").catch(() => {});
  }
  if ("autoTranslateBlocklist" in existing) {
    delete merged.autoTranslateBlocklist;
    await chrome.storage.sync.remove("autoTranslateBlocklist").catch(() => {});
  }
  await chrome.storage.sync.set(merged);

  chrome.contextMenus.create({
    id: "translate-page",
    title: "翻译当前页面",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "translate-selection",
    title: "翻译选中文本",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "restore-page",
    title: "恢复原文",
    contexts: ["page"]
  });
});

async function sendOrInject(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: ["content.js"]
      });
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: false },
        files: ["content.css"]
      });
      await chrome.tabs.sendMessage(tabId, msg);
    } catch (err) {
      console.warn("[AI 翻译] 无法注入脚本:", err?.message || err);
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "translate-page") {
    sendOrInject(tab.id, { type: "TRANSLATE_PAGE" });
  } else if (info.menuItemId === "translate-selection") {
    sendOrInject(tab.id, { type: "TRANSLATE_SELECTION", text: info.selectionText || "" });
  } else if (info.menuItemId === "restore-page") {
    sendOrInject(tab.id, { type: "RESTORE_PAGE" });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === "translate-page") {
    sendOrInject(tab.id, { type: "TRANSLATE_PAGE" });
  } else if (command === "translate-selection") {
    sendOrInject(tab.id, { type: "TRANSLATE_SELECTION_FROM_PAGE" });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "LLM_TRANSLATE") {
    handleTranslate(msg.payload)
      .then((result) => {
        if (msg.payload?.saveToHistory) {
          addHistoryEntry({
            type: msg.payload.isPage ? "page" : "text",
            original: msg.payload.texts,
            translated: result,
            targetLang: msg.payload.targetLang,
            sourceLang: msg.payload.sourceLang
          }).catch(() => {});
        }
        return sendResponse({ ok: true, result });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "GET_SETTINGS") {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }
  if (msg?.type === "CACHE_STATS") {
    getCacheStats().then((s) => sendResponse({ ok: true, stats: s }));
    return true;
  }
  if (msg?.type === "CACHE_CLEAR") {
    clearCache().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "HISTORY_LIST") {
    getHistoryList(msg.payload?.limit).then((list) => sendResponse({ ok: true, list }));
    return true;
  }
  if (msg?.type === "HISTORY_SEARCH") {
    searchHistory(msg.payload?.keyword).then((list) => sendResponse({ ok: true, list }));
    return true;
  }
  if (msg?.type === "HISTORY_CLEAR") {
    clearHistory().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "HISTORY_DELETE") {
    deleteHistoryEntry(msg.payload?.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "GET_MODELS") {
    getModels().then((m) => sendResponse({ ok: true, models: m }));
    return true;
  }
  if (msg?.type === "SAVE_MODEL") {
    saveModel(msg.payload?.model).then((m) => sendResponse({ ok: true, model: m }));
    return true;
  }
  if (msg?.type === "DELETE_MODEL") {
    deleteModel(msg.payload?.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "ACTIVATE_MODEL") {
    activateModel(msg.payload?.id).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handleTranslate({ texts, targetLang, sourceLang, cacheOnly, skipCache }) {
  const settings = await getSettings();
  if (settings.enabled === false) {
    throw new Error("扩展已禁用");
  }
  const tgt = targetLang || settings.targetLang;
  const src = sourceLang || settings.sourceLang;

  const isArray = Array.isArray(texts);
  const items = isArray ? texts : [texts];
  if (items.length === 0) return isArray ? [] : "";

  const cacheOpts = { targetLang: tgt, model: settings.model };
  const { results, missingIndices } = skipCache
    ? { results: new Array(items.length), missingIndices: items.map((_, i) => i) }
    : await cacheLookup(items, cacheOpts);

  if (cacheOnly || missingIndices.length === 0) {
    return isArray ? results : (results[0] ?? "");
  }

  if (!settings.apiKey) {
    throw new Error("尚未配置 API Key，请在选项页中设置");
  }

  const missingTexts = missingIndices.map((i) => items[i]);
  const batches = chunkBatches(missingTexts, settings.batchSize, settings.maxCharsPerBatch);
  const missingResults = new Array(missingTexts.length);

  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, settings.concurrency) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= batches.length) break;
      const { start, slice } = batches[idx];
      const translated = await callLLM(slice, { settings, targetLang: tgt, sourceLang: src });
      for (let i = 0; i < translated.length; i++) {
        missingResults[start + i] = translated[i];
      }
    }
  });
  await Promise.all(workers);

  const pairs = [];
  for (let j = 0; j < missingIndices.length; j++) {
    const origIdx = missingIndices[j];
    const tr = missingResults[j];
    if (tr) {
      results[origIdx] = tr;
      pairs.push([items[origIdx], tr]);
    }
  }
  if (pairs.length && !skipCache) cachePut(pairs, cacheOpts);

  return isArray ? results : (results[0] ?? "");
}

// ——— 翻译缓存（chrome.storage.local + SW 内存 Map） ———
const CACHE_STORAGE_KEY = "llmTransCache";
const CACHE_FLUSH_DELAY_MS = 600;

async function getMaxCacheEntries() {
  const s = await chrome.storage.sync.get({ maxCacheEntries: 5000 });
  return Math.max(100, Number(s.maxCacheEntries) || 5000);
}

let cacheMap = null;
let cacheDirty = false;
let cacheFlushTimer = null;

function normText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function cacheKey(text, { targetLang, model }) {
  return `${targetLang}|${model}|${normText(text)}`;
}

async function getCacheMap() {
  if (cacheMap) return cacheMap;
  try {
    const { [CACHE_STORAGE_KEY]: raw } = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    const entries = raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
    cacheMap = new Map(Object.entries(entries));
  } catch (_) {
    cacheMap = new Map();
  }
  return cacheMap;
}

function scheduleCacheFlush() {
  cacheDirty = true;
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(async () => {
    cacheFlushTimer = null;
    if (!cacheDirty || !cacheMap) return;
    cacheDirty = false;
    const maxEntries = await getMaxCacheEntries();
    if (cacheMap.size > maxEntries) {
      const arr = [...cacheMap.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      const drop = arr.slice(0, cacheMap.size - maxEntries);
      for (const [k] of drop) cacheMap.delete(k);
    }
    try {
      await chrome.storage.local.set({
        [CACHE_STORAGE_KEY]: { version: 1, entries: Object.fromEntries(cacheMap) }
      });
    } catch (err) {
      console.warn("[AI 翻译] 缓存写入失败:", err?.message || err);
    }
  }, CACHE_FLUSH_DELAY_MS);
}

async function cacheLookup(texts, opts) {
  const map = await getCacheMap();
  const now = Date.now();
  const results = new Array(texts.length).fill(null);
  const missingIndices = [];
  let touched = false;
  for (let i = 0; i < texts.length; i++) {
    const k = cacheKey(texts[i], opts);
    const v = map.get(k);
    if (v && typeof v.t === "string" && v.t.length > 0) {
      results[i] = v.t;
      v.ts = now;
      v.h = (v.h || 0) + 1;
      touched = true;
    } else {
      missingIndices.push(i);
    }
  }
  if (touched) scheduleCacheFlush();
  return { results, missingIndices };
}

async function cachePut(pairs, opts) {
  const map = await getCacheMap();
  const now = Date.now();
  for (const [src, tr] of pairs) {
    if (!tr || !src) continue;
    const k = cacheKey(src, opts);
    const ex = map.get(k);
    map.set(k, { t: tr, ts: now, h: (ex?.h || 0) + 1 });
  }
  scheduleCacheFlush();
}

async function getCacheStats() {
  const map = await getCacheMap();
  let chars = 0;
  for (const v of map.values()) chars += (v.t || "").length;
  const max = await getMaxCacheEntries();
  return { count: map.size, chars, max };
}

async function clearCache() {
  cacheMap = new Map();
  cacheDirty = false;
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer);
    cacheFlushTimer = null;
  }
  try {
    await chrome.storage.local.remove(CACHE_STORAGE_KEY);
  } catch (_) {}
}

function chunkBatches(items, batchSize, maxChars) {
  const out = [];
  let buf = [];
  let bufChars = 0;
  let start = 0;
  for (let i = 0; i < items.length; i++) {
    const t = items[i] ?? "";
    const tChars = t.length;
    const wouldOverflow =
      buf.length >= batchSize || (bufChars + tChars > maxChars && buf.length > 0);
    if (wouldOverflow) {
      out.push({ start, slice: buf });
      start = i;
      buf = [];
      bufChars = 0;
    }
    buf.push(t);
    bufChars += tChars;
  }
  if (buf.length) out.push({ start, slice: buf });
  return out;
}

async function callLLM(slice, { settings, targetLang, sourceLang }) {
  const sysPrompt = (settings.systemPrompt || "").replaceAll("{targetLang}", targetLang);
  const langHint =
    sourceLang && sourceLang !== "auto" ? `源语言：${sourceLang}。` : "源语言：自动检测。";

  const userPayload = JSON.stringify(slice);
  const userMessage = `${langHint}请把下面 JSON 数组中的每一项翻译成${targetLang}，按相同顺序与长度返回 JSON 数组：\n${userPayload}`;

  const protocol = settings.apiProtocol || "openai";
  const content =
    protocol === "anthropic"
      ? await callAnthropic({ settings, sysPrompt, userMessage })
      : await callOpenAI({ settings, sysPrompt, userMessage });

  return parseArrayResponse(content, slice.length);
}

async function callOpenAI({ settings, sysPrompt, userMessage }) {
  const url = settings.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userMessage }
    ],
    temperature: settings.temperature ?? 0.2,
    stream: false
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM 请求失败 ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic({ settings, sysPrompt, userMessage }) {
  const url = settings.baseUrl.replace(/\/$/, "") + "/messages";
  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens || 4096,
    system: sysPrompt,
    messages: [{ role: "user", content: userMessage }],
    temperature: settings.temperature ?? 0.2
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": settings.anthropicVersion || "2023-06-01",
      // 允许扩展（浏览器环境）直接调用 Anthropic API
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Claude 请求失败 ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  // content 是 [{type:"text", text:"..."}, ...]
  const parts = Array.isArray(data?.content) ? data.content : [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

function parseArrayResponse(content, expectedLen) {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  // 优先尝试直接 JSON
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return normalizeLen(arr.map(String), expectedLen);
  } catch (_) {}
  // 提取首个 [...] 片段
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return normalizeLen(arr.map(String), expectedLen);
    } catch (_) {}
  }
  // 兜底：按行拆分
  const lines = cleaned.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === expectedLen) return lines;
  // 单条文本场景
  if (expectedLen === 1) return [cleaned];
  return normalizeLen(lines, expectedLen);
}

function normalizeLen(arr, n) {
  if (arr.length === n) return arr;
  if (arr.length > n) return arr.slice(0, n);
  return arr.concat(new Array(n - arr.length).fill(""));
}

// ——— 翻译历史记录管理 ———
const HISTORY_STORAGE_KEY = "llmTransHistory";

async function getMaxHistoryEntries() {
  const s = await chrome.storage.sync.get({ maxHistoryEntries: 200 });
  return Math.max(10, Number(s.maxHistoryEntries) || 200);
}

async function isHistoryEnabled() {
  const s = await chrome.storage.sync.get({ historyEnabled: true });
  return s.historyEnabled !== false;
}

async function addHistoryEntry({ type, original, translated, targetLang, sourceLang }) {
  if (!(await isHistoryEnabled())) return;
  try {
    const { [HISTORY_STORAGE_KEY]: raw } = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    let history = raw?.history && Array.isArray(raw.history) ? raw.history : [];
    const entry = {
      id: Date.now().toString() + "-" + Math.random().toString(36).slice(2, 9),
      type: type || "text",
      original: typeof original === "string" ? original : JSON.stringify(original),
      translated: typeof translated === "string" ? translated : JSON.stringify(translated),
      targetLang: targetLang || "中文（简体）",
      sourceLang: sourceLang || "auto",
      ts: Date.now()
    };
    history.unshift(entry);
    const maxEntries = await getMaxHistoryEntries();
    if (history.length > maxEntries) {
      history = history.slice(0, maxEntries);
    }
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: { version: 1, history } });
  } catch (err) {
    console.warn("[AI 翻译] 保存历史记录失败:", err?.message || err);
  }
}

async function getHistoryList(limit) {
  try {
    const { [HISTORY_STORAGE_KEY]: raw } = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const history = raw?.history && Array.isArray(raw.history) ? raw.history : [];
    const maxLimit = Math.max(1, Number(limit) || 100);
    return history.slice(0, maxLimit);
  } catch (_) {
    return [];
  }
}

async function searchHistory(keyword) {
  if (!keyword || typeof keyword !== "string") return getHistoryList(100);
  const kw = keyword.toLowerCase().trim();
  try {
    const { [HISTORY_STORAGE_KEY]: raw } = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const history = raw?.history && Array.isArray(raw.history) ? raw.history : [];
    return history.filter((h) => {
      const orig = (h.original || "").toLowerCase();
      const trans = (h.translated || "").toLowerCase();
      return orig.includes(kw) || trans.includes(kw);
    });
  } catch (_) {
    return [];
  }
}

async function deleteHistoryEntry(id) {
  if (!id) return;
  try {
    const { [HISTORY_STORAGE_KEY]: raw } = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const history = raw?.history && Array.isArray(raw.history) ? raw.history : [];
    const filtered = history.filter((h) => h.id !== id);
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: { version: 1, history: filtered } });
  } catch (err) {
    console.warn("[AI 翻译] 删除历史记录失败:", err?.message || err);
  }
}

async function clearHistory() {
  try {
    await chrome.storage.local.remove(HISTORY_STORAGE_KEY);
  } catch (_) {}
}

// ——— 多模型管理 ———
const MODELS_STORAGE_KEY = "llmTransModels";

async function getModels() {
  try {
    const { [MODELS_STORAGE_KEY]: raw } = await chrome.storage.local.get(MODELS_STORAGE_KEY);
    return raw?.models && Array.isArray(raw.models) ? raw.models : [];
  } catch (_) {
    return [];
  }
}

async function saveModel(model) {
  if (!model || !model.name) throw new Error("模型名称不能为空");
  try {
    const models = await getModels();
    const now = Date.now();
    if (model.id) {
      const idx = models.findIndex((m) => m.id === model.id);
      if (idx >= 0) {
        models[idx] = { ...models[idx], ...model, updatedAt: now };
      } else {
        models.push({ ...model, id: model.id || "model-" + now, createdAt: now, updatedAt: now });
      }
    } else {
      models.push({ ...model, id: "model-" + now, createdAt: now, updatedAt: now });
    }
    await chrome.storage.local.set({ [MODELS_STORAGE_KEY]: { version: 1, models } });
    return model;
  } catch (err) {
    console.warn("[AI 翻译] 保存模型失败:", err?.message || err);
    throw err;
  }
}

async function deleteModel(id) {
  if (!id) return;
  try {
    const models = await getModels();
    const filtered = models.filter((m) => m.id !== id);
    await chrome.storage.local.set({ [MODELS_STORAGE_KEY]: { version: 1, models: filtered } });
    const settings = await getSettings();
    if (settings.activeModelId === id) {
      await chrome.storage.sync.set({ activeModelId: null });
    }
  } catch (err) {
    console.warn("[AI 翻译] 删除模型失败:", err?.message || err);
  }
}

async function activateModel(id) {
  try {
    const models = await getModels();
    if (id) {
      const model = models.find((m) => m.id === id);
      if (!model) throw new Error("模型不存在");
      await chrome.storage.sync.set({ activeModelId: id });
      if (model.apiProtocol) await chrome.storage.sync.set({ apiProtocol: model.apiProtocol });
      if (model.baseUrl) await chrome.storage.sync.set({ baseUrl: model.baseUrl });
      if (model.apiKey) await chrome.storage.sync.set({ apiKey: model.apiKey });
      if (model.model) await chrome.storage.sync.set({ model: model.model });
      if (model.temperature !== undefined) await chrome.storage.sync.set({ temperature: model.temperature });
      if (model.maxTokens !== undefined) await chrome.storage.sync.set({ maxTokens: model.maxTokens });
    } else {
      await chrome.storage.sync.set({ activeModelId: null });
    }
  } catch (err) {
    console.warn("[AI 翻译] 激活模型失败:", err?.message || err);
    throw err;
  }
}

// ——— 缓存过期管理 ———
async function getCacheExpireMs() {
  const s = await chrome.storage.sync.get({ cacheExpireHours: 72 });
  const hours = Math.max(1, Number(s.cacheExpireHours) || 72);
  return hours * 60 * 60 * 1000;
}

// 重写 cacheLookup 以支持过期检查
const originalCacheLookup = cacheLookup;
async function cacheLookupWithExpiry(texts, opts) {
  const map = await getCacheMap();
  const now = Date.now();
  const expireMs = await getCacheExpireMs();
  const results = new Array(texts.length).fill(null);
  const missingIndices = [];
  let touched = false;
  let expired = false;

  for (let i = 0; i < texts.length; i++) {
    const k = cacheKey(texts[i], opts);
    const v = map.get(k);
    if (v && typeof v.t === "string" && v.t.length > 0) {
      if (v.ts && now - v.ts > expireMs) {
        map.delete(k);
        expired = true;
        missingIndices.push(i);
      } else {
        results[i] = v.t;
        v.ts = now;
        v.h = (v.h || 0) + 1;
        touched = true;
      }
    } else {
      missingIndices.push(i);
    }
  }
  if (touched || expired) scheduleCacheFlush();
  return { results, missingIndices };
}

// 替换原来的 cacheLookup
cacheLookup = cacheLookupWithExpiry;
