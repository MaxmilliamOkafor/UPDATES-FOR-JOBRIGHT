// popup.js — UI for HiringCafe Scraper (two-picker, single-line CSV)

const SETTINGS_KEY = "hiringcafe_settings";

const els = {
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  exportBtn: document.getElementById("export-btn"),
  clearBtn: document.getElementById("clear-btn"),
  pickBtn: document.getElementById("pick-btn"),
  pickClearBtn: document.getElementById("pick-clear-btn"),
  pickerResult: document.getElementById("picker-result"),
  pickPaginationBtn: document.getElementById("pick-pagination-btn"),
  pickPaginationClearBtn: document.getElementById("pick-pagination-clear-btn"),
  pickerPaginationResult: document.getElementById("picker-pagination-result"),
  statusPill: document.getElementById("status-pill"),
  pageProgress: document.getElementById("page-progress"),
  scrapedCount: document.getElementById("scraped-count"),
  pageCount: document.getElementById("page-count"),
  inflightCount: document.getElementById("inflight-count"),
  fastCount: document.getElementById("fast-count"),
  tabCount: document.getElementById("tab-count"),
  errorRow: document.getElementById("error-row"),
  strategyRadios: document.querySelectorAll('input[name="strategy"]')
};

const CSV_COLUMNS = [
  { key: "url", label: "URL" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "location", label: "Location" },
  { key: "salary", label: "Salary" },
  { key: "work_mode", label: "Work mode" },
  { key: "commitment", label: "Commitment" },
  { key: "yoe", label: "Years of experience" },
  { key: "posted_age", label: "Posted" },
  { key: "description", label: "Description" },
  { key: "skills", label: "Skills" },
  { key: "job_posting_initial_url", label: "Source URL" },
  { key: "hiringcafe_viewall_url", label: "HiringCafe URL" },
  { key: "status", label: "Status" },
  { key: "method", label: "Method" },
  { key: "scraped_at", label: "Scraped at" }
];

// Single-line CSV cells (Ultimate-Web-Scraper style): collapse newlines to a
// single space inside each cell, RFC-4180 quote any cell containing comma /
// double-quote / leading-or-trailing whitespace. No BOM in output.
function csvEscape(v) {
  if (v == null) return "";
  const raw = String(v);
  let s = raw.replace(/\r\n|\r|\n/g, " ").replace(/\s{2,}/g, " ").trim();
  if (/[",]/.test(s) || s !== raw.trim()) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function rowsToCsv(rows) {
  const header = CSV_COLUMNS.map((c) => csvEscape(c.label)).join(",");
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c.key])).join(",")).join("\n");
  return header + "\n" + body + "\n";
}
function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      void chrome.runtime.lastError; resolve(resp);
    });
  });
}

async function loadSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return r[SETTINGS_KEY] || { strategy: "pagination", columnSpec: null, paginationSpec: null };
}
async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function setStatusPill(status) {
  const map = {
    idle:     ["pill-idle", "Idle"],
    running:  ["pill-running", "Running"],
    stopping: ["pill-stopping", "Stopping…"],
    done:     ["pill-done", "Done"],
    error:    ["pill-error", "Error"]
  };
  const [cls, label] = map[status] || map.idle;
  els.statusPill.className = "pill " + cls;
  els.statusPill.textContent = label;
}

function render(state, resultCount) {
  setStatusPill(state.status);
  if (state.totalPages) els.pageProgress.textContent = `${state.pageIndex || 0}/${state.totalPages}`;
  else if (state.pageIndex) els.pageProgress.textContent = `${state.pageIndex}`;
  else els.pageProgress.textContent = "—";
  els.scrapedCount.textContent = String(resultCount);
  els.pageCount.textContent = String(state.scrapedThisPage || 0);
  els.inflightCount.textContent = String(state.inFlight || 0);
  els.fastCount.textContent = String(state.fetchHits || 0);
  els.tabCount.textContent = String(state.tabHits || 0);
  if (state.lastError) { els.errorRow.textContent = state.lastError; els.errorRow.hidden = false; }
  else els.errorRow.hidden = true;
  const isRunning = state.status === "running" || state.status === "stopping";
  els.startBtn.disabled = isRunning;
  els.stopBtn.disabled = !isRunning;
  els.exportBtn.disabled = resultCount === 0;
  els.pickBtn.disabled = isRunning;
  els.pickPaginationBtn.disabled = isRunning;
  for (const r of els.strategyRadios) r.disabled = isRunning;
}

function renderSinglePicker(spec, resultEl, clearBtn) {
  if (spec) {
    const label = spec.label || spec.text || spec.ariaLabel || spec.tag || "element";
    resultEl.className = "picker-result picker-locked";
    resultEl.textContent = `Locked: ${label}`;
    clearBtn.disabled = false;
  } else {
    resultEl.className = "picker-result picker-empty";
    resultEl.textContent = "No element selected — auto-detect will be used.";
    clearBtn.disabled = true;
  }
}
function renderPickers(settings) {
  renderSinglePicker(settings.columnSpec, els.pickerResult, els.pickClearBtn);
  renderSinglePicker(settings.paginationSpec, els.pickerPaginationResult, els.pickPaginationClearBtn);
}

function setStrategy(value) {
  for (const r of els.strategyRadios) r.checked = r.value === value;
}

async function refresh() {
  const settings = await loadSettings();
  setStrategy(settings.strategy || "pagination");
  renderPickers(settings);
  const resp = await send("GET_STATE");
  if (!resp || !resp.ok) { setStatusPill("idle"); return; }
  render(resp.state, resp.resultCount);
}

els.strategyRadios.forEach((r) => {
  r.addEventListener("change", async () => { await saveSettings({ strategy: r.value }); });
});

async function startPickerMode(mode) {
  els.errorRow.hidden = true;
  const tabs = await chrome.tabs.query({ url: ["https://hiring.cafe/*", "https://*.hiring.cafe/*"] });
  if (!tabs.length) {
    els.errorRow.textContent = "Open hiring.cafe in a tab first.";
    els.errorRow.hidden = false;
    return;
  }
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const target = tabs[0];
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
  const resp = await send("START_PICKER", { tabId: target.id, mode });
  if (!resp || !resp.ok) {
    els.errorRow.textContent = (resp && resp.error) || "Could not start picker.";
    els.errorRow.hidden = false;
  }
}

els.pickBtn.addEventListener("click", () => startPickerMode("column"));
els.pickPaginationBtn.addEventListener("click", () => startPickerMode("pagination"));

els.pickClearBtn.addEventListener("click", async () => {
  const s = await saveSettings({ columnSpec: null });
  renderPickers(s);
});
els.pickPaginationClearBtn.addEventListener("click", async () => {
  const s = await saveSettings({ paginationSpec: null });
  renderPickers(s);
});

els.startBtn.addEventListener("click", async () => {
  els.errorRow.hidden = true;
  els.startBtn.disabled = true;
  const settings = await loadSettings();
  if (settings.strategy === "loadmore" && !settings.paginationSpec) {
    els.errorRow.textContent = "Pick the Load More button first (use the Pagination picker above).";
    els.errorRow.hidden = false;
    els.startBtn.disabled = false;
    return;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isHc = active && active.url && /hiring\.cafe/.test(active.url);
  if (!isHc) {
    const tabs = await chrome.tabs.query({ url: ["https://hiring.cafe/*", "https://*.hiring.cafe/*"] });
    if (!tabs.length) {
      els.errorRow.textContent = "Open hiring.cafe in a tab first.";
      els.errorRow.hidden = false;
      els.startBtn.disabled = false;
      return;
    }
  }
  const resp = await send("START_SCRAPE", {
    options: {
      strategy: settings.strategy || "pagination",
      columnSpec: settings.columnSpec || null,
      paginationSpec: settings.paginationSpec || null
    }
  });
  if (!resp || !resp.ok) {
    els.errorRow.textContent = (resp && resp.error) || "Could not start scrape.";
    els.errorRow.hidden = false;
    els.startBtn.disabled = false;
  }
  await refresh();
});

els.stopBtn.addEventListener("click", async () => { els.stopBtn.disabled = true; await send("STOP_SCRAPE"); await refresh(); });
els.clearBtn.addEventListener("click", async () => { await send("CLEAR_RESULTS"); await refresh(); });
els.exportBtn.addEventListener("click", async () => {
  const resp = await send("GET_RESULTS");
  if (!resp || !resp.ok || !resp.results || resp.results.length === 0) {
    els.errorRow.textContent = "No results to export yet.";
    els.errorRow.hidden = false;
    return;
  }
  const csv = rowsToCsv(resp.results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadCsv(csv, `hiringcafe-jobs-${stamp}.csv`);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "STATE_UPDATE") refresh();
  if (msg && msg.type === "ELEMENT_PICKED") refresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) refresh();
});

refresh();
