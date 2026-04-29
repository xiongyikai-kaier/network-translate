const $ = (id) => document.getElementById(id);

let currentHost = "";

async function loadModels() {
  const select = $("active-model");
  if (!select) return;

  try {
    const [modelsResp, settingsResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_MODELS" }),
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" })
    ]);

    const models = modelsResp?.models || [];
    const activeId = settingsResp?.settings?.activeModelId;

    const currentValue = select.value;
    select.innerHTML = '<option value="">默认配置</option>';
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === activeId || (!activeId && m.id === currentValue)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  } catch (_) {}
}

async function load() {
  const s = await chrome.storage.sync.get({
    enabled: true,
    targetLang: "中文（简体）",
    displayMode: "bilingual",
    showFab: true,
    inlineSelection: true,
    autoTranslateAllowlist: []
  });
  $("toggle-enabled").checked = s.enabled !== false;
  $("target-lang").value = s.targetLang;
  $("display-mode").value = s.displayMode;
  $("toggle-fab").checked = s.showFab !== false;
  $("toggle-inline-selection").checked = s.inlineSelection !== false;

  await loadModels();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentHost = hostOf(tab?.url || "");
  renderSiteAuto(s.autoTranslateAllowlist || []);
  renderEnabledState();
}

async function saveBasics() {
  await chrome.storage.sync.set({
    enabled: $("toggle-enabled").checked,
    targetLang: $("target-lang").value,
    displayMode: $("display-mode").value,
    showFab: $("toggle-fab").checked,
    inlineSelection: $("toggle-inline-selection").checked
  });
  renderEnabledState();
}

function renderSiteAuto(list) {
  const hostEl = $("site-host");
  const toggle = $("toggle-auto");
  if (!currentHost) {
    hostEl.textContent = "（不支持当前页）";
    hostEl.classList.add("empty");
    hostEl.title = "";
    toggle.checked = false;
    toggle.disabled = true;
    return;
  }
  hostEl.textContent = currentHost;
  hostEl.classList.remove("empty");
  hostEl.title = currentHost;
  toggle.disabled = false;
  toggle.checked = (list || []).map((h) => (h || "").toLowerCase()).includes(currentHost);
}

async function toggleSiteAuto() {
  if (!currentHost) return;
  const { autoTranslateAllowlist = [] } = await chrome.storage.sync.get({
    autoTranslateAllowlist: []
  });
  const set = new Set(autoTranslateAllowlist.map((h) => (h || "").toLowerCase()));
  if ($("toggle-auto").checked) set.add(currentHost);
  else set.delete(currentHost);
  await chrome.storage.sync.set({ autoTranslateAllowlist: [...set] });
}

function renderEnabledState() {
  const on = $("toggle-enabled").checked;
  const panel = $("main-panel");
  const master = panel?.previousElementSibling; // .row.master
  if (on) {
    panel.removeAttribute("disabled");
    master?.classList.remove("off");
    $("enabled-label").textContent = "已启用";
  } else {
    panel.setAttribute("disabled", "");
    master?.classList.add("off");
    $("enabled-label").textContent = "已关闭";
  }
}

function hostOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "";
    return u.hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

async function sendToActive(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const url = tab.url || "";
  if (/^(chrome|edge|about|chrome-extension|view-source):/i.test(url) ||
      url.startsWith("https://chrome.google.com/webstore") ||
      url.startsWith("https://chromewebstore.google.com")) {
    alert("当前页面不支持翻译（浏览器内部页或应用商店页）");
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    // 扩展装好/升级后，老标签没注入 content script — 动态注入后重试
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ["content.js"]
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id, allFrames: false },
        files: ["content.css"]
      });
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch (err) {
      alert(`当前页面无法注入翻译脚本：${err?.message || err}`);
    }
  }
}

async function detectIsMac() {
  // userAgentData 更可靠；老 Chrome 回退到 navigator.platform
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const d = await navigator.userAgentData.getHighEntropyValues(["platform"]);
      if (d?.platform) return /mac/i.test(d.platform);
    }
    if (navigator.userAgentData?.platform) return /mac/i.test(navigator.userAgentData.platform);
  } catch (_) {}
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
}

function formatShortcut(shortcut, isMac) {
  if (!shortcut) return "未设置";
  // Chrome 返回形如 "Alt+T" / "Ctrl+Shift+Y" / "⌘+Shift+Y"
  const parts = shortcut.split("+").map((s) => s.trim());
  const macMap = { Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Command: "⌘", MacCtrl: "⌃" };
  const winMap = { Command: "Win", MacCtrl: "Ctrl" };
  return parts
    .map((p) => {
      if (isMac) return macMap[p] || p;
      return winMap[p] || p;
    })
    .join(isMac ? "" : "+");
}

async function renderShortcutHint() {
  const el = document.getElementById("shortcut-hint");
  if (!el) return;
  const [isMac, commands] = await Promise.all([detectIsMac(), chrome.commands.getAll()]);
  const byName = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
  const page = formatShortcut(byName["translate-page"], isMac);
  const sel = formatShortcut(byName["translate-selection"], isMac);
  const anyMissing = !byName["translate-page"] || !byName["translate-selection"];
  el.innerHTML =
    `快捷键：<b>${page}</b> 翻译整页 · <b>${sel}</b> 翻译选区` +
    (anyMissing ? '<br /><a id="open-shortcuts" href="#">去设置快捷键</a>' : "");
  document.getElementById("open-shortcuts")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}

async function doQuickTranslate() {
  const input = $("quick-input").value.trim();
  const out = $("quick-output");
  if (!input) {
    $("quick-input").focus();
    return;
  }
  out.hidden = false;
  out.classList.remove("error");
  out.classList.add("loading");
  out.textContent = "翻译中…";
  $("btn-quick-translate").disabled = true;
  $("btn-quick-copy").disabled = true;
  try {
    const s = await chrome.storage.sync.get({ targetLang: "中文（简体）" });
    const resp = await chrome.runtime.sendMessage({
      type: "LLM_TRANSLATE",
      payload: { texts: input, targetLang: s.targetLang, saveToHistory: true }
    });
    if (!resp?.ok) throw new Error(resp?.error || "翻译失败");
    const text = Array.isArray(resp.result) ? resp.result[0] : resp.result;
    out.classList.remove("loading");
    out.textContent = text || "";
    $("btn-quick-copy").disabled = !text;
  } catch (err) {
    out.classList.remove("loading");
    out.classList.add("error");
    out.textContent = String(err?.message || err);
  } finally {
    $("btn-quick-translate").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  renderShortcutHint();
  $("toggle-enabled").addEventListener("change", saveBasics);
  $("target-lang").addEventListener("change", saveBasics);
  $("display-mode").addEventListener("change", saveBasics);
  $("toggle-fab").addEventListener("change", saveBasics);
  $("toggle-inline-selection").addEventListener("change", saveBasics);
  $("toggle-auto").addEventListener("change", toggleSiteAuto);

  $("active-model")?.addEventListener("change", async () => {
    const id = $("active-model").value;
    try {
      await chrome.runtime.sendMessage({
        type: "ACTIVATE_MODEL",
        payload: { id: id || null }
      });
    } catch (_) {}
  });

  $("btn-quick-translate").addEventListener("click", doQuickTranslate);
  $("quick-input").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      doQuickTranslate();
    }
  });
  $("btn-quick-copy").addEventListener("click", async () => {
    const text = $("quick-output").textContent || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = $("btn-quick-copy");
      const prev = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = prev), 1200);
    } catch (_) {}
  });
  $("btn-quick-clear").addEventListener("click", () => {
    $("quick-input").value = "";
    $("quick-output").hidden = true;
    $("quick-output").textContent = "";
    $("btn-quick-copy").disabled = true;
    $("quick-input").focus();
  });
  $("btn-translate").addEventListener("click", async () => {
    await saveBasics();
    // 不等待翻译完成，立刻关 popup（整页翻译可能耗时数秒）
    sendToActive({ type: "TRANSLATE_PAGE" });
    window.close();
  });
  $("btn-restore").addEventListener("click", () => {
    sendToActive({ type: "RESTORE_PAGE" });
    window.close();
  });
  const openOpts = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  $("open-options").addEventListener("click", openOpts);
  $("open-options-2").addEventListener("click", openOpts);

  $("open-history")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
    window.close();
  });
});
