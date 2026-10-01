// ==UserScript==
// @name         Steam License Remover (rate-limit aware + telemetry)
// @version      3.1
// @description  Remove "Free" licenses from your Steam account. Crawls all license pages,
//               checks Steam's real result code, backs off on error 84, and records
//               telemetry so the real rate limit can be measured.
// @author       IroN404 (original), Beardox (fork), v3.x fixes
// @match        https://store.steampowered.com/account/licenses/*
// ==/UserScript==
//
// HOW TO USE
//   1. Go to https://store.steampowered.com/account/licenses/ (logged in).
//   2. F12 -> Console -> paste this whole script -> Enter.
//   3. Review the table + confirm box. Keep the tab in the FOREGROUND while it runs.
//
// CONSOLE COMMANDS
//   SLR.status()          live progress
//   SLR.stop()            stop after the current step
//   SLR.report()          rate-limit analysis across ALL runs (SLR.report('run') = this run only)
//   SLR.exportCSV()       download every logged request as CSV
//   SLR.exportJSON()      download the raw telemetry + report as JSON
//   SLR.verify()          re-check the licenses page and confirm removals are really gone
//   SLR.reset()           forget saved progress (removed IDs) for this account
//   SLR.clearLog()        wipe telemetry for this account
//
// v3.1 CHANGES (from review of v3.0)
//   - FIX: page crawler followed ANY ?query link on the licenses path, including the footer's
//     language links (?l=french ...). Fetching those can switch your Steam language. It now
//     only follows pagination-style parameters, and logs the links it ignored.
//   - FIX: progress was stored under one global key; switching Steam accounts in the same
//     browser would skip IDs removed on the other account. Now keyed per account.
//   - FIX: if Steam redirected a page fetch to the login page, the crawl silently found
//     0 licenses. Now detected and reported.
//   - FIX: "Stop" also suppressed the final verify (stopRequested was reset mid-run). Verify is
//     now skipped on stop and available on demand via SLR.verify().
//   - FIX: name came only from base64 in the href (fragile). Now read from the table row,
//     with base64 as fallback. Row removal uses the element reference, not a CSS guess.
//   - FIX: HTTP 429 Retry-After header was ignored. Now honoured if present.
//   - NEW: optional cap on rate-limit retries per license (default unlimited).
//   - NEW: telemetry for every request, cooldown, page fetch, and tab visibility change,
//     persisted in localStorage so it survives refreshes and accumulates across runs.
//   - NEW: SLR.report() derives the burst size, window limits and cooldown bounds.

(async () => {
  'use strict';

  // ----------------------------------------------------------------- CONFIG
  const CONFIG = {
    delayMs:              15000,           // pause between removals
    jitterMs:             3000,            // +/- random jitter on every pause
    rateLimitWaitMs:      10 * 60 * 1000,  // first wait after an error 84 / HTTP 429
    rateLimitMaxWaitMs:   60 * 60 * 1000,  // backoff doubles up to this cap
    maxRateLimitRetries:  0,               // per license; 0 = retry forever
    maxOtherFailures:     2,               // retries for non-rate-limit errors before skipping
    crawlPages:           true,            // follow pagination links
    pageFetchDelayMs:     1500,            // pause between page fetches while crawling
    maxPages:             200,             // safety cap for crawling
    verifyAtEnd:          true,            // re-crawl at the end and confirm removals
    dryRun:               false,           // true = list what would be removed, remove nothing
    maxLogEvents:         5000,            // telemetry cap (oldest dropped first)
    verbose:              false,           // true = log every request's raw details
  };

  const VERSION       = '3.1';
  const LICENSES_PATH = '/account/licenses';
  const REMOVE_URL    = 'https://store.steampowered.com/account/removelicense';
  const PAGE_PARAMS   = new Set(['p', 'page', 'start', 'offset', 'pagenum', 'pg']);
  const EResultName   = { 1: 'OK', 2: 'Fail', 3: 'NoConnection', 8: 'InvalidParam', 15: 'AccessDenied',
                          16: 'Timeout', 24: 'InsufficientPrivilege', 25: 'LimitExceeded',
                          29: 'DuplicateRequest', 84: 'RateLimitExceeded' };

  // ----------------------------------------------------------------- GUARDS
  if (location.hostname !== 'store.steampowered.com' ||
      !location.pathname.replace(/\/$/, '').endsWith(LICENSES_PATH)) {
    console.error('[SLR] Run this on https://store.steampowered.com/account/licenses/');
    return;
  }
  if (typeof g_sessionID === 'undefined' || !g_sessionID) {
    console.error('[SLR] g_sessionID not found - are you logged in? Refresh the page and try again.');
    return;
  }
  if (window.SLR && window.SLR.running) {
    console.warn('[SLR] Already running. Use SLR.stop() first.');
    return;
  }

  // Per-account storage keys
  const acct = String(
    (typeof g_steamID !== 'undefined' && g_steamID) ||
    (typeof g_AccountID !== 'undefined' && g_AccountID) || 'unknown');
  const STORAGE_KEY = `slr_removed_${acct}`;
  const LOG_KEY     = `slr_log_${acct}`;
  if (acct === 'unknown') console.warn('[SLR] Could not read your Steam ID; progress is stored under "unknown".');

  // ----------------------------------------------------------------- STATE
  const state = {
    running: true, stopRequested: false, userStopped: false,
    total: 0, removed: 0, skipped: 0, rateLimitHits: 0,
    current: null, waitingUntil: null,
  };
  const removedIds = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  const saveRemoved = () => localStorage.setItem(STORAGE_KEY, JSON.stringify([...removedIds]));

  // ----------------------------------------------------------------- HELPERS
  const ts   = () => new Date().toLocaleTimeString();
  const log  = (...a) => console.log(`[SLR ${ts()}]`, ...a);
  const dbg  = (...a) => { if (CONFIG.verbose) console.debug(`[SLR ${ts()}]`, ...a); };
  const jitter = (ms) => Math.max(0, ms + Math.round((Math.random() * 2 - 1) * CONFIG.jitterMs));
  const fmt = (ms) => {
    if (ms == null || !isFinite(ms)) return '-';
    const s = Math.round(ms / 1000);
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };

  // ----------------------------------------------------------------- TELEMETRY
  const runId = Date.now().toString(36);
  let tlog = [];
  try { tlog = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { tlog = []; }

  function saveLog() {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(tlog)); }
    catch { tlog.splice(0, Math.ceil(tlog.length / 4)); // quota hit: drop oldest 25% and retry once
            try { localStorage.setItem(LOG_KEY, JSON.stringify(tlog)); } catch { /* give up */ } }
  }
  function record(type, data = {}) {
    const e = { run: runId, v: VERSION, t: Date.now(), time: new Date().toISOString(),
                hidden: document.hidden, type, ...data };
    tlog.push(e);
    if (tlog.length > CONFIG.maxLogEvents) tlog.splice(0, tlog.length - CONFIG.maxLogEvents);
    saveLog();
    return e;
  }
  // Successful removals in the last `ms` (all runs - the limit is per account/IP, not per run)
  function okCountSince(ms) {
    const cut = Date.now() - ms; let n = 0;
    for (let i = tlog.length - 1; i >= 0 && tlog[i].t >= cut; i--) {
      if (tlog[i].type === 'remove' && tlog[i].result === 'ok') n++;
    }
    return n;
  }
  function currentStreak() {
    let n = 0;
    for (let i = tlog.length - 1; i >= 0; i--) {
      const e = tlog[i];
      if (e.type !== 'remove') continue;
      if (e.result === 'ok') n++; else if (e.result === 'ratelimit') break;
    }
    return n;
  }
  function lastRemoveEvent() {
    for (let i = tlog.length - 1; i >= 0; i--) if (tlog[i].type === 'remove') return tlog[i];
    return null;
  }

  const onVisibility = () => {
    if (!state.running) return;
    record('visibility', { hidden: document.hidden });
    if (document.hidden) console.warn('[SLR] Tab hidden - Chrome may throttle timers. Timings logged while hidden are flagged.');
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ----------------------------------------------------------------- REPORT
  function maxInWindow(times, w) {
    let best = 0, j = 0;
    for (let i = 0; i < times.length; i++) {
      while (times[i] - times[j] > w) j++;
      best = Math.max(best, i - j + 1);
    }
    return best;
  }
  function pct(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function buildReport(scope = 'all') {
    const ev  = scope === 'run' ? tlog.filter(e => e.run === runId) : tlog;
    const rem = ev.filter(e => e.type === 'remove');
    const by  = (k) => rem.filter(e => e.result === k).length;
    const okTimes = rem.filter(e => e.result === 'ok').map(e => e.t);

    // Rate-limit episodes: first 84 after a success -> next success
    const episodes = []; let ep = null; let streak = 0;
    for (const e of rem) {
      if (e.result === 'ok') {
        if (ep) { ep.recoveredAt = e.t; episodes.push(ep); ep = null; }
        streak++;
      } else if (e.result === 'ratelimit') {
        if (!ep) ep = { start: e.t, lastHit: e.t, hits: 1, burstBefore: streak,
                        ok1m: e.ok1m, ok10m: e.ok10m, ok60m: e.ok60m, failedGaps: [], hiddenDuring: false };
        else { ep.failedGaps.push(e.t - ep.lastHit); ep.hits++; ep.lastHit = e.t; }
        if (e.hidden) ep.hiddenDuring = true;
        streak = 0;
      }
    }
    if (ep) episodes.push(ep);

    const resolved = episodes.filter(x => x.recoveredAt);
    const lower = Math.max(0, ...episodes.flatMap(x => x.failedGaps));        // waited this long, still blocked
    const upperFromLast  = resolved.length ? Math.min(...resolved.map(x => x.recoveredAt - x.lastHit)) : null;
    const upperFromFirst = resolved.length ? Math.min(...resolved.map(x => x.recoveredAt - x.start))   : null;
    const bursts = episodes.map(x => x.burstBefore);
    const lat = rem.map(e => e.ms).filter(n => typeof n === 'number');
    const gaps = rem.map(e => e.sincePrevReqMs).filter(n => typeof n === 'number');
    const otherCodes = {};
    rem.filter(e => e.result === 'fail' || e.result === 'fatal')
       .forEach(e => { const k = e.eresult != null ? `EResult ${e.eresult}` : (e.http ? `HTTP ${e.http}` : e.detail);
                       otherCodes[k] = (otherCodes[k] || 0) + 1; });
    const pages = ev.filter(e => e.type === 'page');
    const verifies = ev.filter(e => e.type === 'verify');

    return {
      scope, account: acct, generated: new Date().toISOString(),
      attempts: rem.length, ok: by('ok'), rateLimited: by('ratelimit'), failed: by('fail'), fatal: by('fatal'),
      otherCodes,
      spanMs: rem.length ? rem[rem.length - 1].t - rem[0].t : 0,
      latencyMs: { median: pct(lat, 0.5), p95: pct(lat, 0.95) },
      gapBetweenRequestsMs: { median: pct(gaps, 0.5), min: gaps.length ? Math.min(...gaps) : null },
      maxSuccessesObserved: { per1m: maxInWindow(okTimes, 60e3), per10m: maxInWindow(okTimes, 600e3),
                              per60m: maxInWindow(okTimes, 3600e3), per24h: maxInWindow(okTimes, 86400e3) },
      burstBefore84: { min: bursts.length ? Math.min(...bursts) : null, max: bursts.length ? Math.max(...bursts) : null,
                       median: pct(bursts, 0.5) },
      cooldown: { stillBlockedAfterMs: lower || null, clearedWithinMs_fromLast84: upperFromLast,
                  clearedWithinMs_fromFirst84: upperFromFirst },
      episodes, pages: pages.length,
      reportedOkButStillListed: verifies.reduce((n, v) => n + (v.notGone || 0), 0),
    };
  }

  function printReport(scope = 'all') {
    const r = buildReport(scope);
    console.group(`[SLR] Report (${scope === 'run' ? 'this run' : 'all runs'}) - account ${acct}`);
    console.log(`Attempts ${r.attempts} | OK ${r.ok} | rate-limited ${r.rateLimited} | failed ${r.failed} | fatal ${r.fatal} | span ${fmt(r.spanMs)}`);
    if (Object.keys(r.otherCodes).length) console.log('Other failure codes:', r.otherCodes);
    console.log(`Request latency: median ${r.latencyMs.median ?? '-'} ms, p95 ${r.latencyMs.p95 ?? '-'} ms | ` +
                `gap between requests: median ${fmt(r.gapBetweenRequestsMs.median)}, min ${fmt(r.gapBetweenRequestsMs.min)}`);
    console.log('Most successful removals seen in any window:', r.maxSuccessesObserved);
    if (r.episodes.length) {
      console.log(`Successes in a row before error 84: min ${r.burstBefore84.min}, median ${r.burstBefore84.median}, max ${r.burstBefore84.max}`);
      const c = r.cooldown;
      console.log(`Cooldown: still blocked after waiting ${fmt(c.stillBlockedAfterMs)}; ` +
                  `cleared within ${fmt(c.clearedWithinMs_fromLast84)} of the last 84 ` +
                  `(${fmt(c.clearedWithinMs_fromFirst84)} of the first 84).`);
      if (c.stillBlockedAfterMs && c.clearedWithinMs_fromLast84 && c.stillBlockedAfterMs > c.clearedWithinMs_fromLast84) {
        console.log('Note: those bounds conflict, so the limit is probably a rolling window (count per period), not a fixed timeout.');
      }
      console.table(r.episodes.map((x, i) => ({
        '#': i + 1, started: new Date(x.start).toLocaleString(), okInARowBefore: x.burstBefore,
        okLast1m: x.ok1m, okLast10m: x.ok10m, okLast60m: x.ok60m, hits: x.hits,
        failedRetryGaps: x.failedGaps.map(fmt).join(', ') || '-',
        recoveredAfter_fromFirst: x.recoveredAt ? fmt(x.recoveredAt - x.start) : 'not yet',
        recoveredAfter_fromLast: x.recoveredAt ? fmt(x.recoveredAt - x.lastHit) : 'not yet',
        tabHidden: x.hiddenDuring,
      })));
    } else {
      console.log('No rate-limit (84) events recorded yet.');
    }
    if (r.reportedOkButStillListed) console.warn(`Removals reported OK but still listed at verify: ${r.reportedOkButStillListed}`);
    console.groupEnd();
    return r;
  }

  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function exportCSV() {
    const cols = [...new Set(tlog.flatMap(e => Object.keys(e)))];
    const esc = (v) => {
      if (v == null) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...tlog.map(e => cols.map(c => esc(e[c])).join(','))].join('\n');
    download(`slr_log_${acct}_${runId}.csv`, csv, 'text/csv');
    log(`Exported ${tlog.length} events to CSV.`);
  }
  function exportJSON() {
    download(`slr_log_${acct}_${runId}.json`,
             JSON.stringify({ config: CONFIG, report: buildReport('all'), events: tlog }, null, 2), 'application/json');
    log(`Exported ${tlog.length} events + report to JSON.`);
  }

  // ----------------------------------------------------------------- SLEEP
  // Sleeps in 1s slices (responsive stop) and logs how late it woke up (tab throttling).
  async function sleep(ms, label, meta = {}) {
    const start = Date.now(), end = start + ms;
    if (label) state.waitingUntil = end;
    let lastNotice = start;
    while (Date.now() < end && !state.stopRequested) {
      await new Promise(r => setTimeout(r, Math.min(1000, end - Date.now())));
      if (label && Date.now() - lastNotice >= 60000) {
        log(`${label}: ${fmt(end - Date.now())} remaining...`);
        lastNotice = Date.now();
      }
    }
    state.waitingUntil = null;
    const actual = Date.now() - start;
    if (label) record('cooldown', { label, plannedMs: ms, actualMs: actual, interrupted: state.stopRequested, ...meta });
    if (actual - ms > 5000) console.warn(`[SLR] Woke up ${fmt(actual - ms)} late - the tab was probably throttled.`);
  }

  // ----------------------------------------------------------------- PARSING
  function decodeName(b64) {
    try {
      const bin = atob(b64);
      return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch { return ''; }
  }

  function extractLicenses(doc, live) {
    const out = [];
    let rowsSeen = 0;
    doc.querySelectorAll('a[href^="javascript:RemoveFreeLicense"]').forEach(a => {
      let href = a.getAttribute('href') || '';
      try { href = decodeURIComponent(href); } catch { /* keep raw */ }
      const m = href.match(/RemoveFreeLicense\(\s*(\d+)\s*(?:,\s*'([^']*)')?/);
      if (!m) { record('parse_warning', { href: href.slice(0, 200) }); return; }
      const row = a.closest('tr');
      const cell = a.closest('td');
      let name = '';
      if (cell) {
        const c = cell.cloneNode(true);
        c.querySelectorAll('a[href^="javascript:"], div, span.free_license_remove_link').forEach(x => x.remove());
        name = c.textContent.replace(/\s+/g, ' ').trim().replace(/\s*\bRemove\b\s*$/i, '');
      }
      if (!name && m[2]) name = decodeName(m[2]);
      const cells = row ? [...row.querySelectorAll('td')] : [];
      const acquired = cells.length ? cells[0].textContent.trim() : '';
      const method = cells.length > 2 ? cells[cells.length - 1].textContent.replace(/\s+/g, ' ').trim() : '';
      out.push({ id: m[1], name: name || '(unknown name)', acquired, method, row: live ? row : null });
    });
    if (doc.querySelectorAll) rowsSeen = doc.querySelectorAll('table tr').length;
    return { list: out, rowsSeen };
  }

  // Only follow links that look like pagination (never ?l=language, ?cc=country, etc.)
  function extractPageLinks(doc, baseUrl) {
    const urls = new Set(); const ignored = new Set();
    doc.querySelectorAll('a[href]').forEach(a => {
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('javascript:') || raw.startsWith('#')) return;
      let u;
      try { u = new URL(raw, baseUrl); } catch { return; }
      u.hash = '';
      const samePath = u.origin === location.origin && u.pathname.replace(/\/$/, '').endsWith(LICENSES_PATH);
      if (!samePath) return;
      const keys = [...u.searchParams.keys()].map(k => k.toLowerCase());
      if (keys.length && keys.every(k => PAGE_PARAMS.has(k))) urls.add(u.href);
      else if (keys.length) ignored.add(u.search);
    });
    return { urls: [...urls], ignored: [...ignored] };
  }

  async function collectAll(useLiveDom) {
    const found = new Map();
    const add = (list) => list.forEach(l => { if (!found.has(l.id)) found.set(l.id, l); });
    const visited = new Set();
    const queue = [];
    const ignoredAll = new Set();
    const startUrl = location.origin + location.pathname;

    if (useLiveDom) {
      const { list, rowsSeen } = extractLicenses(document, true);
      add(list);
      visited.add(location.href.split('#')[0]); visited.add(startUrl);
      const links = extractPageLinks(document, location.href);
      links.urls.forEach(u => queue.push(u));
      links.ignored.forEach(s => ignoredAll.add(s));
      record('page', { url: location.href, source: 'live', removable: list.length, rowsSeen, pageLinks: links.urls.length });
      log(`Current page: ${list.length} removable of ~${rowsSeen} table rows; ${links.urls.length} pagination link(s) found.`);
      if (!CONFIG.crawlPages) return [...found.values()];
    } else {
      queue.push(startUrl);
    }

    let pages = 0;
    while (queue.length && pages < CONFIG.maxPages && !state.stopRequested) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      pages++;
      const t0 = performance.now();
      try {
        const res = await fetch(url, { credentials: 'include' });
        const ms = Math.round(performance.now() - t0);
        if (res.status === 429) {
          record('page', { url, http: 429, ms });
          log(`Page fetch rate-limited (429). Waiting ${fmt(CONFIG.rateLimitWaitMs)}...`);
          visited.delete(url); queue.unshift(url); pages--;
          await sleep(CONFIG.rateLimitWaitMs, 'Page-crawl cooldown');
          continue;
        }
        if (res.redirected && !new URL(res.url).pathname.includes(LICENSES_PATH)) {
          record('page', { url, http: res.status, ms, redirectedTo: res.url });
          console.error(`[SLR] Page fetch redirected to ${res.url} - you are probably logged out. Crawl stopped.`);
          throw Object.assign(new Error('redirected'), { fatal: true });
        }
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const { list, rowsSeen } = extractLicenses(doc, false);
        const before = found.size;
        add(list);
        const links = extractPageLinks(doc, url);
        links.urls.forEach(u => { if (!visited.has(u)) queue.push(u); });
        links.ignored.forEach(s => ignoredAll.add(s));
        record('page', { url, http: res.status, ms, removable: list.length, newUnique: found.size - before, rowsSeen });
        log(`Scanned ${url.replace(location.origin, '')}: ${list.length} removable (+${found.size - before} new, total ${found.size}) in ${ms} ms`);
      } catch (e) {
        if (e.fatal) throw e;
        record('page', { url, error: String(e) });
        console.error(`[SLR] Failed to fetch ${url}`, e);
      }
      if (queue.length) await sleep(CONFIG.pageFetchDelayMs);
    }
    if (pages >= CONFIG.maxPages) console.warn(`[SLR] Hit maxPages (${CONFIG.maxPages}); some pages may be unscanned.`);
    if (ignoredAll.size) dbg('Ignored non-pagination links on the licenses path:', [...ignoredAll]);
    if (useLiveDom && pages === 0) {
      log('No pagination links found. If Steam shows more pages than this, scroll them all in with ' +
          'Pagetual first, then run again (it reads what is on screen). ' +
          (ignoredAll.size ? `Ignored query links: ${[...ignoredAll].join(' ')}` : ''));
    }
    return [...found.values()];
  }

  // ----------------------------------------------------------------- REMOVE
  async function removeOnce(lic) {
    const prev = lastRemoveEvent();
    const base = { id: lic.id, name: lic.name, method: lic.method,
                   sincePrevReqMs: prev ? Date.now() - prev.t : null,
                   ok1m: okCountSince(60e3), ok10m: okCountSince(600e3), ok60m: okCountSince(3600e3),
                   okStreak: currentStreak() };
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(REMOVE_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                   'X-Requested-With': 'XMLHttpRequest' },
        body: `sessionid=${encodeURIComponent(g_sessionID)}&packageid=${encodeURIComponent(lic.id)}`,
      });
    } catch (e) {
      return record('remove', { ...base, result: 'fail', detail: `network error: ${e.message}`,
                                ms: Math.round(performance.now() - t0) });
    }
    const ms = Math.round(performance.now() - t0);
    const ra = res.headers.get('Retry-After');
    const retryAfterMs = ra ? (isNaN(ra) ? Math.max(0, Date.parse(ra) - Date.now()) : Number(ra) * 1000) : null;
    const text = await res.text().catch(() => '');
    const common = { ...base, http: res.status, ms, retryAfterMs };

    if (res.status === 429) return record('remove', { ...common, result: 'ratelimit', detail: 'HTTP 429', raw: text.slice(0, 200) });
    if (res.status === 401 || res.status === 403) return record('remove', { ...common, result: 'fatal', detail: `HTTP ${res.status} (session expired?)` });
    if (!res.ok) return record('remove', { ...common, result: 'fail', detail: `HTTP ${res.status} ${res.statusText}`, raw: text.slice(0, 200) });

    let data;
    try { data = JSON.parse(text); } catch {
      return record('remove', { ...common, result: 'fatal', detail: 'Non-JSON response (probably logged out)', raw: text.slice(0, 200) });
    }
    const code = Number(data.success);
    const extra = Object.keys(data).filter(k => k !== 'success');
    const ev = { ...common, eresult: code, eresultName: EResultName[code] || 'Unknown',
                 extraKeys: extra.length ? extra.join('|') : undefined,
                 raw: code === 1 ? undefined : text.slice(0, 200) };
    if (code === 1)  return record('remove', { ...ev, result: 'ok' });
    if (code === 84) return record('remove', { ...ev, result: 'ratelimit', detail: 'Steam error 84' });
    return record('remove', { ...ev, result: 'fail', detail: `Steam error ${data.success} (${ev.eresultName})` });
  }

  // ----------------------------------------------------------------- VERIFY
  async function verify() {
    state.stopRequested = false;
    log('Verifying against a fresh copy of the licenses page...');
    let remaining;
    try { remaining = new Set((await collectAll(false)).map(l => l.id)); }
    catch { console.error('[SLR] Verify aborted.'); return; }
    const notGone = [...removedIds].filter(id => remaining.has(id));
    record('verify', { savedRemoved: removedIds.size, stillListed: remaining.size, notGone: notGone.length,
                       notGoneIds: notGone.slice(0, 50).join('|') || undefined });
    if (notGone.length) {
      console.warn(`[SLR] ${notGone.length} IDs were reported removed but are still listed:`, notGone);
      notGone.forEach(id => removedIds.delete(id)); saveRemoved();
    } else {
      log(`✔ Verified: none of the ${removedIds.size} saved removals are still listed. ` +
          `${remaining.size} removable licenses remain. Refresh with Ctrl+F5 to see it.`);
    }
  }

  // ----------------------------------------------------------------- PUBLIC API
  window.SLR = {
    version: VERSION,
    get running() { return state.running; },
    stop()  { state.stopRequested = true; state.userStopped = true; console.warn('[SLR] Stop requested - finishing current step...'); },
    reset() { localStorage.removeItem(STORAGE_KEY); removedIds.clear(); console.log('[SLR] Saved progress cleared.'); },
    clearLog() { tlog = []; localStorage.removeItem(LOG_KEY); console.log('[SLR] Telemetry cleared.'); },
    status() {
      const wait = state.waitingUntil ? ` | waiting, resumes ${new Date(state.waitingUntil).toLocaleTimeString()}` : '';
      console.log(`[SLR] ${state.running ? 'Running' : 'Idle'} | removed ${state.removed}/${state.total} | ` +
                  `skipped ${state.skipped} | rate-limit hits ${state.rateLimitHits} | ` +
                  `OK last 10m ${okCountSince(600e3)}, last 60m ${okCountSince(3600e3)}${wait}`);
    },
    report: printReport,
    exportCSV, exportJSON,
    verify: () => (state.running ? console.warn('[SLR] Wait until the run finishes or stop it first.') : verify()),
  };

  // ----------------------------------------------------------------- MAIN
  record('run_start', { config: JSON.stringify(CONFIG), url: location.href, ua: navigator.userAgent });
  const finish = (reason) => {
    state.running = false; state.current = null;
    document.removeEventListener('visibilitychange', onVisibility);
    record('run_end', { reason, removed: state.removed, skipped: state.skipped, rateLimitHits: state.rateLimitHits });
  };

  log(`v${VERSION} - collecting removable licenses...`);
  let all;
  try { all = await collectAll(true); }
  catch { finish('crawl_failed'); return; }

  const todo = all.filter(l => !removedIds.has(l.id));
  state.total = todo.length;

  if (!all.length) { log('No removable (free) licenses found.'); finish('nothing_found'); return; }
  console.table(todo.map(l => ({ packageId: l.id, name: l.name, acquired: l.acquired, method: l.method })));
  log(`Found ${all.length} removable licenses; ${todo.length} to do ` +
      `(${all.length - todo.length} already removed in a previous run on this account).`);
  record('collected', { found: all.length, todo: todo.length });

  if (CONFIG.dryRun) { log('Dry run - nothing removed.'); finish('dry_run'); return; }
  if (!todo.length) { finish('nothing_to_do'); return; }
  const etaMin = Math.round(todo.length * CONFIG.delayMs / 60000);
  if (!confirm(`Remove ${todo.length} free licenses?\n\nAt ~${CONFIG.delayMs / 1000}s each this takes ` +
               `~${etaMin} min, plus any rate-limit cooldowns.\nKeep this tab in the foreground.`)) {
    log('Cancelled.'); finish('cancelled'); return;
  }

  let backoff = CONFIG.rateLimitWaitMs;

  outer:
  for (let i = 0; i < todo.length && !state.stopRequested; i++) {
    const lic = todo[i];
    state.current = lic.id;
    let otherFailures = 0, rlRetries = 0;

    while (!state.stopRequested) {
      log(`(${i + 1}/${todo.length}) Removing ${lic.id} - ${lic.name}`);
      const r = await removeOnce(lic);
      dbg('Response:', r);

      if (r.result === 'ok') {
        state.removed++;
        removedIds.add(lic.id); saveRemoved();
        backoff = CONFIG.rateLimitWaitMs;
        lic.row?.remove();
        log(`✅ Removed ${lic.id} (${r.ms} ms). Total ${state.removed}/${todo.length} | ` +
            `OK last 10m: ${okCountSince(600e3)}, last 60m: ${okCountSince(3600e3)}`);
        break;
      }
      if (r.result === 'ratelimit') {
        state.rateLimitHits++; rlRetries++;
        if (CONFIG.maxRateLimitRetries && rlRetries > CONFIG.maxRateLimitRetries) {
          state.skipped++;
          log(`⚠️ Skipping ${lic.id}: still rate-limited after ${CONFIG.maxRateLimitRetries} retries.`);
          break;
        }
        const wait = Math.max(backoff, r.retryAfterMs || 0);
        log(`⏳ Rate limited (${r.detail}) on ${lic.id} after ${r.okStreak} successes in a row ` +
            `(${r.ok10m} in last 10m, ${r.ok60m} in last 60m). Nothing removed. ` +
            `Waiting ${fmt(wait)}${r.retryAfterMs ? ' (Retry-After)' : ''}, then retrying.`);
        await sleep(wait, 'Rate-limit cooldown', { id: lic.id, attempt: rlRetries });
        backoff = Math.min(backoff * 2, CONFIG.rateLimitMaxWaitMs);
        continue;
      }
      if (r.result === 'fatal') {
        console.error(`[SLR] ❌ Stopping: ${r.detail}`);
        state.stopRequested = true;
        break outer;
      }
      otherFailures++;
      if (otherFailures > CONFIG.maxOtherFailures) {
        state.skipped++;
        log(`⚠️ Skipping ${lic.id} after ${otherFailures} failures (${r.detail}).`);
        break;
      }
      log(`⚠️ ${lic.id} failed (${r.detail}). Retry ${otherFailures}/${CONFIG.maxOtherFailures} shortly...`);
      await sleep(jitter(CONFIG.delayMs));
    }

    if (i < todo.length - 1 && !state.stopRequested) await sleep(jitter(CONFIG.delayMs));
  }

  const stoppedEarly = state.stopRequested;
  finish(state.userStopped ? 'user_stopped' : stoppedEarly ? 'fatal' : 'complete');
  log(`Done. Removed: ${state.removed} | Skipped: ${state.skipped} | Rate-limit hits: ${state.rateLimitHits}` +
      (stoppedEarly ? ' | (stopped early)' : ''));

  if (CONFIG.verifyAtEnd && state.removed > 0) {
    if (stoppedEarly) log('Skipping verify because the run was stopped. Run SLR.verify() when ready.');
    else await verify();
  }
  printReport('run');
  log('Tip: SLR.report() analyses all runs; SLR.exportCSV() downloads the full log to share.');
})();
