// background.js — service worker (smart 1-or-2-click apply-URL resolver)
//
// Resolution chain per Apply Directly URL:
//   1. fetch() with redirect:'follow'.
//      • If final URL is OFF hiring.cafe → done (single-click case).
//      • If final URL is BACK ON hiring.cafe → it's a detail page; go to step 2.
//   2. Open the (HTTP-resolved hiring.cafe) URL in a hidden tab. Inject a
//      finder that polls for an "Apply now" anchor and reads its href.
//   3. fetch() that Apply-now href to follow any final ATS-side redirects.
//   4. Fall back to a redirect-tracking hidden tab if any of the above stalls.
//
// All hidden tabs live in one minimized off-screen popup window so the
// user's main browser stays clean. Stop is instant: AbortController for
// fetches, force-finishers for tabs, plus we close the resolver window.

const STATE_KEY = "hiringcafe_state";
const RESULTS_KEY = "hiringcafe_results";

const FETCH_TIMEOUT_MS = 5000;
const TAB_RESOLVE_TIMEOUT_MS = 8000;
const TAB_POST_LOAD_QUIET_MS = 200;
const TAB_MAX_REDIRECT_HOPS = 8;
const MAX_CONCURRENT_TABS = 4;
const DETAIL_LOAD_TIMEOUT_MS = 10000;
const DETAIL_APPLY_POLL_INTERVAL_MS = 250;
const DETAIL_APPLY_POLL_MAX_ATTEMPTS = 30;
const REDIRECT_HOSTS = new Set(["hiring.cafe", "www.hiring.cafe"]);

let state = {
  status: "idle", pageIndex: 0, totalPages: null,
  scrapedThisPage: 0, totalScraped: 0, inFlight: 0,
  fetchHits: 0, tabHits: 0,
  lastError: null, startedAt: null, finishedAt: null, activeTabId: null
};

const activeAbortControllers = new Set();
const activeResolverTabs = new Set();
const activeResolverFinishers = new Set();
let resolverWindowId = null;
let cancelAll = false;

try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.warn("setPanelBehavior failed", e));
  }
} catch (e) { console.warn("sidePanel API missing", e); }

(async function hydrate() {
  try {
    const stored = await chrome.storage.local.get(STATE_KEY);
    if (stored && stored[STATE_KEY]) {
      state = { ...state, ...stored[STATE_KEY], inFlight: 0 };
      if (state.status === "running" || state.status === "stopping") state.status = "idle";
    }
  } catch (e) { console.warn("hydrate failed", e); }
})();

let persistTimer = null;
async function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try { await chrome.storage.local.set({ [STATE_KEY]: state }); }
    catch (e) { console.warn("persistState failed", e); }
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
  }, 60);
}

async function getResults() {
  const stored = await chrome.storage.local.get(RESULTS_KEY);
  return Array.isArray(stored[RESULTS_KEY]) ? stored[RESULTS_KEY] : [];
}

let pendingRows = [];
let rowFlushTimer = null;
function bufferRow(row) {
  pendingRows.push(row);
  if (rowFlushTimer) return;
  rowFlushTimer = setTimeout(flushRows, 200);
}
async function flushRows() {
  rowFlushTimer = null;
  if (pendingRows.length === 0) return;
  const batch = pendingRows; pendingRows = [];
  try {
    const results = await getResults();
    for (const r of batch) results.push(r);
    await chrome.storage.local.set({ [RESULTS_KEY]: results });
    state.totalScraped = results.length;
    persistState();
  } catch (e) {
    console.warn("flushRows failed", e);
    pendingRows = batch.concat(pendingRows);
  }
}

async function clearResults() {
  pendingRows = [];
  if (rowFlushTimer) { clearTimeout(rowFlushTimer); rowFlushTimer = null; }
  await chrome.storage.local.set({ [RESULTS_KEY]: [] });
  Object.assign(state, {
    totalScraped: 0, scrapedThisPage: 0, pageIndex: 0, totalPages: null,
    lastError: null, status: "idle", startedAt: null, finishedAt: null,
    fetchHits: 0, tabHits: 0, inFlight: 0
  });
  persistState();
}

class Semaphore {
  constructor(n) { this.permits = n; this.queue = []; }
  acquire() {
    if (this.permits > 0) { this.permits -= 1; return Promise.resolve(); }
    return new Promise((r) => this.queue.push(r));
  }
  release() {
    if (this.queue.length) this.queue.shift()();
    else this.permits += 1;
  }
}
const tabSem = new Semaphore(MAX_CONCURRENT_TABS);

function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch (_) { return ""; } }
function isAggregator(url) { return REDIRECT_HOSTS.has(hostOf(url)); }

async function fetchFollow(url) {
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled" };
  const ctrl = new AbortController();
  activeAbortControllers.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET", redirect: "follow",
      credentials: "include", cache: "no-store",
      signal: ctrl.signal
    });
    clearTimeout(timer);
    return { ok: true, finalUrl: resp.url || url };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false, finalUrl: null,
      error: e?.name === "AbortError"
        ? (cancelAll ? "cancelled" : "fetch timeout")
        : (e?.message || String(e))
    };
  } finally {
    activeAbortControllers.delete(ctrl);
  }
}

// ---- hidden resolver window ----
async function ensureResolverWindow() {
  if (resolverWindowId != null) {
    try { const w = await chrome.windows.get(resolverWindowId); if (w) return resolverWindowId; }
    catch (_) {}
    resolverWindowId = null;
  }
  try {
    const w = await chrome.windows.create({
      type: "popup", focused: false, url: "about:blank",
      left: -10000, top: -10000, width: 200, height: 200
    });
    resolverWindowId = w.id;
    try { await chrome.windows.update(w.id, { state: "minimized" }); } catch (_) {}
    return resolverWindowId;
  } catch (e) {
    console.warn("resolver window failed", e);
    resolverWindowId = null;
    return null;
  }
}
async function teardownResolverWindow() {
  if (resolverWindowId == null) return;
  try { await chrome.windows.remove(resolverWindowId); } catch (_) {}
  resolverWindowId = null;
}

// ---- redirect-tracking hidden tab (final fallback) ----
function resolveByTab(initialUrl) {
  return new Promise(async (resolve) => {
    if (cancelAll) { resolve({ ok: false, finalUrl: null, error: "cancelled" }); return; }
    const winId = await ensureResolverWindow();
    let tabId = null, finalUrl = initialUrl, hops = 0, settled = false, quietTimer = null;
    const hardTimer = setTimeout(() => finish("timeout"), TAB_RESOLVE_TIMEOUT_MS);
    const onUpdated = (uId, ci) => {
      if (uId !== tabId) return;
      if (ci.url) {
        finalUrl = ci.url; hops += 1;
        if (hops > TAB_MAX_REDIRECT_HOPS) finish("too many redirects");
      }
      if (ci.status === "complete") {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(null), TAB_POST_LOAD_QUIET_MS);
      }
    };
    const onRemoved = (rId) => { if (rId === tabId) finish(null); };
    function cleanup() {
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
      try { chrome.tabs.onRemoved.removeListener(onRemoved); } catch (_) {}
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (tabId != null) activeResolverTabs.delete(tabId);
      activeResolverFinishers.delete(finish);
    }
    function finish(error) {
      if (settled) return;
      settled = true; cleanup();
      const close = () => {
        if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
        resolve({ ok: !error, finalUrl, error: error || null });
      };
      if (tabId != null) {
        chrome.tabs.get(tabId).then((t) => { if (t && t.url) finalUrl = t.url; close(); }).catch(close);
      } else resolve({ ok: false, finalUrl: null, error: error || "no tab" });
    }
    activeResolverFinishers.add(finish);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const opts = { url: initialUrl, active: false };
    if (winId != null) opts.windowId = winId;
    chrome.tabs.create(opts).then((tab) => {
      tabId = tab.id; activeResolverTabs.add(tabId);
      finalUrl = tab.url || initialUrl;
    }).catch((e) => finish("create failed: " + (e?.message || e)));
  });
}

// ---- detail-page resolver (find Apply now anchor) ----
function findApplyNowOnDetailPage(pollInterval, maxAttempts) {
  return new Promise((resolve) => {
    let attempts = 0;
    const APPLY_RE = /^Apply\s*now\b/i;
    const SKIP_RE = /^(View All Jobs|Website|Full View|Save|Mark Applied|Hide Job|Report)\b/i;
    function check() {
      const anchors = document.querySelectorAll("a");
      for (const a of anchors) {
        const txt = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
        if (SKIP_RE.test(txt)) continue;
        if (APPLY_RE.test(txt) && a.href && !/^javascript:/i.test(a.href)) {
          resolve({ href: a.href, label: txt, kind: "anchor" }); return;
        }
      }
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        const txt = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
        if (SKIP_RE.test(txt)) continue;
        if (APPLY_RE.test(txt)) {
          for (const k of ["data-url", "data-href", "data-apply-url", "data-link"]) {
            const v = b.getAttribute(k);
            if (v && /^https?:/i.test(v)) { resolve({ href: v, label: txt, kind: "button-data" }); return; }
          }
          resolve({ href: null, label: txt, kind: "button-no-href" }); return;
        }
      }
      attempts += 1;
      if (attempts < maxAttempts) setTimeout(check, pollInterval);
      else resolve({ href: null, label: "Apply now not found", kind: "missing" });
    }
    check();
  });
}

async function resolveByDetailPage(detailUrl) {
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled" };
  if (!detailUrl) return { ok: false, finalUrl: null, error: "no detail url" };
  const winId = await ensureResolverWindow();
  let tabId = null;
  try {
    const opts = { url: detailUrl, active: false };
    if (winId != null) opts.windowId = winId;
    const tab = await chrome.tabs.create(opts);
    tabId = tab.id;
    activeResolverTabs.add(tabId);

    await new Promise((resolve) => {
      let done = false;
      const onUpdated = (id, ci) => { if (id === tabId && ci.status === "complete") finish(); };
      function finish() {
        if (done) return; done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
        resolve();
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(finish, DETAIL_LOAD_TIMEOUT_MS);
    });
    if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled" };

    const inj = await chrome.scripting.executeScript({
      target: { tabId },
      func: findApplyNowOnDetailPage,
      args: [DETAIL_APPLY_POLL_INTERVAL_MS, DETAIL_APPLY_POLL_MAX_ATTEMPTS],
      world: "MAIN"
    });
    const r = inj && inj[0] && inj[0].result;
    if (!r || !r.href) {
      return { ok: false, finalUrl: null, error: (r && r.kind) ? ("apply now: " + r.kind) : "apply now not resolvable" };
    }
    return { ok: true, finalUrl: r.href, kind: r.kind, label: r.label };
  } catch (e) {
    return { ok: false, finalUrl: null, error: "detail open failed: " + (e?.message || e) };
  } finally {
    if (tabId != null) {
      activeResolverTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

// ---- master resolver ----
async function resolveJobUrl(applyDirectlyUrl) {
  if (!applyDirectlyUrl) return { ok: false, finalUrl: null, error: "empty url", method: "none" };
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled", method: "none" };
  state.inFlight += 1; persistState();
  try {
    // Step 1: fetch the Apply Directly URL.
    const f1 = await fetchFollow(applyDirectlyUrl);
    if (!f1.ok && !f1.finalUrl) {
      // Network failure — go straight to tab fallback.
      await tabSem.acquire();
      try {
        const t = await resolveByTab(applyDirectlyUrl);
        state.tabHits += 1;
        return { ok: t.ok, finalUrl: t.finalUrl, applyInitial: applyDirectlyUrl, method: t.ok ? "tab" : ("tab:" + (t.error || "fail")) };
      } finally { tabSem.release(); }
    }

    // Step 1a: fetch landed off-aggregator → that's the real ATS URL. Done.
    if (f1.ok && !isAggregator(f1.finalUrl)) {
      state.fetchHits += 1;
      return { ok: true, finalUrl: f1.finalUrl, applyInitial: applyDirectlyUrl, method: "fetch", kind: "single-click" };
    }

    // Step 2: fetch landed on hiring.cafe → it's a detail page. Two-click.
    const detailUrl = f1.finalUrl || applyDirectlyUrl;
    if (cancelAll) return { ok: false, finalUrl: detailUrl, error: "cancelled", method: "fetch" };

    await tabSem.acquire();
    let applyNowUrl = null, applyNowKind = "";
    try {
      if (cancelAll) return { ok: false, finalUrl: detailUrl, error: "cancelled", method: "fetch" };
      const d = await resolveByDetailPage(detailUrl);
      if (!d.ok) {
        // Fall back to tab redirect-tracking on the detail URL itself.
        const t = await resolveByTab(detailUrl);
        state.tabHits += 1;
        return { ok: t.ok && !isAggregator(t.finalUrl), finalUrl: t.finalUrl, applyInitial: detailUrl, method: t.ok ? "detail-fail+tab" : ("tab:" + (t.error || "fail")), kind: "tab-fallback" };
      }
      applyNowUrl = d.finalUrl;
      applyNowKind = d.kind || "";
    } finally { tabSem.release(); }

    if (cancelAll) return { ok: false, finalUrl: applyNowUrl, error: "cancelled", method: "detail" };

    // Step 3: fetch the Apply now href.
    const f2 = await fetchFollow(applyNowUrl);
    if (f2.ok && !isAggregator(f2.finalUrl)) {
      state.fetchHits += 1;
      return { ok: true, finalUrl: f2.finalUrl, applyInitial: applyNowUrl, method: "detail+fetch", kind: applyNowKind };
    }

    // Step 4: tab redirect-tracking on the Apply now href.
    if (cancelAll) return { ok: false, finalUrl: f2.finalUrl || applyNowUrl, error: "cancelled", method: "detail+fetch" };
    await tabSem.acquire();
    try {
      if (cancelAll) return { ok: false, finalUrl: f2.finalUrl || applyNowUrl, error: "cancelled", method: "detail+fetch" };
      const t = await resolveByTab(f2.finalUrl || applyNowUrl);
      state.tabHits += 1;
      return { ok: t.ok && !isAggregator(t.finalUrl), finalUrl: t.finalUrl, applyInitial: applyNowUrl, method: t.ok ? "detail+tab" : ("detail+tab:" + (t.error || "fail")), kind: applyNowKind };
    } finally { tabSem.release(); }
  } finally {
    state.inFlight -= 1; persistState();
  }
}

async function abortAllResolutions() {
  cancelAll = true;
  for (const ctrl of Array.from(activeAbortControllers)) { try { ctrl.abort(); } catch (_) {} }
  activeAbortControllers.clear();
  for (const f of Array.from(activeResolverFinishers)) { try { f("cancelled"); } catch (_) {} }
  activeResolverFinishers.clear();
  for (const id of Array.from(activeResolverTabs)) { chrome.tabs.remove(id).catch(() => {}); }
  activeResolverTabs.clear();
  await teardownResolverWindow();
}
function resetCancelFlag() { cancelAll = false; }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "GET_STATE": {
          await flushRows();
          const results = await getResults();
          sendResponse({ ok: true, state, resultCount: results.length });
          return;
        }
        case "START_SCRAPE": {
          const tabs = await chrome.tabs.query({ url: ["https://hiring.cafe/*", "https://*.hiring.cafe/*"] });
          if (!tabs.length) { sendResponse({ ok: false, error: "Open hiring.cafe in a tab first." }); return; }
          tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          const target = tabs[0];
          await clearResults();
          resetCancelFlag();
          state.status = "running";
          state.startedAt = Date.now();
          state.activeTabId = target.id;
          state.fetchHits = 0; state.tabHits = 0;
          persistState();
          chrome.tabs.sendMessage(target.id, { type: "BEGIN_SCRAPE", options: msg.options || {} })
            .catch(async () => {
              try {
                await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
                await chrome.tabs.sendMessage(target.id, { type: "BEGIN_SCRAPE", options: msg.options || {} });
              } catch (e2) {
                state.status = "error";
                state.lastError = "Could not reach content script: " + (e2?.message || e2);
                persistState();
              }
            });
          sendResponse({ ok: true });
          return;
        }
        case "STOP_SCRAPE": {
          state.status = "stopping"; persistState();
          if (state.activeTabId != null) chrome.tabs.sendMessage(state.activeTabId, { type: "ABORT_SCRAPE" }).catch(() => {});
          await abortAllResolutions();
          state.status = "idle";
          state.finishedAt = Date.now();
          state.activeTabId = null;
          persistState();
          sendResponse({ ok: true });
          return;
        }
        case "CLEAR_RESULTS": { await clearResults(); sendResponse({ ok: true }); return; }
        case "RESOLVE_URL": { const r = await resolveJobUrl(msg.url); sendResponse(r); return; }
        case "JOB_SCRAPED": { bufferRow(msg.row); sendResponse({ ok: true }); return; }
        case "PAGE_PROGRESS": {
          state.pageIndex = msg.pageIndex ?? state.pageIndex;
          state.totalPages = msg.totalPages ?? state.totalPages;
          state.scrapedThisPage = msg.scrapedThisPage ?? 0;
          if (msg.status) state.status = msg.status;
          persistState();
          sendResponse({ ok: true });
          return;
        }
        case "SCRAPE_DONE": {
          await flushRows();
          state.status = msg.error ? "error" : "done";
          state.lastError = msg.error || null;
          state.finishedAt = Date.now();
          state.activeTabId = null;
          await teardownResolverWindow();
          persistState();
          sendResponse({ ok: true });
          return;
        }
        case "GET_RESULTS": {
          await flushRows();
          const results = await getResults();
          sendResponse({ ok: true, results });
          return;
        }
        case "START_PICKER": {
          const tabs = await chrome.tabs.query({ url: ["https://hiring.cafe/*", "https://*.hiring.cafe/*"] });
          if (!tabs.length) { sendResponse({ ok: false, error: "Open hiring.cafe in a tab first." }); return; }
          tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          const target = msg.tabId ? (tabs.find((t) => t.id === msg.tabId) || tabs[0]) : tabs[0];
          try { await chrome.tabs.sendMessage(target.id, { type: "START_PICKER" }); }
          catch (_) {
            try {
              await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
              await chrome.tabs.sendMessage(target.id, { type: "START_PICKER" });
            } catch (e) {
              sendResponse({ ok: false, error: "Could not start picker: " + (e?.message || e) });
              return;
            }
          }
          sendResponse({ ok: true });
          return;
        }
        case "ELEMENT_PICKED": {
          chrome.runtime.sendMessage({ type: "ELEMENT_PICKED", spec: msg.spec }).catch(() => {});
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (e) {
      console.error("background error", e);
      try { sendResponse({ ok: false, error: e?.message || String(e) }); } catch (_) {}
    }
  })();
  return true;
});

chrome.windows.onRemoved.addListener((id) => { if (id === resolverWindowId) resolverWindowId = null; });
