// background.js — service worker (v1.9.1 — smarter detail-page apply finder)

const STATE_KEY = "hiringcafe_state";
const RESULTS_KEY = "hiringcafe_results";

const FETCH_TIMEOUT_MS = 5000;
const TAB_RESOLVE_TIMEOUT_MS = 8000;
const TAB_POST_LOAD_QUIET_MS = 200;
const TAB_MAX_REDIRECT_HOPS = 8;
const MAX_CONCURRENT_TABS = 4;
const DETAIL_LOAD_TIMEOUT_MS = 15000;
const DETAIL_APPLY_POLL_INTERVAL_MS = 250;
const DETAIL_APPLY_POLL_MAX_ATTEMPTS = 60;
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
      error: e?.name === "AbortError" ? (cancelAll ? "cancelled" : "fetch timeout") : (e?.message || String(e))
    };
  } finally { activeAbortControllers.delete(ctrl); }
}

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

// ---- detail-page apply-URL finder (runs in detail tab) ----
function findApplyNowOnDetailPage(pollInterval, maxAttempts) {
  return new Promise((resolve) => {
    let attempts = 0;
    const APPLY_RE = /^Apply\s*(now|directly)?\b/i;
    const SKIP_RE = /^(View All Jobs|Website|Full View|Save|Mark Applied|Hide Job|Report|Job Posting|View all|Contact Recruiter|HiringCafe|Add Career Page|Sign up|Sign in|Log in|Login|Submit|Talent Network|About|Terms|Privacy|Reject|Accept)\b/i;
    function visText(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }
    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const cs = window.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      return true;
    }
    function isOffSiteHref(href) {
      if (!href || !/^https?:/i.test(href)) return false;
      try {
        const u = new URL(href, window.location.href);
        return !/(^|\.)hiring\.cafe$/i.test(u.host);
      } catch (_) { return false; }
    }
    function check() {
      const anchors = Array.from(document.querySelectorAll("a"));
      // 1) Visible <a> whose text starts with "Apply"
      for (const a of anchors) {
        if (!isVisible(a)) continue;
        const txt = visText(a);
        if (SKIP_RE.test(txt)) continue;
        if (APPLY_RE.test(txt) && a.href && !/^javascript:/i.test(a.href)) {
          resolve({ href: a.href, label: txt, kind: "apply-anchor" }); return;
        }
      }
      // 2) ANY visible <a> with href pointing off hiring.cafe — the apply CTA
      let bestOff = null;
      for (const a of anchors) {
        if (!isVisible(a)) continue;
        if (!isOffSiteHref(a.href)) continue;
        const txt = visText(a);
        if (SKIP_RE.test(txt)) continue;
        const r = a.getBoundingClientRect();
        const area = r.width * r.height;
        if (!bestOff || area > bestOff.area) bestOff = { el: a, txt, area };
      }
      if (bestOff && bestOff.el && bestOff.el.href) {
        resolve({ href: bestOff.el.href, label: bestOff.txt || "off-site", kind: "off-anchor" }); return;
      }
      // 3) <button> with Apply text — capture any data-* URL
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        if (!isVisible(b)) continue;
        const txt = visText(b);
        if (SKIP_RE.test(txt)) continue;
        if (APPLY_RE.test(txt)) {
          for (const k of ["data-url", "data-href", "data-apply-url", "data-link"]) {
            const v = b.getAttribute(k);
            if (v && /^https?:/i.test(v)) {
              resolve({ href: v, label: txt, kind: "button-data" }); return;
            }
          }
          resolve({ href: null, label: txt, kind: "button-no-href" }); return;
        }
      }
      attempts += 1;
      if (attempts < maxAttempts) setTimeout(check, pollInterval);
      else resolve({ href: null, label: "no apply target found", kind: "missing" });
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

    // Wait for detail page to fully load
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

    // Step A: inject finder to locate the Apply now element
    const inj = await chrome.scripting.executeScript({
      target: { tabId },
      func: findApplyNowOnDetailPage,
      args: [DETAIL_APPLY_POLL_INTERVAL_MS, DETAIL_APPLY_POLL_MAX_ATTEMPTS],
      world: "MAIN"
    });
    const r = inj && inj[0] && inj[0].result;

    // If we got a direct href (anchor case), return it immediately
    if (r && r.href) {
      return { ok: true, finalUrl: r.href, kind: r.kind, label: r.label };
    }

    // Step B: button-no-href case — click the button and intercept the new tab
    if (r && r.kind === "button-no-href") {
      const intercepted = await new Promise((resolve) => {
        let done = false;
        let newTabId = null;

        const onCreated = (newTab) => {
          // The new tab spawned by clicking Apply now will have openerTabId === tabId
          if (newTab.openerTabId === tabId) {
            newTabId = newTab.id;
            activeResolverTabs.add(newTabId);
            finish(null);
          }
        };
        const onUpdated = (id, ci) => {
          if (newTabId && id === newTabId && ci.status === "complete") {
            // captured already; rely on the settling timer in finish()
          }
        };
        function finish(err) {
          if (done) return; done = true;
          try { chrome.tabs.onCreated.removeListener(onCreated); } catch (_) {}
          try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
          if (err || !newTabId) { resolve({ ok: false, error: err || "no new tab opened" }); return; }
          // Give the new tab a moment to settle on its final URL after redirects
          setTimeout(async () => {
            try {
              const newTab = await chrome.tabs.get(newTabId);
              const finalUrl = newTab.url || "";
              resolve({ ok: !!finalUrl && !isAggregator(finalUrl), finalUrl, error: null });
            } catch (e) {
              resolve({ ok: false, error: e?.message || String(e) });
            } finally {
              chrome.tabs.remove(newTabId).catch(() => {});
              activeResolverTabs.delete(newTabId);
            }
          }, TAB_POST_LOAD_QUIET_MS + 400);
        }

        chrome.tabs.onCreated.addListener(onCreated);
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(() => finish("timeout waiting for new tab"), TAB_RESOLVE_TIMEOUT_MS);

        // Click the Apply now button inside the detail tab
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const APPLY_RE = /^Apply\s*now\b/i;
            const SKIP_RE = /^(View All Jobs|Website|Full View|Save|Mark Applied|Hide Job|Report)\b/i;
            for (const a of document.querySelectorAll("a")) {
              const txt = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
              if (!SKIP_RE.test(txt) && APPLY_RE.test(txt) && a.href && !/^javascript:/i.test(a.href)) {
                a.click(); return { clicked: true, tag: "a" };
              }
            }
            for (const b of document.querySelectorAll("button")) {
              const txt = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
              if (!SKIP_RE.test(txt) && APPLY_RE.test(txt)) {
                b.click(); return { clicked: true, tag: "button" };
              }
            }
            return { clicked: false };
          },
          world: "MAIN"
        }).catch(() => {});
      });

      if (intercepted.ok && intercepted.finalUrl) {
        return { ok: true, finalUrl: intercepted.finalUrl, kind: "button-click-intercept", label: r.label };
      }
      return { ok: false, finalUrl: null, error: intercepted.error || "button click did not open ATS tab" };
    }

    // Any other failure (missing, etc.)
    return { ok: false, finalUrl: null, error: (r && r.kind) ? ("apply: " + r.kind) : "apply not resolvable" };
  } catch (e) {
    return { ok: false, finalUrl: null, error: "detail open failed: " + (e?.message || e) };
  } finally {
    if (tabId != null) {
      activeResolverTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}


async function resolveJobUrl(initialUrl) {
  if (!initialUrl) return { ok: false, finalUrl: null, error: "empty url", method: "none" };
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled", method: "none" };

  state.inFlight += 1; persistState();
  try {
    const startHost = hostOf(initialUrl);

    // If input is a hiring.cafe URL → go straight to detail-page resolver.
    if (REDIRECT_HOSTS.has(startHost)) {
      await tabSem.acquire();
      let applyUrl = null, applyKind = "";
      try {
        if (cancelAll) return { ok: false, finalUrl: initialUrl, error: "cancelled", method: "none" };
        const d = await resolveByDetailPage(initialUrl);
        if (!d.ok) return { ...d, applyInitial: initialUrl, method: "detail-fail" };
        applyUrl = d.finalUrl; applyKind = d.kind || "";
      } finally { tabSem.release(); }

      if (cancelAll) return { ok: false, finalUrl: applyUrl, error: "cancelled", method: "detail" };

      // Follow any redirects on the apply URL.
      const f = await fetchFollow(applyUrl);
      if (f.ok && f.finalUrl && !isAggregator(f.finalUrl)) {
        state.fetchHits += 1;
        return { ok: true, finalUrl: f.finalUrl, applyInitial: applyUrl, method: "detail+fetch", kind: applyKind };
      }
      // Tab fallback only if fetch failed or stayed on aggregator.
      if (cancelAll) return { ok: false, finalUrl: f.finalUrl || applyUrl, error: "cancelled", method: "detail+fetch" };
      await tabSem.acquire();
      try {
        if (cancelAll) return { ok: false, finalUrl: f.finalUrl || applyUrl, error: "cancelled", method: "detail+fetch" };
        const t = await resolveByTab(f.finalUrl || applyUrl);
        state.tabHits += 1;
        return { ok: t.ok && !isAggregator(t.finalUrl), finalUrl: t.finalUrl, applyInitial: applyUrl, method: t.ok ? "detail+tab" : ("detail+tab:" + (t.error || "fail")), kind: applyKind };
      } finally { tabSem.release(); }
    }

    // Otherwise: plain fetch-follow → tab fallback.
    const f = await fetchFollow(initialUrl);
    if (f.ok && f.finalUrl && !isAggregator(f.finalUrl)) {
      state.fetchHits += 1;
      return { ok: true, finalUrl: f.finalUrl, applyInitial: initialUrl, method: "fetch" };
    }
    if (cancelAll) return { ok: false, finalUrl: f.finalUrl || initialUrl, error: "cancelled", method: "fetch" };
    await tabSem.acquire();
    try {
      if (cancelAll) return { ok: false, finalUrl: f.finalUrl || initialUrl, error: "cancelled", method: "fetch" };
      const t = await resolveByTab(f.finalUrl || initialUrl);
      state.tabHits += 1;
      return { ok: t.ok, finalUrl: t.finalUrl, applyInitial: initialUrl, method: t.ok ? "tab" : ("tab:" + (t.error || "fail")) };
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
