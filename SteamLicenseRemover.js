// ==UserScript==
// @name         Steam License Remover (burst + steady pacing, session recovery, telemetry)
// @version      3.3
// @description  Remove "Free" licenses from your Steam account. Streams license pages as it goes,
//               checks Steam's real result code, paces itself to the measured rate limit,
//               recovers from expired sessions / network drops, and records telemetry.
// @author       IroN404 (original), Beardox (fork), v3.x fixes
// @match        https://store.steampowered.com/account/licenses/*
// ==/UserScript==
//
// HOW TO USE
//   1. Go to https://store.steampowered.com/account/licenses/ (logged in).
//   2. F12 -> Console -> paste this whole script -> Enter. Confirm the dialog.
//   3. Keep the tab in its own window (background tabs get throttled).
//
// CONSOLE COMMANDS
//   SLR.status()   SLR.stop()   SLR.report()   SLR.report('run')
//   SLR.exportCSV()   SLR.exportJSON()   SLR.verify()   SLR.reset()   SLR.clearLog()
//
// v3.3 CHANGES (from the 2026-10-08/09 telemetry: 133 OK / 20 x 84 over 20.3 h, then a fatal stop)
//   - Measured limit: a rested account allowed 15 removals in ~35 min (2 runs), then ~6/hour.
//     Gap after a success -> success rate: 8 min 68%, 9 min 96%, 10 min 100%.
//     New pacing: BURST (2 min) only if the account has been idle >= 2.5 h, then STEADY at
//     9.5 min with a 9 min floor. v3.2 kept drifting down to 8 min and paid for it with 84s.
//   - FIX: the run died on a non-JSON (HTML) reply after ~20 h while you were still logged in.
//     Most likely Steam's login token expired: browsing the page renews it, but background
//     requests don't. v3.3 now loads the licenses page in a hidden iframe to renew the session,
//     re-reads the session ID, and retries (waits 1 / 5 / 15 min) before giving up. The page
//     <title> is logged so we can see what Steam sent.
//   - FIX: 3 "Failed to fetch" network errors in 40 s caused a license to be SKIPPED.
//     Network errors are now retried with backoff (1, 2, 5, 10 min...) and never skip.
//   - FIX: v3.2 crawled every page up front (up to 200 pages / 6 min) and stopped at the
//     maxPages cap - your account has more than 20,000 licenses. Pages are now loaded one at a time as
//     the run reaches them, so there is no cap and no 6-minute wait at the start.
//   - NEW: report shows success rate by gap length (in minutes) after a success.

(async () => {
  'use strict';

  // ----------------------------------------------------------------- CONFIG
  const CONFIG = {
    // Pacing (wait after each SUCCESS)
    burstPaceMs:        2 * 60 * 1000,    // used at start if the account has rested (measured: ~15 allowed)
    burstAfterIdleMs:   150 * 60 * 1000,  // "rested" = no successful removal for this long
    steadyPaceMs:       9.5 * 60 * 1000,  // measured: 9 min = 96% OK, 10 min = 100% OK
    steadyMinMs:        9 * 60 * 1000,    // never go below this once steady
    paceMaxMs:          15 * 60 * 1000,
    paceUpMs:           60 * 1000,        // after an 84 that followed a success
    paceDownMs:         15 * 1000,        // after `paceDownAfterOk` successes in a row
    paceDownAfterOk:    10,
    jitterMs:           3000,
    rateLimitMaxWaitMs: 60 * 60 * 1000,   // cap for repeated 84s on the same license

    // Failures / recovery
    nonRetryableCodes:  [29],             // e.g. Free Weekend licenses -> skip at once
    skipNameRegex:      /free weekend/i,  // left out before trying; null = off
    netBackoffMs:       [60e3, 120e3, 300e3, 600e3], // network errors: then repeats the last value
    netMaxRetries:      30,               // ~4.5 h of retrying before stopping
    sessionRetryWaitMs: [60e3, 300e3, 900e3], // HTML / 401 / 403 replies: refresh session, wait, retry
    delayMs:            15000,            // retry delay for other failures
    maxOtherFailures:   2,

    // Pages
    pageFetchDelayMs:   1500,
    maxPages:           1000,             // safety cap (100 licenses per page)

    // Misc
    verifyAtEnd:        true,
    dryRun:             false,            // true = scan all pages and count, remove nothing
    maxLogEvents:       5000,
    verbose:            false,
  };

  const VERSION       = '3.3';
  const LICENSES_PATH = '/account/licenses';
  const LICENSES_URL  = location.origin + LICENSES_PATH + '/';
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
  if (window.SLR && window.SLR.running) { console.warn('[SLR] Already running. Use SLR.stop() first.'); return; }

  let sessionID = g_sessionID;
  const acct = String((typeof g_steamID !== 'undefined' && g_steamID) ||
                      (typeof g_AccountID !== 'undefined' && g_AccountID) || 'unknown');
  const STORAGE_KEY = `slr_removed_${acct}`;
  const LOG_KEY     = `slr_log_${acct}`;

  // ----------------------------------------------------------------- STATE
  const state = {
    running: true, stopRequested: false, userStopped: false,
    removed: 0, skipped: 0, rateLimitHits: 0, pagesLoaded: 0, seen: 0,
    current: null, waitingUntil: null, pace: CONFIG.steadyPaceMs, mode: 'steady',
  };
  const removedIds = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  const removedThisRun = new Set();
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
  const htmlTitle = (t) => ((t || '').match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';

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
    for (let i = tlog.length - 1; i >= 0 && tlog[i].t >= cut; i--)
      if (tlog[i].type === 'remove' && tlog[i].result === 'ok') n++;
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
  function lastLimiterEvent() {
    for (let i = tlog.length - 1; i >= 0; i--) {
      const e = tlog[i];
      if (e.type === 'remove' && (e.result === 'ok' || e.result === 'ratelimit')) return e;
    }
    return null;
  }
  function lastOkTime() {
    for (let i = tlog.length - 1; i >= 0; i--)
      if (tlog[i].type === 'remove' && tlog[i].result === 'ok') return tlog[i].t;
    return null;
  }

  const onVisibility = () => {
    if (!state.running) return;
    record('visibility', { hidden: document.hidden });
    if (document.hidden) console.warn('[SLR] Tab hidden - Chrome may throttle timers.');
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ----------------------------------------------------------------- REPORT
  function maxInWindow(times, w) {
    let best = 0, j = 0;
    for (let i = 0; i < times.length; i++) { while (times[i] - times[j] > w) j++; best = Math.max(best, i - j + 1); }
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
    // limiter sequence per run (gaps across runs are not meaningful)
    const runs = {};
    rem.filter(e => e.result === 'ok' || e.result === 'ratelimit').forEach(e => (runs[e.run] = runs[e.run] || []).push(e));
    const gapBuckets = {}; const bursts = [];
    let okTimes = [];
    Object.values(runs).forEach(seq => {
      okTimes = okTimes.concat(seq.filter(e => e.result === 'ok').map(e => e.t));
      const k = seq.findIndex(e => e.result === 'ratelimit');
      if (k > 0) bursts.push({ run: seq[0].run, okBeforeFirst84: k, minutes: Math.round((seq[k].t - seq[0].t) / 60000) });
      for (let i = 1; i < seq.length; i++) {
        if (seq[i - 1].result !== 'ok') continue;
        const m = Math.round((seq[i].t - seq[i - 1].t) / 60000);
        const b = gapBuckets[m] || (gapBuckets[m] = { gapMin: m, attempts: 0, ok: 0, rateLimited: 0, okPct: 0 });
        b.attempts++; if (seq[i].result === 'ok') b.ok++; else b.rateLimited++;
        b.okPct = Math.round(100 * b.ok / b.attempts);
      }
    });
    okTimes.sort((a, b) => a - b);
    const lat = rem.map(e => e.ms).filter(n => typeof n === 'number');
    const otherCodes = {};
    rem.filter(e => !['ok', 'ratelimit'].includes(e.result))
       .forEach(e => { const k = `${e.result}: ${e.eresult != null ? 'EResult ' + e.eresult : e.http ? 'HTTP ' + e.http : e.detail}`;
                       otherCodes[k] = (otherCodes[k] || 0) + 1; });
    const span = rem.length ? rem[rem.length - 1].t - rem[0].t : 0;
    return {
      scope, account: acct, generated: new Date().toISOString(),
      attempts: rem.length, ok: by('ok'), rateLimited: by('ratelimit'), skipped: by('skip'),
      netErrors: by('net'), sessionErrors: by('session'), failed: by('fail'), fatal: by('fatal'), otherCodes,
      spanMs: span, okPerHour: span ? +(by('ok') / (span / 3.6e6)).toFixed(2) : null,
      latencyMs: { median: pct(lat, 0.5), p95: pct(lat, 0.95) },
      maxSuccessesObserved: { per60m: maxInWindow(okTimes, 3600e3), per3h: maxInWindow(okTimes, 3 * 3600e3),
                              per24h: maxInWindow(okTimes, 86400e3) },
      burstAtRunStart: bursts,
      gapAfterSuccess: Object.values(gapBuckets).sort((a, b) => a.gapMin - b.gapMin),
      sessionRecoveries: ev.filter(e => e.type === 'session_recovery').length,
      reportedOkButStillListed: ev.filter(e => e.type === 'verify').reduce((n, v) => n + (v.notGone || 0), 0),
    };
  }
  function printReport(scope = 'all') {
    const r = buildReport(scope);
    console.group(`[SLR] Report (${scope === 'run' ? 'this run' : 'all runs'}) - account ${acct}`);
    console.log(`Attempts ${r.attempts} | OK ${r.ok} | 84s ${r.rateLimited} | skipped ${r.skipped} | network ${r.netErrors} | ` +
                `session ${r.sessionErrors} | failed ${r.failed} | fatal ${r.fatal} | span ${fmt(r.spanMs)} | ${r.okPerHour ?? '-'} removals/hour`);
    if (Object.keys(r.otherCodes).length) console.log('Other results:', r.otherCodes);
    console.log('Most successful removals in any window:', r.maxSuccessesObserved);
    if (r.burstAtRunStart.length) { console.log('Successes before the first 84 of each run:'); console.table(r.burstAtRunStart); }
    if (r.gapAfterSuccess.length) { console.log('Gap after a success (minutes) -> result:'); console.table(r.gapAfterSuccess); }
    if (r.sessionRecoveries) console.log(`Session recoveries attempted: ${r.sessionRecoveries}`);
    if (r.reportedOkButStillListed) console.warn(`Removals reported OK but still listed at verify: ${r.reportedOkButStillListed}`);
    console.groupEnd();
    return r;
  }
  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function exportCSV() {
    const cols = [...new Set(tlog.flatMap(e => Object.keys(e)))];
    const esc = (v) => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
                         return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    download(`slr_log_${acct}_${runId}.csv`, '\uFEFF' + [cols.join(','), ...tlog.map(e => cols.map(c => esc(e[c])).join(','))].join('\n'), 'text/csv');
    log(`Exported ${tlog.length} events to CSV.`);
  }
  function exportJSON() {
    download(`slr_log_${acct}_${runId}.json`, JSON.stringify({ config: { ...CONFIG, skipNameRegex: String(CONFIG.skipNameRegex) },
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
      if (label && Date.now() - lastNotice >= 60000) { log(`${label}: ${fmt(end - Date.now())} remaining...`); lastNotice = Date.now(); }
    }
    state.waitingUntil = null;
    const actual = Date.now() - start;
    if (label) record('cooldown', { label, plannedMs: ms, actualMs: actual, interrupted: state.stopRequested, ...meta });
    if (actual - ms > 5000) console.warn(`[SLR] Woke up ${fmt(actual - ms)} late - the tab was probably throttled.`);
  }

  // ----------------------------------------------------------------- PARSING
  function decodeName(b64) {
    try { return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); } catch { return ''; }
  }
  function extractLicenses(doc, live) {
    const out = [];
    doc.querySelectorAll('a[href^="javascript:RemoveFreeLicense"]').forEach(a => {
      let href = a.getAttribute('href') || '';
      try { href = decodeURIComponent(href); } catch { /* keep raw */ }
      const m = href.match(/RemoveFreeLicense\(\s*(\d+)\s*(?:,\s*'([^']*)')?/);
      if (!m) { record('parse_warning', { href: href.slice(0, 200) }); return; }
      const row = a.closest('tr'), cell = a.closest('td');
      let name = '';
      if (cell) {
        const c = cell.cloneNode(true);
        c.querySelectorAll('a[href^="javascript:"], div, span.free_license_remove_link').forEach(x => x.remove());
        name = c.textContent.replace(/\s+/g, ' ').trim().replace(/\s*\bRemove\b\s*$/i, '');
      }
      if (!name && m[2]) name = decodeName(m[2]);
      const cells = row ? [...row.querySelectorAll('td')] : [];
      out.push({ id: m[1], name: name || '(unknown name)',
                 acquired: cells.length ? cells[0].textContent.trim() : '',
                 method: cells.length > 2 ? cells[cells.length - 1].textContent.replace(/\s+/g, ' ').trim() : '',
                 row: live ? row : null });
    });
    return { list: out, rowsSeen: doc.querySelectorAll('table tr').length };
  }
  function extractPageLinks(doc, baseUrl) {
    const urls = new Set();
    doc.querySelectorAll('a[href]').forEach(a => {
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('javascript:') || raw.startsWith('#')) return;
      let u; try { u = new URL(raw, baseUrl); } catch { return; }
      u.hash = '';
      if (u.origin !== location.origin || !u.pathname.replace(/\/$/, '').endsWith(LICENSES_PATH)) return;
      const keys = [...u.searchParams.keys()].map(k => k.toLowerCase());
      if (keys.length && keys.every(k => PAGE_PARAMS.has(k))) urls.add(u.href);
    });
    return [...urls];
  }

  // Fetch with network-error backoff. Returns Response, or null if stopped / gave up.
  async function fetchWithNetRetry(url, opts, what) {
    for (let attempt = 0; !state.stopRequested; attempt++) {
      try { return await fetch(url, opts); }
      catch (e) {
        if (attempt >= CONFIG.netMaxRetries) { console.error(`[SLR] ${what}: network still failing after ${attempt} retries.`); return null; }
        const wait = CONFIG.netBackoffMs[Math.min(attempt, CONFIG.netBackoffMs.length - 1)];
        record('net_error', { what, url: url.slice(0, 120), attempt: attempt + 1, error: String(e.message || e) });
        log(`🌐 Network error on ${what} (${e.message}). Retry ${attempt + 1} in ${fmt(wait)}...`);
        await sleep(wait, 'Network backoff');
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- PAGE STREAM
  // Yields one page of licenses at a time; starts with whatever is on screen.
  function makePageStream(startFromLive) {
    const visited = new Set(); const queue = [];
    let first = true;
    return {
      get pages() { return visited.size; },
      async next() {
        if (first && startFromLive) {
          first = false;
          visited.add(location.href.split('#')[0]); visited.add(LICENSES_URL);
          const { list, rowsSeen } = extractLicenses(document, true);
          extractPageLinks(document, location.href).forEach(u => queue.push(u));
          record('page', { url: location.href, source: 'live', removable: list.length, rowsSeen, pageLinks: queue.length });
          return list;
        }
        if (first) { first = false; queue.push(LICENSES_URL); }
        while (queue.length && visited.size < CONFIG.maxPages && !state.stopRequested) {
          const url = queue.shift();
          if (visited.has(url)) continue;
          visited.add(url);
          await sleep(CONFIG.pageFetchDelayMs);
          const t0 = performance.now();
          const res = await fetchWithNetRetry(url, { credentials: 'include' }, 'page load');
          if (!res) return null;
          const ms = Math.round(performance.now() - t0);
          if (res.status === 429) {
            record('page', { url, http: 429, ms });
            visited.delete(url); queue.unshift(url);
            await sleep(600000, 'Page-load cooldown (429)'); continue;
          }
          const html = await res.text();
          if (res.redirected && !new URL(res.url).pathname.includes(LICENSES_PATH)) {
            record('page', { url, http: res.status, ms, redirectedTo: res.url, title: htmlTitle(html) });
            visited.delete(url); queue.unshift(url);
            if (!(await recoverSession('page redirected to ' + res.url))) return null;
            continue;
          }
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const { list, rowsSeen } = extractLicenses(doc, false);
          extractPageLinks(doc, url).forEach(u => { if (!visited.has(u)) queue.push(u); });
          record('page', { url, http: res.status, ms, removable: list.length, rowsSeen });
          return list;
        }
        if (visited.size >= CONFIG.maxPages) console.warn(`[SLR] Reached maxPages (${CONFIG.maxPages}).`);
        return null;
      },
    };
  }

  // ----------------------------------------------------------------- SESSION RECOVERY
  // Loads the licenses page in a hidden iframe (a real page load, which lets Steam renew the
  // login token), then reads the fresh session ID from it.
  function loadFrame() {
    return new Promise(resolve => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;right:0;';
      const done = (ok) => { clearTimeout(timer); let sid = null, path = '';
        try { sid = f.contentWindow.g_sessionID || null; path = f.contentWindow.location.pathname; } catch { /* cross-origin = login page */ }
        f.remove(); resolve({ ok, sid, path }); };
      const timer = setTimeout(() => done(false), 60000);
      f.onload = () => setTimeout(() => done(true), 1500);
      f.src = LICENSES_URL + '?slr_refresh=' + Date.now();
      document.body.appendChild(f);
    });
  }
  let recoveryCount = 0;
  async function recoverSession(reason) {
    for (let i = 0; i < CONFIG.sessionRetryWaitMs.length && !state.stopRequested; i++) {
      const wait = CONFIG.sessionRetryWaitMs[i];
      log(`🔑 ${reason}. Session refresh attempt ${i + 1}/${CONFIG.sessionRetryWaitMs.length} after ${fmt(wait)}...`);
      await sleep(wait, 'Session recovery wait');
      if (state.stopRequested) return false;
      const r = await loadFrame();
      recoveryCount++;
      record('session_recovery', { reason: reason.slice(0, 200), attempt: i + 1, frameLoaded: r.ok, gotSession: !!r.sid,
                                   sessionChanged: !!r.sid && r.sid !== sessionID, framePath: r.path });
      if (r.sid && r.path.includes(LICENSES_PATH)) {
        if (r.sid !== sessionID) log('Session ID renewed.');
        sessionID = r.sid;
        log('✔ Session looks valid again - resuming.');
        return true;
      }
    }
    return false;
  }

  // ----------------------------------------------------------------- REMOVE
  async function removeOnce(lic) {
    const prev = lastLimiterEvent();
    const base = { id: lic.id, name: lic.name, paceMs: state.pace, mode: state.mode,
                   prevResult: prev ? prev.result : null, sincePrevReqMs: prev ? Date.now() - prev.t : null,
                   ok10m: okCountSince(600e3), ok60m: okCountSince(3600e3), okStreak: currentStreak() };
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(REMOVE_URL, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: `sessionid=${encodeURIComponent(sessionID)}&packageid=${encodeURIComponent(lic.id)}`,
      });
    } catch (e) {
      return record('remove', { ...base, result: 'net', detail: `network error: ${e.message}`, ms: Math.round(performance.now() - t0) });
    }
    const ms = Math.round(performance.now() - t0);
    const ra = res.headers.get('Retry-After');
    const retryAfterMs = ra ? (isNaN(ra) ? Math.max(0, Date.parse(ra) - Date.now()) : Number(ra) * 1000) : null;
    const text = await res.text().catch(() => '');
    const common = { ...base, http: res.status, ms, retryAfterMs, redirected: res.redirected || undefined };

    if (res.status === 429) return record('remove', { ...common, result: 'ratelimit', detail: 'HTTP 429' });
    if (res.status === 401 || res.status === 403)
      return record('remove', { ...common, result: 'session', detail: `HTTP ${res.status}`, title: htmlTitle(text) });
    if (!res.ok) return record('remove', { ...common, result: 'fail', detail: `HTTP ${res.status} ${res.statusText}`, raw: text.slice(0, 200) });

    let data;
    try { data = JSON.parse(text); } catch {
      const title = htmlTitle(text);
      const loginPage = /sign in|login/i.test(title) || /login\.steampowered\.com|newlogin/i.test(text.slice(0, 20000));
      return record('remove', { ...common, result: 'session', detail: `Non-JSON reply${title ? ` ("${title}")` : ''}`,
                                title, looksLikeLogin: loginPage, finalUrl: res.url, bytes: text.length });
    }
    const code = Number(data.success);
    const ev = { ...common, eresult: code, eresultName: EResultName[code] || 'Unknown', raw: code === 1 ? undefined : text.slice(0, 200) };
    if (code === 1)  return record('remove', { ...ev, result: 'ok' });
    if (code === 84) return record('remove', { ...ev, result: 'ratelimit', detail: 'Steam error 84' });
    if (CONFIG.nonRetryableCodes.includes(code))
      return record('remove', { ...ev, result: 'skip', detail: `Steam error ${code} (${ev.eresultName}) - not removable` });
    return record('remove', { ...ev, result: 'fail', detail: `Steam error ${data.success} (${ev.eresultName})` });
  }

  // ----------------------------------------------------------------- VERIFY
  async function verify(pageLimit) {
    state.stopRequested = false;
    const ids = removedThisRun.size ? removedThisRun : removedIds;
    log(`Verifying ${ids.size} removals against a fresh copy of the first ${pageLimit} page(s)...`);
    const stream = makePageStream(false); const remaining = new Set(); let list;
    while (stream.pages < pageLimit && (list = await stream.next())) list.forEach(l => remaining.add(l.id));
    const notGone = [...ids].filter(id => remaining.has(id));
    record('verify', { checked: ids.size, pages: stream.pages, notGone: notGone.length, notGoneIds: notGone.slice(0, 50).join('|') || undefined });
    if (notGone.length) {
      console.warn(`[SLR] ${notGone.length} IDs were reported removed but are still listed:`, notGone);
      notGone.forEach(id => removedIds.delete(id)); saveRemoved();
    } else log(`✔ Verified: none of the ${ids.size} removals are still listed.`);
  }

  // ----------------------------------------------------------------- PUBLIC API
  window.SLR = {
    version: VERSION,
    get running() { return state.running; },
    stop()  { state.stopRequested = true; state.userStopped = true; console.warn('[SLR] Stop requested - finishing current step...'); },
    reset() { localStorage.removeItem(STORAGE_KEY); removedIds.clear(); console.log('[SLR] Saved progress cleared.'); },
    clearLog() { tlog = []; localStorage.removeItem(LOG_KEY); console.log('[SLR] Telemetry cleared.'); },
    status() {
      const wait = state.waitingUntil ? ` | next step ${new Date(state.waitingUntil).toLocaleTimeString()}` : '';
      console.log(`[SLR] ${state.running ? 'Running' : 'Idle'} | mode ${state.mode} | pace ${fmt(state.pace)} | removed ${state.removed} | ` +
                  `skipped ${state.skipped} | 84s ${state.rateLimitHits} | pages ${state.pagesLoaded} | licenses seen ${state.seen} | ` +
                  `OK last 60m ${okCountSince(3600e3)}${wait}`);
    },
    report: printReport, exportCSV, exportJSON,
    verify: (pages = 5) => (state.running ? console.warn('[SLR] Wait until the run finishes or stop it first.') : verify(pages)),
  };

  // ----------------------------------------------------------------- MAIN
  record('run_start', { config: JSON.stringify({ ...CONFIG, skipNameRegex: String(CONFIG.skipNameRegex) }), url: location.href });
  const finish = (reason) => {
    state.running = false; state.current = null;
    document.removeEventListener('visibilitychange', onVisibility);
    record('run_end', { reason, removed: state.removed, skipped: state.skipped, rateLimitHits: state.rateLimitHits,
                        pages: state.pagesLoaded, finalPaceMs: state.pace, sessionRecoveries: recoveryCount });
  };

  // Dry run: scan every page and count
  if (CONFIG.dryRun) {
    const s = makePageStream(true); let list, total = 0, weekend = 0;
    while ((list = await s.next())) { total += list.length; weekend += list.filter(l => CONFIG.skipNameRegex?.test(l.name)).length;
                                      log(`Page ${s.pages}: ${list.length} removable (running total ${total})`); }
    log(`Dry run: ${total} removable licenses on ${s.pages} pages (${weekend} Free Weekend). At ~6/hour that is ~${Math.ceil(total / 6 / 24)} days.`);
    finish('dry_run'); return;
  }

  // Pacing mode
  const lastOk = lastOkTime();
  const idle = lastOk ? Date.now() - lastOk : Infinity;
  if (idle >= CONFIG.burstAfterIdleMs) { state.mode = 'burst'; state.pace = CONFIG.burstPaceMs; }
  log(`v${VERSION} - last successful removal: ${lastOk ? fmt(idle) + ' ago' : 'none logged'}. ` +
      `Starting in ${state.mode.toUpperCase()} mode (one removal every ${fmt(state.pace)}).`);

  const firstPageCount = extractLicenses(document, false).list.length;
  if (!confirm(`Remove free licenses from your account?\n\n${firstPageCount} removable on this page; later pages are loaded as the run reaches them.\n` +
               `Expected speed: ~15 quickly if the account has rested, then about 6 per hour.\n` +
               `Keep this tab in its own window. Stop any time with SLR.stop().`)) {
    log('Cancelled.'); finish('cancelled'); return;
  }

  const stream = makePageStream(true);
  const clamp = (ms) => Math.min(CONFIG.paceMaxMs, Math.max(state.mode === 'burst' ? CONFIG.burstPaceMs : CONFIG.steadyMinMs, ms));
  let okRun = 0, buffer = [], fatalReason = null;

  const enterSteady = (why) => {
    if (state.mode === 'steady') return;
    state.mode = 'steady'; state.pace = CONFIG.steadyPaceMs;
    record('pace', { to: state.pace, reason: why, mode: 'steady' });
    log(`→ STEADY mode: one removal every ${fmt(state.pace)} (${why}).`);
  };

  main:
  while (!state.stopRequested) {
    if (!buffer.length) {
      const list = await stream.next();
      if (!list) break;
      state.pagesLoaded = stream.pages;
      state.seen += list.length;
      const weekend = CONFIG.skipNameRegex ? list.filter(l => CONFIG.skipNameRegex.test(l.name)) : [];
      buffer = list.filter(l => !removedIds.has(l.id) && !weekend.includes(l));
      if (weekend.length) record('preskip', { count: weekend.length, ids: weekend.map(l => l.id).join('|') });
      log(`📄 Page ${stream.pages}: ${list.length} removable, ${weekend.length} Free Weekend skipped, ${buffer.length} queued.`);
      continue;
    }
    const lic = buffer.shift();
    state.current = lic.id;
    let otherFailures = 0, rlRetries = 0, usedLimiter = false;

    while (!state.stopRequested) {
      log(`Removing ${lic.id} - ${lic.name}`);
      const r = await removeOnce(lic);
      dbg('Response:', r);

      if (r.result === 'ok') {
        state.removed++; okRun++; usedLimiter = true;
        removedIds.add(lic.id); removedThisRun.add(lic.id); saveRemoved();
        lic.row?.remove();
        if (state.mode === 'steady' && okRun >= CONFIG.paceDownAfterOk && state.pace > CONFIG.steadyMinMs) {
          const old = state.pace; state.pace = clamp(state.pace - CONFIG.paceDownMs); okRun = 0;
          record('pace', { from: old, to: state.pace, reason: 'ok_streak' });
          log(`↘ ${CONFIG.paceDownAfterOk} successes in a row - pace ${fmt(old)} -> ${fmt(state.pace)}`);
        }
        log(`✅ Removed ${lic.id}. Run total ${state.removed} | OK last 60m: ${okCountSince(3600e3)} | next in ~${fmt(state.pace)}`);
        break;
      }
      if (r.result === 'ratelimit') {
        state.rateLimitHits++; rlRetries++; okRun = 0; usedLimiter = true;
        if (state.mode === 'burst') enterSteady(`burst ended after ${currentStreakBeforeLast84()} removals`);
        else if (r.prevResult === 'ok') {
          const old = state.pace; state.pace = clamp(state.pace + CONFIG.paceUpMs);
          if (state.pace !== old) { record('pace', { from: old, to: state.pace, reason: 'rate_limited' }); log(`↗ Pace ${fmt(old)} -> ${fmt(state.pace)}`); }
        }
        const wait = Math.max(Math.min(state.pace * 2 ** (rlRetries - 1), CONFIG.rateLimitMaxWaitMs), r.retryAfterMs || 0);
        log(`⏳ Rate limited (${r.detail}) ${fmt(r.sincePrevReqMs)} after the previous request. Nothing removed. ` +
            `Waiting ${fmt(wait)}, then retrying ${lic.id}.`);
        await sleep(wait, 'Rate-limit cooldown', { id: lic.id, attempt: rlRetries, paceMs: state.pace });
        continue;
      }
      if (r.result === 'net') {
        // Removal request never reached Steam - back off and retry the same license, never skip.
        const res = await fetchWithNetRetry(LICENSES_URL, { credentials: 'include', method: 'HEAD' }, 'connectivity check');
        if (!res) { fatalReason = 'network down'; state.stopRequested = true; break main; }
        log('🌐 Connection is back - retrying the same license.');
        continue;
      }
      if (r.result === 'session') {
        if (await recoverSession(r.detail)) continue;
        fatalReason = `session could not be renewed (${r.detail})`;
        console.error(`[SLR] ❌ ${fatalReason}. Refresh the page (F5), check you're logged in, and paste the script again - progress is saved.`);
        state.stopRequested = true; break main;
      }
      if (r.result === 'skip') { state.skipped++; log(`⏭ Skipping ${lic.id} - ${lic.name}: ${r.detail}.`); break; }
      otherFailures++;
      if (otherFailures > CONFIG.maxOtherFailures) { state.skipped++; log(`⚠️ Skipping ${lic.id} after ${otherFailures} failures (${r.detail}).`); break; }
      log(`⚠️ ${lic.id} failed (${r.detail}). Retry ${otherFailures}/${CONFIG.maxOtherFailures} shortly...`);
      await sleep(jitter(CONFIG.delayMs));
    }

    if (!state.stopRequested) {
      if (usedLimiter) await sleep(jitter(state.pace), 'Pacing', { paceMs: state.pace, mode: state.mode });
      else await sleep(jitter(CONFIG.delayMs));
    }
  }

  function currentStreakBeforeLast84() {
    let n = 0, seen84 = false;
    for (let i = tlog.length - 1; i >= 0; i--) {
      const e = tlog[i]; if (e.type !== 'remove' || e.run !== runId) continue;
      if (e.result === 'ratelimit') { if (seen84) break; seen84 = true; } else if (e.result === 'ok') n++;
    }
    return n;
  }

  const stoppedEarly = state.stopRequested;
  finish(state.userStopped ? 'user_stopped' : fatalReason ? 'fatal: ' + fatalReason : 'complete');
  log(`Done. Removed ${state.removed} | skipped ${state.skipped} | 84s ${state.rateLimitHits} | pages ${state.pagesLoaded} | ` +
      `final pace ${fmt(state.pace)}${stoppedEarly ? ' | (stopped early)' : ''}`);
  if (CONFIG.verifyAtEnd && state.removed > 0) {
    if (stoppedEarly) log('Skipping verify because the run stopped. Run SLR.verify() when ready.');
    else await verify(Math.max(1, state.pagesLoaded));
  }
  printReport('run');
  log('Tip: SLR.report() analyses all runs; SLR.exportCSV() downloads the full log to share.');
})();
