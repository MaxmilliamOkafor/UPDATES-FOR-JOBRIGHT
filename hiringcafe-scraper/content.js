// content.js — runs on hiring.cafe (v1.9.0 — list-only scrape, no sidebar interaction)
//
// For each card visible on the listings page, capture:
//   - Title, Company, Location, Salary, Work mode, Commitment, YOE, Posted age
//   - Description, Skills
//   - Job Posting URL (the existing external-link anchor on every card)
//   - HiringCafe View-all URL
// Then for each Job Posting URL, run the fetch + hidden-tab pipeline in
// the background so any aggregator redirects land on the real ATS URL.
//
// NO card-click, NO hover-reveal, NO sidebar drawer interaction.
// Three pagination strategies (Pagination/LoadMore/Auto-scroll) + picker
// for the pagination button still work.

(() => {
  if (window.__hiringCafeScraperInjected__) return;
  window.__hiringCafeScraperInjected__ = true;

  const PAGE_RENDER_TIMEOUT_MS = 12000;
  const PAGE_RENDER_POLL_MS = 150;
  const PAGE_QUIET_MS = 350;
  const POST_CLICK_GRACE_MS = 200;
  const APPEND_WAIT_TIMEOUT_MS = 12000;
  const SCROLL_STEP_PX = 1200;
  const SCROLL_PAUSE_MS = 250;
  const APPEND_NO_GROWTH_TRIES = 4;

  let aborted = false;
  let pickerActive = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          void chrome.runtime.lastError; resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }
  function visibleText(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }
  function looksLikeChip(el) {
    if (!el) return false;
    const t = visibleText(el);
    if (!t || t.length > 80) return false;
    if (t.includes("\n")) return false;
    return true;
  }
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    return true;
  }

  function findJobCards() {
    const anchors = Array.from(document.querySelectorAll("a, button")).filter(
      (el) => /^Job Posting\b/i.test(visibleText(el))
    );
    const cards = [];
    const seen = new Set();
    for (const a of anchors) {
      let node = a.parentElement, card = null, safety = 0;
      while (node && node !== document.body && safety < 30) {
        const txt = node.textContent || "";
        if (txt.includes("Job Posting") && txt.includes("View all")) {
          const links = node.querySelectorAll("a").length;
          if (links < 30) { card = node; break; }
        }
        node = node.parentElement;
        safety += 1;
      }
      if (card && !seen.has(card)) { seen.add(card); cards.push(card); }
    }
    return cards;
  }

  const TIME_AGO_RE = /^\d+\s*[smhdw]$/i;
  const YOE_RE = /^(?:\?|\d+\+?)\s*YOE\b/i;
  const SALARY_RE = /\$[\d.,]+\s*(?:k|K|M)?(?:\s*[-–to]+\s*\$?[\d.,]+\s*(?:k|K|M)?)?\s*\/?\s*(?:yr|hr|mo|year|hour|month)?/i;
  const MODE_VALUES = new Set(["onsite", "remote", "hybrid", "in-person", "in person"]);
  const COMMITMENT_VALUES = new Set([
    "full time", "full-time", "fulltime", "part time", "part-time", "parttime",
    "contract", "contractor", "internship", "intern",
    "temporary", "temp", "seasonal", "seasonal, temporary"
  ]);

  function getJobPostingAnchor(card) {
    for (const a of card.querySelectorAll("a")) {
      if (/^Job Posting\b/i.test(visibleText(a)) && a.href && !/^javascript:/i.test(a.href)) return a;
    }
    return null;
  }
  function getViewAllAnchor(card) {
    for (const a of card.querySelectorAll("a")) {
      if (/^View all\b/i.test(visibleText(a))) return a;
    }
    return null;
  }
  function getTitle(card) {
    const headings = card.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of headings) {
      const t = visibleText(h);
      if (t && t.length > 2 && !/^Job Posting|^View all|^Apply/i.test(t)) return t;
    }
    let best = null, bestSize = 0;
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = visibleText(el);
      if (!t || t.length < 3 || t.length > 200) continue;
      if (/^Job Posting|^View all|^Apply|^Save\b|^Mark Applied|^views?$|^saves?$|^applications?$/i.test(t)) continue;
      const cs = window.getComputedStyle(el);
      const size = parseFloat(cs.fontSize) || 0;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const score = size + (weight >= 600 ? 4 : 0);
      if (score > bestSize) { bestSize = score; best = t; }
    }
    return best || "";
  }
  function getCompanyName(card) {
    const img = card.querySelector("img");
    if (img) {
      let row = img.parentElement, safety = 0;
      while (row && safety < 5 && row !== card) {
        const txt = visibleText(row);
        if (txt && txt.length < 200) {
          const m = txt.match(/^([^:]{2,80})\s*:/);
          if (m) return m[1].trim();
        }
        row = row.parentElement; safety += 1;
      }
    }
    const cardText = card.innerText || "";
    const m = cardText.match(/^\s*([A-Z][^\n:]{1,80})\s*:\s*[A-Z]/m);
    return m ? m[1].trim() : "";
  }
  function classifyChips(card) {
    const result = { location: [], salary: [], mode: [], commitment: [], yoe: [], timeAgo: [], other: [] };
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = visibleText(el);
      if (!t || !looksLikeChip(el)) continue;
      const lower = t.toLowerCase();
      if (TIME_AGO_RE.test(t)) { result.timeAgo.push(t); continue; }
      if (YOE_RE.test(t)) { result.yoe.push(t); continue; }
      if (SALARY_RE.test(t) && /\$/.test(t)) { result.salary.push(t); continue; }
      if (MODE_VALUES.has(lower)) { result.mode.push(t); continue; }
      if (COMMITMENT_VALUES.has(lower)) { result.commitment.push(t); continue; }
      if (/^[A-Z][\w. ]+,\s*[A-Z][\w. ]+/.test(t) || /\bUnited States\b|\bRemote\b|\bWorldwide\b/i.test(t)) {
        if (t.length <= 80 && !/[.;:]/.test(t)) { result.location.push(t); continue; }
      }
      result.other.push(t);
    }
    return result;
  }
  const dedupe = (a) => Array.from(new Set(a));
  function getDescription(card) {
    let best = "";
    for (const el of card.querySelectorAll("p, span, div")) {
      if (el.children.length > 1) continue;
      const t = visibleText(el);
      if (!t || t.length < 40) continue;
      if (/Job Posting|View all|Apply Directly|Apply now/i.test(t)) continue;
      if (t.length > best.length) best = t;
    }
    return best;
  }
  function getSkills(card) {
    let best = null;
    for (const el of card.querySelectorAll("div, span, p, li")) {
      const t = visibleText(el);
      if (!t || t.length > 250 || !t.includes(",")) continue;
      if (/Job Posting|View all|YOE|Apply/i.test(t)) continue;
      if (/[.;:]\s/.test(t)) continue;
      const parts = t.split(/\s*,\s*/).filter(Boolean);
      if (parts.length < 2) continue;
      if (parts.every((p) => p.length > 0 && p.length < 50)) best = t;
    }
    return best || "";
  }

  function buildRowMeta(card) {
    const jobAnchor = getJobPostingAnchor(card);
    const viewAllAnchor = getViewAllAnchor(card);
    const jobPostingUrl = jobAnchor ? jobAnchor.href : "";
    const viewAllUrl = viewAllAnchor ? viewAllAnchor.href : "";
    const chips = classifyChips(card);
    return {
      url: "",                   // resolved Job Posting URL (after redirects)
      title: getTitle(card),
      company: getCompanyName(card),
      location: dedupe(chips.location).join(" | "),
      salary: dedupe(chips.salary).join(" | "),
      work_mode: dedupe(chips.mode).join(" | "),
      commitment: dedupe(chips.commitment).join(" | "),
      yoe: dedupe(chips.yoe).join(" | "),
      posted_age: dedupe(chips.timeAgo).join(" | "),
      description: getDescription(card),
      skills: getSkills(card),
      job_posting_initial_url: jobPostingUrl,
      hiringcafe_viewall_url: viewAllUrl,
      status: jobPostingUrl ? "pending" : "no job posting url on card",
      method: "",
      scraped_at: new Date().toISOString()
    };
  }

  // ---- picker (smart) ----
  function nearestClickable(el) {
    let node = el, safety = 0;
    while (node && node !== document.body && safety < 12) {
      if (!(node instanceof Element)) { node = node.parentElement; safety++; continue; }
      const tag = node.tagName.toLowerCase();
      if (tag === "button" || tag === "a") return node;
      const role = node.getAttribute && node.getAttribute("role");
      if (role === "button" || role === "link" || role === "tab" || role === "menuitem") return node;
      if (node.hasAttribute && node.hasAttribute("onclick")) return node;
      try { const cs = window.getComputedStyle(node); if (cs.cursor === "pointer") return node; } catch (_) {}
      node = node.parentElement; safety += 1;
    }
    return el;
  }
  function structuralPath(el) {
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement; if (!parent) break;
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const idx = same.indexOf(node) + 1;
      path.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${idx})`);
      node = parent;
    }
    return path.join(" > ");
  }
  function buildElementSpec(el) {
    const text = visibleText(el).slice(0, 100);
    const ariaLabel = (el.getAttribute && el.getAttribute("aria-label")) || "";
    const title = (el.getAttribute && el.getAttribute("title")) || "";
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    const tag = el.tagName.toLowerCase();
    const id = el.id || "";
    return { tag, text, ariaLabel, title, role, id, path: structuralPath(el),
      label: ariaLabel || text || title || tag };
  }
  function findByElementSpec(spec) {
    if (!spec) return null;
    if (spec.id) { const el = document.getElementById(spec.id); if (el && isVisible(el)) return el; }
    if (spec.ariaLabel) {
      const escaped = spec.ariaLabel.replace(/"/g, '\\"');
      const candidates = document.querySelectorAll(`[aria-label="${escaped}"]`);
      for (const c of candidates) if (isVisible(c)) return c;
    }
    if (spec.text) {
      const candidates = document.querySelectorAll(spec.tag || "*");
      for (const c of candidates) if (visibleText(c) === spec.text && isVisible(c)) return c;
    }
    if (spec.path) {
      try { const el = document.querySelector(spec.path); if (el && isVisible(el)) return el; } catch (_) {}
    }
    return null;
  }
  let pickerOverlay = null, pickerLabel = null, pickerTip = null, pickerHovered = null;
  function ensurePickerOverlay() {
    if (pickerOverlay) return;
    pickerOverlay = document.createElement("div");
    pickerOverlay.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;border:2px solid #d946ef;background:rgba(217,70,239,0.12);transition:all 0.05s linear;box-sizing:border-box;border-radius:4px";
    pickerLabel = document.createElement("div");
    pickerLabel.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;background:#0f1014;color:#fff;border:1px solid #d946ef;border-radius:8px;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:0.2px;box-shadow:0 6px 24px rgba(0,0,0,0.5);pointer-events:none;white-space:nowrap";
    pickerLabel.textContent = "Hover Next / Load More / › button — click to lock. Esc to cancel.";
    pickerTip = document.createElement("div");
    pickerTip.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;padding:5px 9px;background:#0f1014;color:#e6e6f0;border:1px solid #d946ef;border-radius:6px;font:600 11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;box-shadow:0 4px 14px rgba(0,0,0,0.5);pointer-events:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    pickerTip.textContent = "";
    document.documentElement.appendChild(pickerOverlay);
    document.documentElement.appendChild(pickerLabel);
    document.documentElement.appendChild(pickerTip);
  }
  function destroyPickerOverlay() {
    if (pickerOverlay) { pickerOverlay.remove(); pickerOverlay = null; }
    if (pickerLabel) { pickerLabel.remove(); pickerLabel = null; }
    if (pickerTip) { pickerTip.remove(); pickerTip = null; }
    pickerHovered = null;
  }
  function pickerTipText(el) {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute && el.getAttribute("aria-label");
    const text = visibleText(el).slice(0, 40);
    const role = el.getAttribute && el.getAttribute("role");
    const parts = [tag];
    if (role) parts.push(`[role=${role}]`);
    if (aria) parts.push(`"${aria}"`); else if (text) parts.push(`"${text}"`);
    return "✨ " + parts.join(" ") + "  — click to lock";
  }
  function onPickerMove(e) {
    if (!pickerActive) return;
    const raw = document.elementFromPoint(e.clientX, e.clientY); if (!raw) return;
    const target = nearestClickable(raw);
    if (target !== pickerHovered) {
      pickerHovered = target;
      const r = target.getBoundingClientRect();
      pickerOverlay.style.left = r.left + "px"; pickerOverlay.style.top = r.top + "px";
      pickerOverlay.style.width = r.width + "px"; pickerOverlay.style.height = r.height + "px";
      pickerTip.textContent = pickerTipText(target);
    }
    pickerTip.style.left = Math.min(e.clientX + 14, window.innerWidth - 340) + "px";
    pickerTip.style.top = Math.max(e.clientY + 18, 0) + "px";
  }
  function onPickerClick(e) {
    if (!pickerActive) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const raw = document.elementFromPoint(e.clientX, e.clientY); if (!raw) return;
    const target = nearestClickable(raw);
    const spec = buildElementSpec(target);
    chrome.storage.local.get("hiringcafe_settings").then((r) => {
      const cur = r.hiringcafe_settings || { strategy: "pagination", elementSpec: null };
      cur.elementSpec = spec;
      chrome.storage.local.set({ hiringcafe_settings: cur }).then(() => {
        send("ELEMENT_PICKED", { spec }); stopPicker();
      });
    });
  }
  function onPickerSwallow(e) {
    if (!pickerActive) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }
  function onPickerKey(e) { if (pickerActive && e.key === "Escape") { e.preventDefault(); stopPicker(); } }
  function startPicker() {
    if (pickerActive) return;
    pickerActive = true; ensurePickerOverlay();
    document.addEventListener("mousemove", onPickerMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("mousedown", onPickerSwallow, true);
    document.addEventListener("mouseup", onPickerSwallow, true);
    document.addEventListener("pointerdown", onPickerSwallow, true);
    document.addEventListener("pointerup", onPickerSwallow, true);
    document.addEventListener("keydown", onPickerKey, true);
  }
  function stopPicker() {
    pickerActive = false;
    document.removeEventListener("mousemove", onPickerMove, true);
    document.removeEventListener("click", onPickerClick, true);
    document.removeEventListener("mousedown", onPickerSwallow, true);
    document.removeEventListener("mouseup", onPickerSwallow, true);
    document.removeEventListener("pointerdown", onPickerSwallow, true);
    document.removeEventListener("pointerup", onPickerSwallow, true);
    document.removeEventListener("keydown", onPickerKey, true);
    destroyPickerOverlay();
  }

  // ---- pagination ----
  function findPagination() {
    const allButtons = Array.from(document.querySelectorAll("button, a"));
    const numbered = allButtons.filter((b) => /^\d+$/.test(visibleText(b)));
    if (numbered.length < 2) return null;
    let ancestor = numbered[0].parentElement;
    while (ancestor && !numbered.every((b) => ancestor.contains(b))) ancestor = ancestor.parentElement;
    return ancestor || null;
  }
  function getCurrentPageNumber(paginationEl) {
    if (!paginationEl) return null;
    const numbered = Array.from(paginationEl.querySelectorAll("button, a")).filter(
      (b) => /^\d+$/.test(visibleText(b))
    );
    for (const b of numbered) {
      if (b.getAttribute("aria-current")) return parseInt(visibleText(b), 10);
      if (b.getAttribute("aria-selected") === "true") return parseInt(visibleText(b), 10);
    }
    const bgCounts = new Map();
    for (const b of numbered) {
      const cs = window.getComputedStyle(b);
      const key = cs.backgroundColor + "|" + cs.color;
      bgCounts.set(key, (bgCounts.get(key) || 0) + 1);
    }
    let oddKey = null, oddCount = Infinity;
    for (const [k, c] of bgCounts) if (c < oddCount) { oddCount = c; oddKey = k; }
    for (const b of numbered) {
      const cs = window.getComputedStyle(b);
      if (cs.backgroundColor + "|" + cs.color === oddKey) return parseInt(visibleText(b), 10);
    }
    return null;
  }
  function getTotalPages(paginationEl) {
    if (!paginationEl) return null;
    const numbers = Array.from(paginationEl.querySelectorAll("button, a"))
      .map((b) => parseInt(visibleText(b), 10))
      .filter((n) => Number.isFinite(n));
    return numbers.length ? Math.max(...numbers) : null;
  }
  function autoDetectNextButton(paginationEl) {
    if (!paginationEl) return null;
    const current = getCurrentPageNumber(paginationEl);
    if (current != null) {
      const target = String(current + 1);
      for (const b of paginationEl.querySelectorAll("button, a"))
        if (visibleText(b) === target && !b.disabled) return b;
    }
    const ariaNext = paginationEl.querySelector('button[aria-label*="next" i], a[aria-label*="next" i], button[title*="next" i]');
    if (ariaNext && !ariaNext.disabled) return ariaNext;
    const buttons = Array.from(paginationEl.querySelectorAll("button, a")).filter(
      (b) => !/^\d+$/.test(visibleText(b)) && !b.disabled
    );
    if (buttons.length) return buttons[buttons.length - 1];
    return null;
  }
  function clickAt(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "auto" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("click", opts)); } catch (_) {}
    try { if (typeof el.click === "function") el.click(); } catch (_) {}
  }

  function cardSignature(cards) {
    const titles = cards.slice(0, 3).map((c) => getTitle(c));
    return cards.length + "|" + titles.join("||");
  }
  async function waitForCardsToChange(prevSignature) {
    const start = Date.now();
    let lastSig = prevSignature, lastChange = Date.now();
    while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS) {
      if (aborted) return false;
      await sleep(PAGE_RENDER_POLL_MS);
      const cards = findJobCards();
      const sig = cardSignature(cards);
      if (sig !== prevSignature) {
        if (sig === lastSig) { if (Date.now() - lastChange >= PAGE_QUIET_MS) return true; }
        else { lastSig = sig; lastChange = Date.now(); }
      }
    }
    return false;
  }
  async function waitForCardsToExist() {
    const start = Date.now();
    while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS) {
      if (aborted) return false;
      if (findJobCards().length > 0) return true;
      await sleep(PAGE_RENDER_POLL_MS);
    }
    return false;
  }
  async function waitForCardCountToGrow(prevCount) {
    const start = Date.now();
    while (Date.now() - start < APPEND_WAIT_TIMEOUT_MS) {
      if (aborted) return false;
      await sleep(PAGE_RENDER_POLL_MS);
      if (findJobCards().length > prevCount) return true;
    }
    return false;
  }

  // ---- per-page parallel resolution ----
  async function scrapeCards(cards, currentPage, totalPages) {
    const rows = cards.map((c) => buildRowMeta(c));
    await send("PAGE_PROGRESS", {
      pageIndex: currentPage, totalPages, scrapedThisPage: 0, status: "running"
    });
    let completed = 0;
    await Promise.all(rows.map(async (row) => {
      if (aborted) return;
      if (row.job_posting_initial_url) {
        const r = await send("RESOLVE_URL", { url: row.job_posting_initial_url });
        if (r) {
          if (r.ok) {
            row.url = r.finalUrl || row.job_posting_initial_url;
            row.status = "ok";
            row.method = r.method || "";
          } else {
            row.url = r.finalUrl || row.job_posting_initial_url;
            row.status = "error: " + (r.error || "unknown");
            row.method = r.method || "";
          }
        } else { row.status = "no response"; }
      }
      // Always save the row, even if URL resolution failed — at least
      // the user gets the on-card metadata.
      await send("JOB_SCRAPED", { row });
      completed += 1;
      if (completed % 4 === 0 || completed === rows.length) {
        await send("PAGE_PROGRESS", {
          pageIndex: currentPage, totalPages, scrapedThisPage: completed, status: "running"
        });
      }
    }));
  }

  async function runPagination(options) {
    let pageIndex = 0;
    while (!aborted) {
      pageIndex += 1;
      const paginationEl = findPagination();
      const totalPages = getTotalPages(paginationEl);
      const currentPage = getCurrentPageNumber(paginationEl) ?? pageIndex;
      const cardsBefore = findJobCards();
      const sigBefore = cardSignature(cardsBefore);
      await scrapeCards(cardsBefore, currentPage, totalPages);
      if (aborted) break;
      let nextEl = null;
      if (options.elementSpec) nextEl = findByElementSpec(options.elementSpec);
      if (!nextEl) nextEl = autoDetectNextButton(paginationEl);
      if (!nextEl) return;
      clickAt(nextEl);
      await sleep(POST_CLICK_GRACE_MS);
      const changed = await waitForCardsToChange(sigBefore);
      if (!changed) return;
    }
  }

  async function runLoadMore(options) {
    if (!options.elementSpec) {
      await send("SCRAPE_DONE", { error: "No Load More element selected. Use the picker." });
      return;
    }
    const seenUrls = new Set();
    let pageIndex = 0, noGrowth = 0;
    while (!aborted) {
      pageIndex += 1;
      const cards = findJobCards();
      const newCards = cards.filter((c) => {
        const a = getJobPostingAnchor(c);
        const k = a ? a.href : "";
        if (k && seenUrls.has(k)) return false;
        if (k) seenUrls.add(k);
        return true;
      });
      await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: 0, status: "running" });
      await scrapeCards(newCards, pageIndex, null);
      if (aborted) break;
      const before = findJobCards().length;
      const btn = findByElementSpec(options.elementSpec);
      if (!btn) { await send("SCRAPE_DONE", {}); return; }
      clickAt(btn);
      await sleep(POST_CLICK_GRACE_MS);
      const grew = await waitForCardCountToGrow(before);
      if (!grew) {
        noGrowth += 1;
        if (noGrowth >= APPEND_NO_GROWTH_TRIES) { await send("SCRAPE_DONE", {}); return; }
      } else noGrowth = 0;
    }
  }

  async function runAutoScroll() {
    const seenUrls = new Set();
    let pageIndex = 0, noGrowth = 0;
    while (!aborted) {
      pageIndex += 1;
      const cards = findJobCards();
      const newCards = cards.filter((c) => {
        const a = getJobPostingAnchor(c);
        const k = a ? a.href : "";
        if (k && seenUrls.has(k)) return false;
        if (k) seenUrls.add(k);
        return true;
      });
      await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: 0, status: "running" });
      await scrapeCards(newCards, pageIndex, null);
      if (aborted) break;
      const before = findJobCards().length;
      window.scrollBy({ top: SCROLL_STEP_PX, behavior: "auto" });
      await sleep(SCROLL_PAUSE_MS);
      if (findJobCards().length === before) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
        await sleep(SCROLL_PAUSE_MS);
      }
      const grew = await waitForCardCountToGrow(before);
      if (!grew) {
        noGrowth += 1;
        if (noGrowth >= APPEND_NO_GROWTH_TRIES) { await send("SCRAPE_DONE", {}); return; }
      } else noGrowth = 0;
    }
  }

  async function runScrape(options) {
    aborted = false;
    if (!(await waitForCardsToExist())) {
      await send("SCRAPE_DONE", { error: "No job cards found on this page." });
      return;
    }
    const strategy = (options && options.strategy) || "pagination";
    try {
      if (strategy === "loadmore") await runLoadMore(options);
      else if (strategy === "autoscroll") await runAutoScroll(options);
      else await runPagination(options);
    } catch (e) {
      await send("SCRAPE_DONE", { error: e?.message || String(e) });
      return;
    }
    if (aborted) await send("SCRAPE_DONE", { error: "stopped by user" });
    else await send("SCRAPE_DONE", {});
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "BEGIN_SCRAPE") {
      runScrape(msg.options || {}).catch((e) => send("SCRAPE_DONE", { error: e?.message || String(e) }));
      sendResponse({ ok: true }); return;
    }
    if (msg.type === "ABORT_SCRAPE") { aborted = true; sendResponse({ ok: true }); return; }
    if (msg.type === "START_PICKER") { startPicker(); sendResponse({ ok: true }); return; }
    if (msg.type === "STOP_PICKER")  { stopPicker();  sendResponse({ ok: true }); return; }
    if (msg.type === "PING") { sendResponse({ ok: true }); return; }
  });
})();
