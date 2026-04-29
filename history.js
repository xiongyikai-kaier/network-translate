const $ = (id) => document.getElementById(id);

let currentHistory = [];

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
  if (kind !== "ok" && kind !== "err") {
    setTimeout(() => setStatus(""), 2000);
  }
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}

function truncateText(text, maxLen = 200) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function tryParseJson(text) {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.join("\n");
    }
    return text;
  } catch (_) {
    return text;
  }
}

function renderHistory(list) {
  const container = $("history-list");
  currentHistory = list || [];

  if (!currentHistory.length) {
    container.innerHTML = '<div class="history-empty">暂无翻译历史记录</div>';
    return;
  }

  container.innerHTML = currentHistory
    .map((item, idx) => {
      const original = tryParseJson(item.original);
      const translated = tryParseJson(item.translated);
      const typeLabel = item.type === "page" ? "整页" : "文本";
      const langLabel = item.sourceLang === "auto" ? "自动" : item.sourceLang;

      return `
        <div class="history-item" data-id="${item.id}">
          <div class="history-header">
            <div class="history-meta">
              <span class="history-type">${typeLabel}</span>
              <span>${langLabel} → ${item.targetLang || "中文"}</span>
              <span>${formatDate(item.ts)}</span>
            </div>
            <div class="history-actions">
              <button class="btn-retranslate" data-idx="${idx}">重新翻译</button>
              <button class="btn-copy" data-idx="${idx}">复制译文</button>
              <button class="btn-delete" data-idx="${idx}" style="border-color:#f1b2ac;color:#c0271d;">删除</button>
            </div>
          </div>
          <div class="history-content">
            <div class="history-col">
              <div class="history-label">原文</div>
              <div class="history-text">${truncateText(original)}</div>
            </div>
            <div class="history-col">
              <div class="history-label">译文</div>
              <div class="history-text">${truncateText(translated)}</div>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".btn-retranslate").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      retranslateItem(idx);
    });
  });

  container.querySelectorAll(".btn-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      copyTranslation(idx);
    });
  });

  container.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      deleteItem(idx);
    });
  });
}

async function loadHistory() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "HISTORY_LIST", payload: { limit: 200 } });
    if (resp?.ok) {
      renderHistory(resp.list);
      setStatus(`共 ${resp.list.length} 条记录`);
    }
  } catch (err) {
    setStatus(`加载失败：${err?.message || err}`, "err");
  }
}

async function searchHistory() {
  const keyword = $("search-input").value.trim();
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "HISTORY_SEARCH",
      payload: { keyword }
    });
    if (resp?.ok) {
      renderHistory(resp.list);
      setStatus(keyword ? `找到 ${resp.list.length} 条结果` : `共 ${resp.list.length} 条记录`);
    }
  } catch (err) {
    setStatus(`搜索失败：${err?.message || err}`, "err");
  }
}

async function retranslateItem(idx) {
  const item = currentHistory[idx];
  if (!item) return;

  const original = tryParseJson(item.original);
  setStatus("重新翻译中…");

  try {
    const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    const targetLang = settings?.settings?.targetLang || item.targetLang || "中文（简体）";

    const resp = await chrome.runtime.sendMessage({
      type: "LLM_TRANSLATE",
      payload: {
        texts: original,
        targetLang: targetLang,
        sourceLang: item.sourceLang || "auto",
        saveToHistory: true
      }
    });

    if (!resp?.ok) throw new Error(resp?.error || "翻译失败");

    const result = Array.isArray(resp.result) ? resp.result.join("\n") : resp.result;
    setStatus("翻译完成", "ok");

    const itemEl = document.querySelector(`.history-item[data-id="${item.id}"]`);
    if (itemEl) {
      const transEl = itemEl.querySelector(".history-col:last-child .history-text");
      if (transEl) {
        transEl.textContent = truncateText(result);
      }
    }
  } catch (err) {
    setStatus(`翻译失败：${err?.message || err}`, "err");
  }
}

async function copyTranslation(idx) {
  const item = currentHistory[idx];
  if (!item) return;

  const translated = tryParseJson(item.translated);
  try {
    await navigator.clipboard.writeText(translated);
    setStatus("已复制到剪贴板", "ok");
  } catch (err) {
    setStatus(`复制失败：${err?.message || err}`, "err");
  }
}

async function deleteItem(idx) {
  const item = currentHistory[idx];
  if (!item) return;

  try {
    await chrome.runtime.sendMessage({
      type: "HISTORY_DELETE",
      payload: { id: item.id }
    });
    await loadHistory();
    setStatus("已删除", "ok");
  } catch (err) {
    setStatus(`删除失败：${err?.message || err}`, "err");
  }
}

async function clearAllHistory() {
  if (!confirm("确定要清空所有翻译历史记录吗？此操作不可恢复。")) return;

  try {
    await chrome.runtime.sendMessage({ type: "HISTORY_CLEAR" });
    await loadHistory();
    setStatus("已清空全部历史", "ok");
  } catch (err) {
    setStatus(`清空失败：${err?.message || err}`, "err");
  }
}

// ——— 多模型切换 ———
async function loadModels() {
  const select = $("activeModel");
  try {
    const [modelsResp, settingsResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_MODELS" }),
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" })
    ]);

    const models = modelsResp?.models || [];
    const activeId = settingsResp?.settings?.activeModelId;

    select.innerHTML = '<option value="">默认配置</option>';
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === activeId) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (_) {}
}

async function activateModel(id) {
  try {
    await chrome.runtime.sendMessage({
      type: "ACTIVATE_MODEL",
      payload: { id: id || null }
    });
    setStatus(id ? "已切换模型" : "已恢复默认配置", "ok");
  } catch (err) {
    setStatus(`切换失败：${err?.message || err}`, "err");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadHistory();
  await loadModels();

  $("btn-refresh").addEventListener("click", loadHistory);
  $("btn-search").addEventListener("click", searchHistory);
  $("btn-clear-all").addEventListener("click", clearAllHistory);
  $("btn-open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      searchHistory();
    }
  });

  $("activeModel").addEventListener("change", () => {
    activateModel($("activeModel").value);
  });
});
