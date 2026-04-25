// content.js — 注入页面，负责抽取文本节点、展示译文、处理划词翻译

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "KBD", "SAMP",
  "TEXTAREA", "INPUT", "SELECT", "OPTION", "CANVAS", "SVG", "MATH",
  "IFRAME", "VIDEO", "AUDIO"
]);

const MIN_TEXT_LEN = 2;
const BLOCK_MARK = "data-llm-translated";
const BILINGUAL_CLASS = "llm-translated-bilingual";

const state = {
  translating: false,
  translated: false,
  originalMap: new Map(), // node -> original text (for replace mode)
  bilingualNodes: [], // inserted translation element refs
  fab: null
};

let processedNodes = new WeakSet(); // 已翻译过的文本节点（避免重复处理）
let mutationObserver = null;
let pendingNodes = new Set();
let mutationTimer = null;
let urlWatchTimer = null;
let lastWatchedUrl = "";
let rescanTimer = null;
const MUTATION_DEBOUNCE_MS = 400;
const URL_POLL_MS = 400;
const SPA_SETTLE_MS = 500;

// ——— 视口优先翻译 ———
let viewportObserver = null;
let lazyParentMap = new WeakMap(); // parent element -> [textNodes]
let lazyPendingNodes = new Set();
let lazyTranslateTimer = null;
const VIEWPORT_MARGIN_PX = 200; // 提前一屏的 margin，预翻译临近视口的内容
const LAZY_DEBOUNCE_MS = 250;

async function isEnabled() {
  const s = await getSettings();
  return s.enabled !== false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!(await isEnabled())) {
        sendResponse({ ok: false, error: "扩展已禁用" });
        return;
      }
      if (msg?.type === "TRANSLATE_PAGE") {
        await translatePage();
        sendResponse({ ok: true });
      } else if (msg?.type === "TRANSLATE_SELECTION") {
        await translateSelection(msg.text);
        sendResponse({ ok: true });
      } else if (msg?.type === "TRANSLATE_SELECTION_FROM_PAGE") {
        const sel = window.getSelection()?.toString() || "";
        await translateSelection(sel);
        sendResponse({ ok: true });
      } else if (msg?.type === "RESTORE_PAGE") {
        restorePage();
        sendResponse({ ok: true });
      } else if (msg?.type === "GET_STATE") {
        sendResponse({ ok: true, state: { translated: state.translated, translating: state.translating } });
      }
    } catch (err) {
      console.error("[AI 翻译]", err);
      showToast(`翻译失败：${err?.message || err}`);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});

function isVisible(el) {
  if (!el || el.nodeType !== 1) return true;
  const style = window.getComputedStyle(el);
  // 注意：不检查 opacity === 0，避免 SPA 过渡动画期间误判为隐藏
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

function isInViewport(el, margin = VIEWPORT_MARGIN_PX) {
  if (!el || el.nodeType !== 1) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  return (
    rect.bottom > -margin &&
    rect.top < vh + margin &&
    rect.right > -margin &&
    rect.left < vw + margin
  );
}

function shouldSkip(node) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute("translate") === "no") return true;
    el = el.parentElement;
  }
  return false;
}

function collectTextNodes(root = document.body) {
  const nodes = [];
  if (!root) return nodes;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const text = n.nodeValue.replace(/\s+/g, " ").trim();
      if (text.length < MIN_TEXT_LEN) return NodeFilter.FILTER_REJECT;
      if (!/[\p{L}]/u.test(text)) return NodeFilter.FILTER_REJECT; // 至少包含一个字母
      if (shouldSkip(n)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(n.parentElement)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let cur;
  while ((cur = walker.nextNode())) nodes.push(cur);
  return nodes;
}

async function translatePage() {
  if (state.translating) return;
  state.translating = true;
  updateFabState();
  try {
    const settings = await getSettings();
    const allNodes = collectTextNodes(document.body);
    if (allNodes.length === 0) {
      showToast("未找到可翻译文本");
      return;
    }

    const viewportFirst = settings.viewportFirst !== false;
    let visibleNodes = allNodes;
    let offscreenNodes = [];
    if (viewportFirst) {
      visibleNodes = [];
      for (const n of allNodes) {
        if (isInViewport(n.parentElement)) visibleNodes.push(n);
        else offscreenNodes.push(n);
      }
      if (visibleNodes.length === 0) {
        visibleNodes = allNodes;
        offscreenNodes = [];
      }
    }

    if (visibleNodes.length > 0) {
      await translateNodeBatch(visibleNodes, settings);
    }

    state.translated = true;
    if (offscreenNodes.length > 0) {
      observeOffscreenNodes(offscreenNodes);
      showToast(
        `已翻译屏幕内 ${visibleNodes.length} 段，剩余 ${offscreenNodes.length} 段将随滚动加载`
      );
    } else {
      showToast(`已翻译 ${visibleNodes.length} 段文本`);
    }
    startMutationObserver();
  } finally {
    state.translating = false;
    updateFabState();
  }
}

async function translateNodeBatch(nodes, settings) {
  if (!nodes.length) return;
  const texts = nodes.map((n) => n.nodeValue.trim());
  const applied = new Set();
  // 阶段 1：缓存命中先渲染
  try {
    const cached = await requestTranslate(texts, { cacheOnly: true });
    if (cached.some(Boolean)) {
      applyTranslations(nodes, cached, settings.displayMode, applied);
    }
  } catch (_) {}
  // 阶段 2：LLM 补翻译未命中项
  const full = await requestTranslate(texts);
  applyTranslations(nodes, full, settings.displayMode, applied);
}

async function translateSelection(text) {
  const sel = (text || window.getSelection()?.toString() || "").trim();
  if (!sel) {
    showToast("请先选中要翻译的文本");
    return;
  }
  // 先查缓存，命中则直接显示，不闪 toast
  try {
    const cached = await requestTranslate(sel, { cacheOnly: true });
    const result = Array.isArray(cached) ? cached[0] : cached;
    if (result) {
      showSelectionPopup(result, sel);
      return;
    }
  } catch (_) {}
  // 缓存未命中，显示进度并调 API
  showToast("翻译中…", { sticky: true, id: "llm-sel" });
  try {
    const translated = await requestTranslate(sel);
    dismissToast("llm-sel");
    showSelectionPopup(Array.isArray(translated) ? translated[0] : translated, sel);
  } catch (err) {
    dismissToast("llm-sel");
    throw err;
  }
}

function applyTranslations(nodes, translated, mode, applied) {
  for (let i = 0; i < nodes.length; i++) {
    if (applied && applied.has(i)) continue;
    const node = nodes[i];
    const tr = translated[i];
    if (!tr || typeof tr !== "string") continue;
    processedNodes.add(node); // 先标记再改动，避免 Observer 回捕自己的修改
    if (mode === "replace") {
      if (!state.originalMap.has(node)) {
        state.originalMap.set(node, node.nodeValue);
      }
      node.nodeValue = tr;
    } else {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.getAttribute(BLOCK_MARK) === "1") continue;
      const wrapper = document.createElement("span");
      wrapper.className = BILINGUAL_CLASS;
      wrapper.textContent = tr;
      node.parentNode.insertBefore(wrapper, node.nextSibling);
      state.bilingualNodes.push(wrapper);
    }
    if (applied) applied.add(i);
  }
}

function restorePage() {
  stopMutationObserver();
  stopViewportObserver();
  for (const [node, original] of state.originalMap) {
    try { node.nodeValue = original; } catch (_) {}
  }
  state.originalMap.clear();
  for (const el of state.bilingualNodes) {
    try { el.remove(); } catch (_) {}
  }
  state.bilingualNodes = [];
  state.translated = false;
  processedNodes = new WeakSet();
  updateFabState();
  showToast("已恢复原文");
}

// ——— 视口懒翻译：滚到附近时再翻 ———
function ensureViewportObserver() {
  if (viewportObserver) return viewportObserver;
  viewportObserver = new IntersectionObserver(
    (entries) => {
      let any = false;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
        const tnodes = lazyParentMap.get(target);
        viewportObserver.unobserve(target);
        lazyParentMap.delete(target);
        if (!tnodes) continue;
        for (const n of tnodes) {
          if (n.isConnected && !processedNodes.has(n)) {
            lazyPendingNodes.add(n);
            any = true;
          }
        }
      }
      if (any) scheduleLazyTranslate();
    },
    { rootMargin: `${VIEWPORT_MARGIN_PX}px 0px` }
  );
  return viewportObserver;
}

function observeOffscreenNodes(nodes) {
  if (!nodes.length) return;
  const obs = ensureViewportObserver();
  for (const n of nodes) {
    const el = n.parentElement;
    if (!el) continue;
    let arr = lazyParentMap.get(el);
    if (!arr) {
      arr = [];
      lazyParentMap.set(el, arr);
      obs.observe(el);
    }
    arr.push(n);
  }
}

function stopViewportObserver() {
  if (viewportObserver) {
    viewportObserver.disconnect();
    viewportObserver = null;
  }
  if (lazyTranslateTimer) {
    clearTimeout(lazyTranslateTimer);
    lazyTranslateTimer = null;
  }
  lazyPendingNodes.clear();
  lazyParentMap = new WeakMap();
}

function scheduleLazyTranslate() {
  if (lazyTranslateTimer) return;
  lazyTranslateTimer = setTimeout(runLazyTranslate, LAZY_DEBOUNCE_MS);
}

async function runLazyTranslate() {
  lazyTranslateTimer = null;
  if (!state.translated) {
    lazyPendingNodes.clear();
    return;
  }
  const nodes = [...lazyPendingNodes].filter(
    (n) => n.isConnected && !processedNodes.has(n) && isCandidateText(n)
  );
  lazyPendingNodes.clear();
  if (!nodes.length) return;
  const settings = await getSettings();
  try {
    await translateNodeBatch(nodes, settings);
  } catch (err) {
    console.warn("[AI 翻译] 视口懒翻译失败:", err?.message || err);
  }
}

async function requestTranslate(texts, opts = {}) {
  const resp = await chrome.runtime.sendMessage({
    type: "LLM_TRANSLATE",
    payload: { texts, cacheOnly: !!opts.cacheOnly }
  });
  if (!resp?.ok) throw new Error(resp?.error || "翻译服务未响应");
  return resp.result;
}

async function getSettings() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  return resp?.settings || {};
}

// ——— UI：Toast ———
function ensureToastHost() {
  let host = document.getElementById("llm-translate-toast-host");
  if (host) return host;
  host = document.createElement("div");
  host.id = "llm-translate-toast-host";
  document.documentElement.appendChild(host);
  return host;
}
function showToast(text, opts = {}) {
  const host = ensureToastHost();
  const { sticky = false, id } = opts;
  if (id) dismissToast(id);
  const el = document.createElement("div");
  el.className = "llm-translate-toast";
  if (id) el.dataset.toastId = id;
  el.textContent = text;
  host.appendChild(el);
  if (!sticky) {
    setTimeout(() => el.remove(), 2400);
  }
  return el;
}
function dismissToast(id) {
  document.querySelectorAll(`.llm-translate-toast[data-toast-id="${id}"]`).forEach((n) => n.remove());
}

// ——— UI：选区译文弹窗 ———
let selectionPopupEl = null;
function showSelectionPopup(translated, original) {
  dismissSelectionPopup();
  const sel = window.getSelection();
  let rect = null;
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    rect = range.getBoundingClientRect();
  }
  const pop = document.createElement("div");
  pop.className = "llm-translate-popup";
  const head = document.createElement("div");
  head.className = "llm-translate-popup-head";
  head.textContent = "译文";
  const close = document.createElement("button");
  close.className = "llm-translate-popup-close";
  close.textContent = "×";
  close.addEventListener("click", dismissSelectionPopup);
  head.appendChild(close);
  const body = document.createElement("div");
  body.className = "llm-translate-popup-body";
  body.textContent = translated;
  pop.appendChild(head);
  pop.appendChild(body);
  document.documentElement.appendChild(pop);

  const top = (rect ? rect.bottom : 80) + window.scrollY + 8;
  const left = (rect ? rect.left : 80) + window.scrollX;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, left)}px`;
  selectionPopupEl = pop;

  const onDocClick = (e) => {
    if (!pop.contains(e.target)) {
      dismissSelectionPopup();
      document.removeEventListener("mousedown", onDocClick, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", onDocClick, true), 0);
}
function dismissSelectionPopup() {
  if (selectionPopupEl) {
    selectionPopupEl.remove();
    selectionPopupEl = null;
  }
}

// ——— 滑词翻译：选中文本自动弹窗 ———
let selectionTimer = null;
const SELECTION_DEBOUNCE_MS = 300;

async function onSelectionAuto() {
  try {
    const settings = await getSettings();
    if (!settings.inlineSelection) return;
  } catch (_) { return; }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const text = sel.toString().trim();
  if (!text || text.length < 2) return;

  const range = sel.getRangeAt(0);
  let el = range.startContainer?.nodeType === 3
    ? range.startContainer.parentElement
    : range.startContainer;
  while (el) {
    if (isOurInjected(el)) return;
    el = el.parentElement;
  }

  translateSelection(text);
}

document.addEventListener("mouseup", () => {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    selectionTimer = null;
    onSelectionAuto();
  }, SELECTION_DEBOUNCE_MS);
});

// ——— UI：浮动按钮（FAB） ———
const FAB_DRAG_THRESHOLD = 4; // px，超过视为拖拽而非点击
const FAB_MARGIN = 8; // px，距离视口上下的最小留白

function clampTopPct(pct) {
  if (!Number.isFinite(pct)) return 70;
  return Math.min(95, Math.max(2, pct));
}

function applyFabPosition(btn, pct) {
  const h = btn.offsetHeight || 44;
  const maxTop = window.innerHeight - h - FAB_MARGIN;
  const minTop = FAB_MARGIN;
  let top = (clampTopPct(pct) / 100) * window.innerHeight;
  top = Math.min(maxTop, Math.max(minTop, top));
  btn.style.top = `${top}px`;
  btn.style.bottom = "auto";
}

async function mountFab() {
  if (state.fab) return;
  if (window.top !== window.self) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "llm-translate-fab";
  btn.title = "点击翻译本页 · 上下拖动调整位置";
  btn.setAttribute("aria-label", "翻译本页");
  btn.textContent = "译";
  document.documentElement.appendChild(btn);
  state.fab = btn;

  const stored = await chrome.storage.sync.get({ fabTopPct: 70 });
  applyFabPosition(btn, stored.fabTopPct);

  let drag = null;
  let wasDragged = false;

  const onMove = (e) => {
    if (!drag) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = y - drag.startY;
    if (!wasDragged && Math.abs(dy) > FAB_DRAG_THRESHOLD) {
      wasDragged = true;
      btn.classList.add("dragging");
    }
    if (wasDragged) {
      if (e.cancelable) e.preventDefault();
      const h = btn.offsetHeight;
      const newTop = Math.min(
        window.innerHeight - h - FAB_MARGIN,
        Math.max(FAB_MARGIN, drag.startTop + dy)
      );
      btn.style.top = `${newTop}px`;
      btn.style.bottom = "auto";
    }
  };
  const onUp = () => {
    if (!drag) return;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    document.removeEventListener("touchmove", onMove, true);
    document.removeEventListener("touchend", onUp, true);
    document.removeEventListener("touchcancel", onUp, true);
    if (wasDragged) {
      btn.classList.remove("dragging");
      const top = parseFloat(btn.style.top) || 0;
      const pct = clampTopPct((top / window.innerHeight) * 100);
      chrome.storage.sync.set({ fabTopPct: pct });
    }
    drag = null;
  };
  const onDown = (e) => {
    if (state.translating) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = btn.getBoundingClientRect();
    drag = { startY: y, startTop: rect.top };
    wasDragged = false;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("touchmove", onMove, { capture: true, passive: false });
    document.addEventListener("touchend", onUp, true);
    document.addEventListener("touchcancel", onUp, true);
  };
  btn.addEventListener("mousedown", onDown);
  btn.addEventListener("touchstart", onDown, { passive: true });

  btn.addEventListener("click", async (e) => {
    if (wasDragged) {
      wasDragged = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    if (state.translating) return;
    if (state.translated) restorePage();
    else translatePage();
  });

  window.addEventListener("resize", () => {
    chrome.storage.sync.get({ fabTopPct: 70 }).then(({ fabTopPct }) => {
      if (state.fab) applyFabPosition(state.fab, fabTopPct);
    });
  });

  updateFabState();
}
function unmountFab() {
  if (state.fab) {
    state.fab.remove();
    state.fab = null;
  }
}
function updateFabState() {
  if (!state.fab) return;
  state.fab.classList.toggle("loading", state.translating);
  state.fab.classList.toggle("active", state.translated && !state.translating);
  state.fab.textContent = state.translated ? "原" : "译";
  state.fab.title = state.translating
    ? "翻译中…"
    : state.translated
      ? "点击恢复原文 · 上下拖动调整位置"
      : "点击翻译本页 · 上下拖动调整位置";
}

(async function initFab() {
  try {
    const settings = await getSettings();
    if (settings.enabled === false) return;
    if (settings.showFab !== false) mountFab();
  } catch (_) {}
})();

// ——— MutationObserver：翻译后持续跟踪新增内容 ———
function isOurInjected(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.id === "llm-translate-fab") return true;
  if (el.id === "llm-translate-toast-host") return true;
  if (el.classList?.contains(BILINGUAL_CLASS)) return true;
  if (el.classList?.contains("llm-translate-popup")) return true;
  if (el.classList?.contains("llm-translate-toast")) return true;
  return false;
}
function isInsideOurInjected(node) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el) {
    if (isOurInjected(el)) return true;
    el = el.parentElement;
  }
  return false;
}
function isCandidateText(n) {
  if (!n || n.nodeType !== 3) return false;
  if (processedNodes.has(n)) return false;
  const raw = n.nodeValue || "";
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < MIN_TEXT_LEN) return false;
  if (!/[\p{L}]/u.test(text)) return false;
  if (shouldSkip(n)) return false;
  if (isInsideOurInjected(n)) return false;
  if (!isVisible(n.parentElement)) return false;
  return true;
}
function collectFrom(node) {
  if (!node) return;
  if (isOurInjected(node)) return;
  if (node.nodeType === 3) {
    if (isCandidateText(node)) pendingNodes.add(node);
    return;
  }
  if (node.nodeType !== 1) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (isCandidateText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  let cur;
  while ((cur = walker.nextNode())) pendingNodes.add(cur);
}

function startMutationObserver() {
  if (mutationObserver) return;
  mutationObserver = new MutationObserver((mutations) => {
    let bigBurst = 0;
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const n of m.addedNodes) {
          bigBurst++;
          collectFrom(n);
        }
      } else if (m.type === "characterData") {
        processedNodes.delete(m.target); // 同一文本节点值变了，允许重翻
        collectFrom(m.target);
      }
    }
    if (pendingNodes.size > 0) scheduleMutationTranslate();
    // 大批量 DOM 替换（SPA 视图切换）时，兜底再做一次全页重扫
    if (bigBurst >= 40) scheduleFullRescan(SPA_SETTLE_MS);
  });
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
  startUrlWatch();
}
function stopMutationObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
  if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
  pendingNodes.clear();
  stopUrlWatch();
}

function startUrlWatch() {
  if (urlWatchTimer) return;
  lastWatchedUrl = location.href;
  urlWatchTimer = setInterval(() => {
    if (location.href !== lastWatchedUrl) {
      lastWatchedUrl = location.href;
      if (state.translated) scheduleFullRescan(SPA_SETTLE_MS);
    }
  }, URL_POLL_MS);
}
function stopUrlWatch() {
  if (urlWatchTimer) { clearInterval(urlWatchTimer); urlWatchTimer = null; }
}

function scheduleFullRescan(delay = 0) {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    if (!state.translated) return;
    const all = collectTextNodes(document.body);
    let added = 0;
    for (const n of all) {
      if (!processedNodes.has(n)) { pendingNodes.add(n); added++; }
    }
    if (added > 0) scheduleMutationTranslate();
  }, delay);
}
function scheduleMutationTranslate() {
  if (mutationTimer) return;
  mutationTimer = setTimeout(runMutationTranslate, MUTATION_DEBOUNCE_MS);
}
async function runMutationTranslate() {
  mutationTimer = null;
  if (!state.translated) { pendingNodes.clear(); return; }
  const nodes = [...pendingNodes].filter(
    (n) => n.isConnected && !processedNodes.has(n) && isCandidateText(n)
  );
  pendingNodes.clear();
  if (!nodes.length) return;

  const settings = await getSettings();
  const viewportFirst = settings.viewportFirst !== false;
  let visibleNodes = nodes;
  let offscreenNodes = [];
  if (viewportFirst) {
    visibleNodes = [];
    for (const n of nodes) {
      if (isInViewport(n.parentElement)) visibleNodes.push(n);
      else offscreenNodes.push(n);
    }
    if (visibleNodes.length === 0) {
      visibleNodes = nodes;
      offscreenNodes = [];
    }
  }

  const texts = visibleNodes.map((n) => n.nodeValue.trim());
  const applied = new Set();
  try {
    const cached = await requestTranslate(texts, { cacheOnly: true });
    if (cached.some(Boolean)) {
      applyTranslations(visibleNodes, cached, settings.displayMode, applied);
    }
  } catch (_) {}
  try {
    const full = await requestTranslate(texts);
    applyTranslations(visibleNodes, full, settings.displayMode, applied);
  } catch (err) {
    console.warn("[AI 翻译] 自动翻译新增内容失败:", err?.message || err);
  }

  if (offscreenNodes.length > 0) {
    observeOffscreenNodes(offscreenNodes);
  }
}

// ——— 自动翻译：页面载入后按设置触发 ———
let autoTriggered = false;
async function maybeAutoTranslate() {
  if (autoTriggered) return;
  if (window.top !== window.self) return; // 不在 iframe 里触发
  try {
    const settings = await getSettings();
    if (settings.enabled === false) return;
    const host = location.hostname.toLowerCase();
    const allowed = (settings.autoTranslateAllowlist || [])
      .map((h) => (h || "").toLowerCase())
      .some((h) => h && (host === h || host.endsWith("." + h)));
    if (!allowed) return;
    autoTriggered = true;
    // 略等片刻，让 DOM 稳定（许多站点在 load 之后继续注入内容）
    setTimeout(() => {
      if (!state.translated && !state.translating) translatePage();
    }, 400);
  } catch (_) {}
}
if (document.readyState === "complete" || document.readyState === "interactive") {
  maybeAutoTranslate();
} else {
  window.addEventListener("DOMContentLoaded", maybeAutoTranslate, { once: true });
}

chrome.storage?.onChanged?.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if ("enabled" in changes) {
    const enabled = changes.enabled.newValue !== false;
    if (!enabled) {
      if (state.translated) restorePage();
      unmountFab();
    } else {
      const s = await getSettings();
      if (s.showFab !== false) mountFab();
    }
  }
  if ("showFab" in changes) {
    const s = await getSettings();
    if (s.enabled === false) return;
    if (changes.showFab.newValue === false) unmountFab();
    else mountFab();
  }
});
