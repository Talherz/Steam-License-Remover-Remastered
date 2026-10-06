// ==UserScript==
// @name         Steam License Remover (adaptive pacing + telemetry)
// @version      3.2
// @description  Remove "Free" licenses from your Steam account. Crawls all license pages,
//               checks Steam's real result code, paces itself to Steam's rate limit, and
//               records telemetry so the limit can be measured.
// @author       IroN404 (original), Beardox (fork), v3.x fixes
// @match        https://store.steampowered.com/account/licenses/*
// ==/UserScript==
//
// HOW TO USE
//   1. Go to https://store.steampowered.com/account/licenses/ (logged in).
//   2. F12 -> Console -> paste this whole script -> Enter.
//   3. Review the table + confirm box. Keep the tab in the FOREGROUND (or in its own window).
//
// CONSOLE COMMANDS
//   SLR.status()          live progress + current pace
//   SLR.stop()            stop after the current step
//   SLR.report()          rate-limit analysis across ALL runs (SLR.report('run') = this run only)
//   SLR.exportCSV()       download every logged event as CSV
//   SLR.exportJSON()      download the raw telemetry + report as JSON
//   SLR.verify()          re-check the licenses page and confirm removals are really gone
//   SLR.reset()           forget saved progress (removed IDs) for this account
//   SLR.clearLog()        wipe telemetry for this account
//
// v3.2 CHANGES (from the 2026-10-05 telemetry: 39 OK / 39 x error 84 / 12 x error 29 over 6.6 h)
//   - FIX: pagination. Steam pages with ?continuationToken=...&offset=100. v3.1 only allowed
//     p/page/start/offset, so it rejected every real "next page" link. continuationToken is now
//     allowed. If no links are found it logs the candidate "next" elements so we can adapt.
//   - FIX: error 29 (DuplicateRequest) was retried 3x per item. Steam returns it for
//     "Free Weekend" licenses, which can't be removed. Non-retryable codes are skipped at
//     once, and names matching skipNameRegex are left out before the run starts.
//   - NEW: adaptive pacing. v3.1 tried again 15 s after every success, which caused an
//     error 84 every cycle (~1 removal / 10 min). v3.2 waits `pace` after each success,
//     starting at 3 min (SteamDB figure). Each 84 lengthens the pace; a run of successes
//     shortens it. It settles just above Steam's actual refill interval.
//   - NEW: report section "gap after a success -> result": the shortest gap that worked and
//     the longest that failed, which brackets the real refill interval.
//
// v3.1 CHANGES (from review of v3.0)
//   - Crawler no longer follows language/country links (?l=french ...).
//   - Progress and telemetry stored per Steam account.
//   - Login redirects detected; SLR.stop() no longer undone by verify; Retry-After honoured.
//   - Names read from the table row; rows removed by element reference.

(async () => {
  'use strict';

  // ----------------------------------------------------------------- CONFIG
  const CONFIG = {
    // Adaptive pacing (wait after each SUCCESS before the next removal)
    paceStartMs:          3 * 60 * 1000,   // starting pace (SteamDB: 1 package / 3 min after the burst)
    paceMinMs:            2 * 60 * 1000,   // never go faster than this
    paceMaxMs:            15 * 60 * 1000,  // never go slower than this
    paceUpMs:             60 * 1000,       // add this to the pace after each error 84 that follows a success
    paceDownMs:           30 * 1000,       // subtract this after `paceDownAfterOk` successes in a row
    paceDownAfterOk:      4,
    jitterMs:             3000,            // +/- random jitter on every pause
    rateLimitMaxWaitMs:   60 * 60 * 1000,  // cap for repeated 84s on the same license (pace x2, x4, ...)
    maxRateLimitRetries:  0,               // per license; 0 = retry forever

    // Failures
    nonRetryableCodes:    [29],            // EResults that mean "can't remove this one": skip, no retry
    skipNameRegex:        /free weekend/i, // left out before the run (Steam returns 29 for these); null = off
    delayMs:              15000,           // pause before retrying a non-rate-limit failure / after a skip
    maxOtherFailures:     2,

    // Crawling
    crawlPages:           true,
    pageFetchDelayMs:     1500,
    maxPages:             200,

    // Misc
    verifyAtEnd:          true,
    dryRun:               false,           // true = list what would be removed, remove nothing
    maxLogEvents:         5000,
    verbose:              false,
  };

  const VERSION       = '3.2';
  const LICENSES_PATH = '/account/licenses';
  const REMOVE_URL    = 'https://store.steampowered.com/account/removelicense';
  const PAGE_PARAMS   = new Set(['p', 'page', 'start', 'offset', 'pagenum', 'pg', 'continuationtoken', 'cursor']);
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
    current: null, waitingUntil: null, pace: CONFIG.paceStartMs,
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
    catch { tlog.splice(0, Math.ceil(tlog.length / 4));
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
  // Last remove attempt that actually hit Steam's limiter (ok or 84) - skips/failures don't count.
  function lastLimiterEvent() {
    for (let i = tlog.length - 1; i >= 0; i--) {
      const e = tlog[i];
      if (e.type === 'remove' && (e.result === 'ok' || e.result === 'ratelimit')) return e;
    }
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
    const lim = rem.filter(e => e.result === 'ok' || e.result === 'ratelimit');
    const by  = (k) => rem.filter(e => e.result === k).length;
    const okTimes = lim.filter(e => e.result === 'ok').map(e => e.t);

    // Gap since the previous limiter event, split by what that previous event was
    const gaps = { afterOk: { ok: [], rl: [] }, after84: { ok: [], rl: [] } };
    for (let i = 1; i < lim.length; i++) {
      const g = lim[i].t - lim[i - 1].t;
      const bucket = lim[i - 1].result === 'ok' ? gaps.afterOk : gaps.after84;
      (lim[i].result === 'ok' ? bucket.ok : bucket.rl).push(g);
    }
    const bound = (b) => ({ attempts: b.ok.length + b.rl.length, ok: b.ok.length, rateLimited: b.rl.length,
                            shortestThatWorkedMs: b.ok.length ? Math.min(...b.ok) : null,
                            longestThatFailedMs:  b.rl.length ? Math.max(...b.rl) : null });

    // Success rate by the pace that was in effect
    const paceBuckets = {};
    for (let i = 1; i < lim.length; i++) {
      const e = lim[i];
      if (lim[i - 1].result !== 'ok' || !e.paceMs) continue;
      const k = fmt(e.paceMs);
      const b = paceBuckets[k] || (paceBuckets[k] = { pace: k, paceMs: e.paceMs, attempts: 0, ok: 0, rateLimited: 0 });
      b.attempts++; if (e.result === 'ok') b.ok++; else b.rateLimited++;
    }

    // Rate-limit episodes
    const episodes = []; let ep = null; let streak = 0;
    for (const e of lim) {
      if (e.result === 'ok') {
        if (ep) { ep.recoveredAt = e.t; episodes.push(ep); ep = null; }
        streak++;
      } else {
        if (!ep) ep = { start: e.t, lastHit: e.t, hits: 1, burstBefore: streak, ok60m: e.ok60m, failedGaps: [], hiddenDuring: false };
        else { ep.failedGaps.push(e.t - ep.lastHit); ep.hits++; ep.lastHit = e.t; }
        if (e.hidden) ep.hiddenDuring = true;
        streak = 0;
      }
    }
    if (ep) episodes.push(ep);

    const lat = rem.map(e => e.ms).filter(n => typeof n === 'number');
    const otherCodes = {};
    rem.filter(e => e.result === 'fail' || e.result === 'fatal' || e.result === 'skip')
       .forEach(e => { const k = e.eresult != null ? `EResult ${e.eresult} (${e.result})` : (e.http ? `HTTP ${e.http}` : e.detail);
                       otherCodes[k] = (otherCodes[k] || 0) + 1; });
    const verifies = ev.filter(e => e.type === 'verify');

    return {
      scope, account: acct, generated: new Date().toISOString(),
      attempts: rem.length, ok: by('ok'), rateLimited: by('ratelimit'), skipped: by('skip'),
      failed: by('fail'), fatal: by('fatal'), otherCodes,
      spanMs: rem.length ? rem[rem.length - 1].t - rem[0].t : 0,
      okPerHour: rem.length > 1 ? +(by('ok') / ((rem[rem.length - 1].t - rem[0].t) / 3.6e6)).toFixed(2) : null,
      latencyMs: { median: pct(lat, 0.5), p95: pct(lat, 0.95) },
      maxSuccessesObserved: { per10m: maxInWindow(okTimes, 600e3), per60m: maxInWindow(okTimes, 3600e3),
                              per24h: maxInWindow(okTimes, 86400e3) },
      gapAfterSuccess: bound(gaps.afterOk), gapAfter84: bound(gaps.after84),
      paceBuckets: Object.values(paceBuckets).sort((a, b) => a.paceMs - b.paceMs),
      episodes, pages: ev.filter(e => e.type === 'page').length,
      reportedOkButStillListed: verifies.reduce((n, v) => n + (v.notGone || 0), 0),
    };
  }

  function printReport(scope = 'all') {
    const r = buildReport(scope);
    console.group(`[SLR] Report (${scope === 'run' ? 'this run' : 'all runs'}) - account ${acct}`);
    console.log(`Attempts ${r.attempts} | OK ${r.ok} | rate-limited ${r.rateLimited} | skipped ${r.skipped} | ` +
                `failed ${r.failed} | fatal ${r.fatal} | span ${fmt(r.spanMs)} | ${r.okPerHour ?? '-'} removals/hour`);
    if (Object.keys(r.otherCodes).length) console.log('Non-OK, non-84 codes:', r.otherCodes);
    console.log(`Request latency: median ${r.latencyMs.median ?? '-'} ms, p95 ${r.latencyMs.p95 ?? '-'} ms`);
    console.log('Most successful removals seen in any window:', r.maxSuccessesObserved);
    const a = r.gapAfterSuccess, b = r.gapAfter84;
    console.log(`Gap after a SUCCESS -> next result: worked at >= ${fmt(a.shortestThatWorkedMs)}, ` +
                `failed (84) at up to ${fmt(a.longestThatFailedMs)}  [${a.ok} ok / ${a.rateLimited} x 84]`);
    console.log(`Gap after an 84 -> next result:     worked at >= ${fmt(b.shortestThatWorkedMs)}, ` +
                `failed (84) at up to ${fmt(b.longestThatFailedMs)}  [${b.ok} ok / ${b.rateLimited} x 84]`);
    console.log('The refill interval lies between "longest that failed" and "shortest that worked".');
    if (r.paceBuckets.length) { console.log('Success rate by pace (attempts right after a success):'); console.table(r.paceBuckets); }
    if (r.episodes.length) {
      console.log(`Rate-limit episodes: ${r.episodes.length}`);
      console.table(r.episodes.slice(-20).map((x, i) => ({
        started: new Date(x.start).toLocaleString(), okInARowBefore: x.burstBefore, okLast60m: x.ok60m, hits: x.hits,
        recoveredAfter_fromLast84: x.recoveredAt ? fmt(x.recoveredAt - x.lastHit) : 'not yet', tabHidden: x.hiddenDuring,
      })));
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
    download(`slr_log_${acct}_${runId}.csv`, '\uFEFF' + csv, 'text/csv');
    log(`Exported ${tlog.length} events to CSV.`);
  }
  function exportJSON() {
    download(`slr_log_${acct}_${runId}.json`,
             JSON.stringify({ config: { ...CONFIG, skipNameRegex: String(CONFIG.skipNameRegex) },
                              report: buildReport('all'), events: tlog }, null, 2), 'application/json');
    log(`Exported ${tlog.length} events + report to JSON.`);
  }

  // ----------------------------------------------------------------- SLEEP
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
    return { list: out, rowsSeen: doc.querySelectorAll('table tr').length };
  }

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

  function logPaginationCandidates() {
    const cands = [...document.querySelectorAll('a, button, [onclick], [role="button"]')]
      .filter(el => /next|›|»|continuation|offset/i.test(
        (el.textContent || '') + ' ' + (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '')))
      .slice(0, 15).map(el => el.outerHTML.slice(0, 250));
    record('pagination_debug', { candidates: cands.join(' || ') || 'none' });
    if (cands.length) console.log('[SLR] Possible pagination elements (send these to Copilot if paging fails):', cands);
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
          log('Page fetch rate-limited (429). Waiting 10m...');
          visited.delete(url); queue.unshift(url); pages--;
          await sleep(600000, 'Page-crawl cooldown');
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
        record('page', { url, http: res.status, ms, removable: list.length, newUnique: found.size - before,
                         rowsSeen, pageLinks: links.urls.length });
        log(`Scanned ${url.replace(location.origin, '')}: ${list.length} removable (+${found.size - before} new, total ${found.size})`);
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
      logPaginationCandidates();
      log('No pagination links found. If Steam shows more pages, scroll them all in with Pagetual first, ' +
          'then run again (it reads what is on screen).');
    }
    return [...found.values()];
  }

  // ----------------------------------------------------------------- REMOVE
  async function removeOnce(lic, paceMs) {
    const prev = lastLimiterEvent();
    const base = { id: lic.id, name: lic.name, method: lic.method, paceMs,
                   prevResult: prev ? prev.result : null,
                   sincePrevReqMs: prev ? Date.now() - prev.t : null,
                   ok10m: okCountSince(600e3), ok60m: okCountSince(3600e3), okStreak: currentStreak() };
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
    if (CONFIG.nonRetryableCodes.includes(code))
      return record('remove', { ...ev, result: 'skip', detail: `Steam error ${code} (${ev.eresultName}) - not removable` });
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
      const wait = state.waitingUntil ? ` | next attempt ${new Date(state.waitingUntil).toLocaleTimeString()}` : '';
      console.log(`[SLR] ${state.running ? 'Running' : 'Idle'} | removed ${state.removed}/${state.total} | ` +
                  `skipped ${state.skipped} | 84s ${state.rateLimitHits} | pace ${fmt(state.pace)} | ` +
                  `OK last 60m ${okCountSince(3600e3)}${wait}`);
    },
    report: printReport,
    exportCSV, exportJSON,
    verify: () => (state.running ? console.warn('[SLR] Wait until the run finishes or stop it first.') : verify()),
  };

  // ----------------------------------------------------------------- MAIN
  record('run_start', { config: JSON.stringify({ ...CONFIG, skipNameRegex: String(CONFIG.skipNameRegex) }),
                        url: location.href, ua: navigator.userAgent });
  const finish = (reason) => {
    state.running = false; state.current = null;
    document.removeEventListener('visibilitychange', onVisibility);
    record('run_end', { reason, removed: state.removed, skipped: state.skipped, rateLimitHits: state.rateLimitHits,
                        finalPaceMs: state.pace });
  };

  log(`v${VERSION} - collecting removable licenses...`);
  let all;
  try { all = await collectAll(true); }
  catch { finish('crawl_failed'); return; }

  const preSkipped = CONFIG.skipNameRegex ? all.filter(l => CONFIG.skipNameRegex.test(l.name)) : [];
  if (preSkipped.length) {
    log(`Leaving out ${preSkipped.length} license(s) matching ${CONFIG.skipNameRegex} (Steam won't remove them):`,
        preSkipped.map(l => l.name));
    record('preskip', { count: preSkipped.length, ids: preSkipped.map(l => l.id).join('|') });
  }
  const todo = all.filter(l => !removedIds.has(l.id) && !preSkipped.includes(l));
  state.total = todo.length;

  if (!all.length) { log('No removable (free) licenses found.'); finish('nothing_found'); return; }
  console.table(todo.map(l => ({ packageId: l.id, name: l.name, acquired: l.acquired, method: l.method })));
  log(`Found ${all.length} removable licenses; ${todo.length} to do ` +
      `(${all.length - todo.length - preSkipped.length} already removed in a previous run on this account).`);
  record('collected', { found: all.length, todo: todo.length });

  if (CONFIG.dryRun) { log('Dry run - nothing removed.'); finish('dry_run'); return; }
  if (!todo.length) { finish('nothing_to_do'); return; }
  const etaFast = fmt(todo.length * CONFIG.paceStartMs), etaSlow = fmt(todo.length * 10.3 * 60000);
  if (!confirm(`Remove ${todo.length} free licenses?\n\nSteam allows roughly one removal every 3-10 minutes, ` +
               `so this takes about ${etaFast} to ${etaSlow}.\nKeep this tab in the foreground (or in its own window).`)) {
    log('Cancelled.'); finish('cancelled'); return;
  }

  const clamp = (ms) => Math.min(CONFIG.paceMaxMs, Math.max(CONFIG.paceMinMs, ms));
  let okRun = 0;
  log(`Starting pace: one removal every ${fmt(state.pace)} (adjusts automatically).`);

  outer:
  for (let i = 0; i < todo.length && !state.stopRequested; i++) {
    const lic = todo[i];
    state.current = lic.id;
    let otherFailures = 0, rlRetries = 0;
    let usedLimiter = false;

    while (!state.stopRequested) {
      log(`(${i + 1}/${todo.length}) Removing ${lic.id} - ${lic.name}`);
      const r = await removeOnce(lic, state.pace);
      dbg('Response:', r);

      if (r.result === 'ok') {
        state.removed++; okRun++; usedLimiter = true;
        removedIds.add(lic.id); saveRemoved();
        lic.row?.remove();
        if (okRun >= CONFIG.paceDownAfterOk && state.pace > CONFIG.paceMinMs) {
          const old = state.pace; state.pace = clamp(state.pace - CONFIG.paceDownMs); okRun = 0;
          record('pace', { from: old, to: state.pace, reason: 'ok_streak' });
          log(`↘ ${CONFIG.paceDownAfterOk} successes in a row - pace ${fmt(old)} -> ${fmt(state.pace)}`);
        }
        log(`✅ Removed ${lic.id} (${r.ms} ms). Total ${state.removed}/${todo.length} | ` +
            `OK last 60m: ${okCountSince(3600e3)} | next in ~${fmt(state.pace)}`);
        break;
      }
      if (r.result === 'ratelimit') {
        state.rateLimitHits++; rlRetries++; okRun = 0;
        if (CONFIG.maxRateLimitRetries && rlRetries > CONFIG.maxRateLimitRetries) {
          state.skipped++;
          log(`⚠️ Skipping ${lic.id}: still rate-limited after ${CONFIG.maxRateLimitRetries} retries.`);
          break;
        }
        // Lengthen the pace only when the 84 came right after a success (the pace was too short).
        if (r.prevResult === 'ok') {
          const old = state.pace; state.pace = clamp(state.pace + CONFIG.paceUpMs);
          if (state.pace !== old) { record('pace', { from: old, to: state.pace, reason: 'rate_limited' });
                                    log(`↗ Pace ${fmt(old)} -> ${fmt(state.pace)}`); }
        }
        const wait = Math.max(Math.min(state.pace * 2 ** (rlRetries - 1), CONFIG.rateLimitMaxWaitMs), r.retryAfterMs || 0);
        log(`⏳ Rate limited (${r.detail}) ${fmt(r.sincePrevReqMs)} after the previous ${r.prevResult || ''} request. ` +
            `Nothing removed. Waiting ${fmt(wait)}, then retrying ${lic.id}.`);
        await sleep(wait, 'Rate-limit cooldown', { id: lic.id, attempt: rlRetries, paceMs: state.pace });
        continue;
      }
      if (r.result === 'fatal') {
        console.error(`[SLR] ❌ Stopping: ${r.detail}`);
        state.stopRequested = true;
        break outer;
      }
      if (r.result === 'skip') {
        state.skipped++;
        log(`⏭ Skipping ${lic.id} - ${lic.name}: ${r.detail}.`);
        break;
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

    if (i < todo.length - 1 && !state.stopRequested) {
      // After a success wait the pace; after a skip/failure only the short delay.
      if (usedLimiter) await sleep(jitter(state.pace), 'Pacing', { paceMs: state.pace });
      else await sleep(jitter(CONFIG.delayMs));
    }
  }

  const stoppedEarly = state.stopRequested;
  finish(state.userStopped ? 'user_stopped' : stoppedEarly ? 'fatal' : 'complete');
  log(`Done. Removed: ${state.removed} | Skipped: ${state.skipped} | Rate-limit hits: ${state.rateLimitHits} | ` +
      `final pace ${fmt(state.pace)}${stoppedEarly ? ' | (stopped early)' : ''}`);

  if (CONFIG.verifyAtEnd && state.removed > 0) {
    if (stoppedEarly) log('Skipping verify because the run was stopped. Run SLR.verify() when ready.');
    else await verify();
  }
  printReport('run');
  log('Tip: SLR.report() analyses all runs; SLR.exportCSV() downloads the full log to share.');
})();
