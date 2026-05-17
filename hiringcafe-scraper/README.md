# HiringCafe Scraper

A Chrome extension (Manifest V3) that scrapes job listings from [hiring.cafe](https://hiring.cafe), resolves each job's **real** external Job Posting URL, and exports everything to CSV.

The point of this project: hiring.cafe's "Job Posting" link often doesn't expose the final destination URL until after redirects fire. This extension resolves redirects transparently — using a fast HTTP fetch path when possible and falling back to a hidden background tab only when JavaScript-side redirects require a real browser context. The CSV you download contains real, clickable employer URLs, not aggregator redirects.

## Features

- **Lightning-fast resolution** — parallel `fetch()` with redirect-following, plus a bounded pool of hidden tabs as fallback. ~10× faster than naive per-tab resolution.
- **Three pagination strategies** that you choose from the popup:
  - **Pagination** — click a Next button after each page; cards replace.
  - **Load More** — click an Append button; cards append; only new cards get scraped.
  - **Auto-scroll** — scroll-to-bottom infinite-scroll feeds; only new cards get scraped.
- **Visual element picker** — instead of relying on auto-detect, hover and click the exact "Next page", "Load More", or `>` button you want the scraper to use. The picker locks in a robust selector (id → aria-label → text → structural path).
- Pulls every visible field per card: title, company, location, salary, work mode, commitment, YOE, posted age, description, skills, internal HiringCafe URL, initial Job Posting URL, final resolved URL, resolution status, and a scraped-at timestamp.
- Persists to `chrome.storage.local` so closing the popup mid-run doesn't lose anything.
- One-click CSV export (UTF-8 BOM, RFC-4180 escaping, Excel-friendly).

## Install (load unpacked)

1. Extract the zip (or clone the repo).
2. Open `chrome://extensions` → toggle **Developer mode** on (top right) → click **Load unpacked** → select the `hiringcafe-scraper/` folder.
3. Pin the extension from the puzzle-piece menu so the icon stays visible.

## Use it

1. Open [hiring.cafe](https://hiring.cafe) and apply your filters. The extension scrapes whatever the page is currently showing.
2. Click the extension icon to open the popup.
3. **Pick a pagination strategy:**
   - **Pagination** (default) — works for hiring.cafe's normal numbered-page UI; auto-detects the next button.
   - **Load More** — required when the page has a "Show more results" button instead of pages.
   - **Auto-scroll** — for infinite-scroll feeds.
4. *(Optional but recommended for Load More)* Click **Pick element**, then on the page **hover** over the Next / Load More / `>` button, and **click** it to lock it in. Press Escape to cancel. The picker overlay shows you which element it's about to capture.
5. Click **Start scraping**. Watch the popup:
   - **Page** — current / total
   - **Scraped** — total jobs captured so far
   - **This page** — completed on the current page
   - **In flight** — URL resolutions currently in progress
   - **Fast / Tab** — count of resolutions that completed via fetch (fast) vs. tab fallback (slow). High Fast / low Tab = fast run.
6. When the status pill says **Done**, click **Export CSV**.

You can close the popup mid-run; progress and results stay in `chrome.storage.local`. Reopen the popup any time to check status, stop, or export.

## CSV columns

| Column | Notes |
|---|---|
| Title | Job title |
| Company | Company name |
| Location | e.g. "Denver, Colorado, United States" |
| Salary | e.g. "$105k-$138k/yr" |
| Work mode | Onsite / Remote / Hybrid |
| Commitment | Full Time / Part Time / Contract / Internship / Temporary |
| Years of experience | e.g. "3+ YOE" or "? YOE" |
| Posted age | e.g. "10h", "1d" |
| Description | The longest text block on the card |
| Skills | The wrench-icon comma list |
| HiringCafe URL | The "View all" link to the HiringCafe detail page |
| Job Posting (initial URL) | The href on the "Job Posting" link as it appears on the page |
| Job Posting (final URL) | The URL after all redirects — what you actually want |
| URL resolution status | `ok via fetch`, `ok via tab`, `error: ...`, `skipped`, `no link found` |
| Scraped at | ISO-8601 timestamp |

## How URL resolution works (fast)

For each Job Posting URL, the background service worker tries strategies in order:

1. **`fetch(url, { redirect: 'follow' })`** — service-worker fetch follows HTTP 3xx redirects automatically and exposes the final URL on `response.url`. No tab, no rendering. For most ATS links (Greenhouse, Lever, Ashby, Workable, BambooHR, etc.) this returns in tens to a few hundred ms. The browser handles per-origin concurrency naturally; many resolutions run in parallel.

2. **Hidden background tab** — if the fetch lands back on hiring.cafe (meaning the redirect happens via JavaScript, which `fetch` can't execute), the URL is opened in a non-focused tab. The worker listens to `chrome.tabs.onUpdated` for redirect URLs, waits a short quiet period after `complete` to catch JS redirects, reads the final URL, and closes the tab. Bounded to 6 concurrent tabs by a semaphore so this stays kind to your machine.

This hybrid runs much faster than always opening a tab while still being robust against JS-only redirects.

## Picker semantics

When you click an element, the picker captures a robust spec, not a brittle CSS selector:

```
{ tag, text, ariaLabel, title, role, id, path, label }
```

To re-find the element later, the scraper tries (in order): `#id` → `[aria-label="..."]` → exact text within tag → structural `:nth-of-type` path. So if hiring.cafe re-renders and class names change, the picked element is still found as long as one of those still matches.

If the picked element disappears (e.g. you reach the last page and the Load More button is gone), the scraper treats that as "done" and stops cleanly.

## Tunables

In `content.js`:

| Constant | Default | Effect |
|---|---|---|
| `PAGE_RENDER_TIMEOUT_MS` | 12000 | Hard cap on waiting for a new page to render |
| `PAGE_QUIET_MS` | 350 | DOM must be quiet this long before a page is considered ready |
| `POST_CLICK_GRACE_MS` | 200 | Pause after clicking next/load-more |
| `APPEND_NO_GROWTH_TRIES` | 4 | Stop autoscroll/loadmore after this many no-growth waits |
| `SCROLL_STEP_PX` | 1200 | How far each autoscroll tick scrolls |

In `background.js`:

| Constant | Default | Effect |
|---|---|---|
| `FETCH_TIMEOUT_MS` | 5000 | Per-URL fetch timeout |
| `TAB_RESOLVE_TIMEOUT_MS` | 8000 | Per-URL tab fallback timeout |
| `TAB_POST_LOAD_QUIET_MS` | 200 | Wait after tab `complete` to catch JS redirects |
| `MAX_CONCURRENT_TABS` | 6 | Concurrent tab fallback resolves |

## File layout

```
hiringcafe-scraper/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.css
├── popup.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
├── LICENSE
└── .gitignore
```

## Limitations

- Scrapes only what's visible on the cards. The "View all" detail page isn't fetched.
- Some destination ATS sites (a few Workday tenants, certain SSO-protected pages) may not finish loading inside the 8s tab timeout. Those rows end up with the initial URL and a `URL resolution status` of `error: timeout` so you can investigate manually.
- Auto-scroll relies on the page actually loading more cards as you scroll. If the site uses a Load More button instead, switch the strategy to **Load More** and pick the button.

## License

MIT — see `LICENSE`.
