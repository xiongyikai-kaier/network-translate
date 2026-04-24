const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get({
    enabled: true,
    targetLang: "中文（简体）",
    displayMode: "bilingual",
    showFab: true,
    autoTranslate: false
  });
  $("toggle-enabled").checked = s.enabled !== false;
  $("target-lang").value = s.targetLang;
  $("display-mode").value = s.displayMode;
  $("toggle-fab").checked = s.showFab !== false;
  $("toggle-auto").checked = !!s.autoTranslate;
  renderEnabledState();
}

async function save() {
  await chrome.storage.sync.set({
    enabled: $("toggle-enabled").checked,
    targetLang: $("target-lang").value,
    displayMode: $("display-mode").value,
    showFab: $("toggle-fab").checked,
    autoTranslate: $("toggle-auto").checked
  });
  renderSiteRule();
  renderEnabledState();
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
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

async function renderSiteRule() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(tab?.url || "");
  const autoOn = $("toggle-auto").checked;
  const row = $("site-rule");
  if (!autoOn || !host) { row.hidden = true; return; }
  const { autoTranslateBlocklist = [] } =
    await chrome.storage.sync.get({ autoTranslateBlocklist: [] });
  const blocked = autoTranslateBlocklist.includes(host);
  row.hidden = false;
  $("site-host").textContent = host;
  $("site-host").title = host;
  $("site-toggle").textContent = blocked ? "在本站启用自动翻译" : "在本站停用自动翻译";
  $("site-toggle").dataset.host = host;
  $("site-toggle").dataset.blocked = blocked ? "1" : "0";
}

async function toggleSiteRule() {
  const host = $("site-toggle").dataset.host;
  if (!host) return;
  const { autoTranslateBlocklist = [] } =
    await chrome.storage.sync.get({ autoTranslateBlocklist: [] });
  const set = new Set(autoTranslateBlocklist);
  if (set.has(host)) set.delete(host);
  else set.add(host);
  await chrome.storage.sync.set({ autoTranslateBlocklist: [...set] });
  renderSiteRule();
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
      payload: { texts: input, targetLang: s.targetLang }
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
  $("toggle-enabled").addEventListener("change", save);
  $("target-lang").addEventListener("change", save);
  $("display-mode").addEventListener("change", save);
  $("toggle-fab").addEventListener("change", save);
  $("toggle-auto").addEventListener("change", save);
  $("site-toggle").addEventListener("click", toggleSiteRule);
  renderSiteRule();

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
    await save();
    await sendToActive({ type: "TRANSLATE_PAGE" });
    window.close();
  });
  $("btn-restore").addEventListener("click", async () => {
    await sendToActive({ type: "RESTORE_PAGE" });
    window.close();
  });
  const openOpts = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  $("open-options").addEventListener("click", openOpts);
  $("open-options-2").addEventListener("click", openOpts);
});
