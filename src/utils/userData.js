// utils/userData.js
// ----------------------------------------------------------------------------
// Server-side persistence for per-user, per-site app state.
//
// Replaces direct localStorage reads/writes. localStorage is kept as a
// write-through cache for instant UI response, but Supabase (via the worker)
// is the source of truth.
//
// Public functions:
//   - loadUserData(site, type)        → async, reads from server, falls back to localStorage on failure
//   - saveUserData(site, type, value) → debounced write (500ms per key)
//   - appendUserData(site, type, items) → adds to a list type, merged with the server copy
//   - mergeUserData(site, type, patch)  → saves changed fields, merged with the server copy
//
// One React hook:
//   - useRemoteState(site, type, fallback)
//     Like useState, but persists to server. Returns [value, setValue, status].
//     status is 'loading' | 'ready' | 'error'.
//
// Cross-cutting concerns:
//   - Debounce: 500ms per (site, type) key — typing into a field doesn't
//     hammer the worker; only the last write in a burst is sent.
//   - Offline tolerance: if a write fails (network blip, worker error), the
//     value stays in localStorage and is retried on the next save attempt.
//     Reads fall back to localStorage if the server is unreachable.
//   - localStorage key naming preserves the existing `ra_${type}_${site}`
//     scheme so a frontend rollback (revert to localStorage-only) still works.
// ----------------------------------------------------------------------------

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'https://api.rankactions.com';

// The app holds "mywebsite.com" as the selected site before a real one exists —
// a brand new account, or any account whose Search Console connection hasn't
// resolved yet. It is a placeholder, not a site: nothing is ever stored against
// it and the worker rejects it as not-owned.
//
// Guarding here rather than at each call site because every one of the nine
// userdata types flows through loadUserData/saveUserData, so one check covers
// them all and a type added later inherits it. Before this, a first visit fired
// nine pointless requests for a site that does not exist.
const PLACEHOLDER_SITE = 'mywebsite.com';
export function isPlaceholderSite(site) {
  return !site || String(site).trim().toLowerCase() === PLACEHOLDER_SITE;
}

// Token getter. App.jsx wires this in a useEffect, but that effect runs AFTER
// our first hook mount, which races with the initial load. So we default to
// reading from window.Clerk directly — App.jsx's wiring then overrides this
// with the precise useClerk() session reference if available.
let _getToken = async () => {
  try {
    if (typeof window !== 'undefined' && window.Clerk?.session?.getToken) {
      return await window.Clerk.session.getToken();
    }
  } catch {}
  return null;
};
export function setUserDataTokenGetter(fn) { _getToken = fn; }

// Allowed types — must match the worker's USERDATA_ALLOWED_TYPES set.
// Catches typos at the call site.
const ALLOWED_TYPES = new Set([
  'strategy',
  'strategy_history',
  'done',
  'prospects',
  'content_history',
  'link_history',
  'starting_out',
  'kw_enrich',
  'hidden_kw',
  'assist_done',
  'assist_visited',
  // Business name, base town and service scopes. The worker has accepted this
  // type since 24 Sep 2026, but it was missing here, so every load and save of
  // it stopped at the check above and nothing was ever stored, not even in
  // this browser.
  'site_profile',
]);

// Types whose saves are merged with the server copy rather than replacing it.
// A device that has not yet read the server (a new browser, a failed read) or
// that read it an hour ago (a second device left open) would otherwise
// overwrite entries it has never seen.
//
// Append types are lists that only grow. The number is the cap, the same one
// the app applied before these were merged.
const APPEND_CAPS = { content_history: 50, link_history: 40, strategy_history: 20 };
// Patch types are objects saved one changed field at a time. Fields listed in
// MAP_FIELDS are maps merged key by key (a null value removes a key); every
// other field is replaced whole.
const PATCH_TYPES = new Set(['site_profile']);
const MAP_FIELDS = { site_profile: new Set(['serviceScopes']) };

// ── localStorage key (matches existing convention used pre-migration) ──
const localKey = (site, type) => {
  // Existing convention is `ra_${type}_${site}`. Two slightly different
  // type names exist in the wild — handle them so the cache still hits:
  //   - 'strategy_history' was 'ra_strategy_history_<site>'
  //   - 'kw_enrich' was 'ra_kw_enrich_<site>'
  return `ra_${type}_${site}`;
};

// ── Cache for in-flight loads so concurrent callers share one request ──
const inflightLoads = new Map(); // key: `${site}|${type}` → Promise

// ── Per-key debounce timers ──
const writeTimers = new Map(); // key: `${site}|${type}` → timeoutId
const writeQueue  = new Map(); // key: `${site}|${type}` → latest value
const DEBOUNCE_MS = 500;

/**
 * Load a single user-data record for the current user.
 * Returns the parsed payload, or `null` if no record exists.
 *
 * Resolution order:
 *   1. Try the server. If 2xx, write-through to localStorage and return.
 *   2. If the server errors (network, 5xx, etc), fall back to localStorage.
 *   3. If localStorage is empty too, return null.
 */
// The loader behind loadUserData. Also reports where the value came from:
//   'server' — read from the worker (the only source a merge may build on)
//   'local'  — this browser's cache, because the server could not be reached
//   'denied' — 401/403; nothing is returned
//   'none'   — invalid type or placeholder site
//
// fresh: true skips sharing an in-flight read. A merge must build on a read
// made after every earlier write, never on one that started before them.
function loadWithSource(site, type, { fresh = false } = {}) {
  if (!ALLOWED_TYPES.has(type)) {
    console.warn(`[userData] Invalid type: ${type}`);
    return Promise.resolve({ payload: null, source: 'none' });
  }
  // Returning null, not throwing: callers already treat null as "nothing saved
  // yet", which is exactly true of the placeholder.
  if (isPlaceholderSite(site)) return Promise.resolve({ payload: null, source: 'none' });

  const key = `${site}|${type}`;

  // Dedup concurrent loads for the same key — common in React strict mode
  // and when multiple components ask for the same data on mount.
  if (!fresh && inflightLoads.has(key)) return inflightLoads.get(key);

  const promise = (async () => {
    try {
      // Wait for a real token. On first app mount, the React hook for
      // top-level state slots (`done`, `prospects`) can race ahead of Clerk's
      // session initialisation — `_getToken()` returns null and we'd silently
      // fall back to localStorage forever. Short retry loop (up to ~2.5s)
      // gives Clerk time to come up.
      let token = await _getToken();
      let attempts = 0;
      while (!token && attempts < 10) {
        await new Promise(r => setTimeout(r, 250));
        token = await _getToken();
        attempts++;
      }
      if (!token) return { payload: readLocal(site, type), source: 'local' };

      const res = await fetchWithTimeout(
        `${WORKER_URL}/api/userdata/${type}?site=${encodeURIComponent(site)}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      if (!res.ok) {
        // 403 = site not in profile (legit). 401 = auth issue. Other = transient.
        // For 403 we don't want to return localStorage data — the user shouldn't
        // see another user's data even if it's somehow cached locally.
        if (res.status === 403 || res.status === 401) return { payload: null, source: 'denied' };
        return { payload: readLocal(site, type), source: 'local' };
      }

      const { payload } = await res.json();
      // Write-through to localStorage so a subsequent reload without network
      // still has the data.
      if (payload != null) writeLocal(site, type, payload);
      return { payload, source: 'server' };
    } catch (err) {
      // Network failure — fall back to local cache rather than losing the UI.
      console.warn(`[userData] load ${type} fell back to localStorage:`, err.message);
      return { payload: readLocal(site, type), source: 'local' };
    } finally {
      // Clear the inflight entry on next tick so subsequent calls re-fetch.
      if (!fresh) setTimeout(() => { if (inflightLoads.get(key) === promise) inflightLoads.delete(key); }, 0);
    }
  })();

  if (!fresh) inflightLoads.set(key, promise);
  return promise;
}

export async function loadUserData(site, type) {
  const { payload, source } = await loadWithSource(site, type);
  if (source !== 'server' && source !== 'local') return payload;
  // Changes made on this device that the server has not confirmed yet are
  // laid over what was read, so a refresh never hides them. When the read came
  // from the server, they are sent now.
  if (APPEND_CAPS[type]) {
    const pending = readPending(site, type);
    if (!pending.length) return payload;
    const merged = capList(mergeLists(Array.isArray(payload) ? payload : [], pending), APPEND_CAPS[type]);
    writeLocal(site, type, merged);
    if (source === 'server') setTimeout(() => { appendUserData(site, type, []); }, 0);
    return merged;
  }
  if (PATCH_TYPES.has(type)) {
    const patch = readPendingPatch(site, type);
    if (!patch) return payload;
    const merged = applyPatch(type, isPlainObject(payload) ? payload : {}, patch);
    writeLocal(site, type, merged);
    if (source === 'server') setTimeout(() => { mergeUserData(site, type, {}); }, 0);
    return merged;
  }
  return payload;
}

/**
 * Add entries to an append type (content_history, link_history,
 * strategy_history) without ever replacing entries saved from elsewhere.
 *
 * The entries reach this browser's copy and a pending list straight away,
 * before anything else happens. The server copy is then read and the union is
 * written back. If the read does not come from the server, nothing is sent:
 * the entries stay pending and go up with the next successful read or append.
 */
export function appendUserData(site, type, items) {
  const cap = APPEND_CAPS[type];
  if (!cap) {
    console.warn(`[userData] Not an append type: ${type}`);
    return Promise.resolve({ ok: false, error: 'invalid_type' });
  }
  const list = Array.isArray(items) ? items : [];
  if (isPlaceholderSite(site)) {
    // Same as before merging existed: the placeholder keeps a local list only.
    if (site && list.length) writeLocal(site, type, capList([...readLocalArray(site, type), ...list], cap));
    return Promise.resolve({ ok: false, error: 'placeholder_site' });
  }
  if (list.length) {
    writePending(site, type, capList([...readPending(site, type), ...list], cap));
    writeLocal(site, type, capList(mergeLists(readLocalArray(site, type), list), cap));
  }
  return runExclusive(`${site}|${type}`, async () => {
    const pending = readPending(site, type);
    if (!pending.length) return { ok: true, nothing: true };
    const { payload, source } = await loadWithSource(site, type, { fresh: true });
    if (source === 'denied') { writePending(site, type, []); return { ok: false, error: 'denied' }; }
    if (source !== 'server') return { ok: false, error: 'offline' };
    const merged = capList(mergeLists(Array.isArray(payload) ? payload : [], pending), cap);
    cancelDebounced(site, type);
    const result = await sendWrite(site, type, merged);
    writeLocal(site, type, merged);
    // Appends made while this write was in flight were added after the ones
    // just sent, so only that leading run is removed.
    if (result.ok) writePending(site, type, readPending(site, type).slice(pending.length));
    return result;
  });
}

/**
 * Save changed fields of a patch type (site_profile) without replacing fields
 * saved from elsewhere. A null value removes a field, or a key of a map field.
 * Same order as appendUserData: this browser first, then read, merge and write.
 */
export function mergeUserData(site, type, patch) {
  if (!PATCH_TYPES.has(type)) {
    console.warn(`[userData] Not a patch type: ${type}`);
    return Promise.resolve({ ok: false, error: 'invalid_type' });
  }
  if (isPlaceholderSite(site)) return Promise.resolve({ ok: false, error: 'placeholder_site' });
  const p = isPlainObject(patch) ? patch : {};
  if (Object.keys(p).length) {
    writePendingPatch(site, type, combinePatches(type, readPendingPatch(site, type) || {}, p));
    const local = readLocal(site, type);
    writeLocal(site, type, applyPatch(type, isPlainObject(local) ? local : {}, p));
  }
  return runExclusive(`${site}|${type}`, async () => {
    const pending = readPendingPatch(site, type);
    if (!pending) return { ok: true, nothing: true };
    const { payload, source } = await loadWithSource(site, type, { fresh: true });
    if (source === 'denied') { writePendingPatch(site, type, null); return { ok: false, error: 'denied' }; }
    if (source !== 'server') return { ok: false, error: 'offline' };
    const merged = applyPatch(type, isPlainObject(payload) ? payload : {}, pending);
    cancelDebounced(site, type);
    const result = await sendWrite(site, type, merged);
    writeLocal(site, type, merged);
    if (result.ok) {
      const now = readPendingPatch(site, type);
      if (JSON.stringify(now) === JSON.stringify(pending)) writePendingPatch(site, type, null);
      // Changed while in flight: the pending patch still holds everything, and
      // applying a field twice gives the same result, so just run again.
      else setTimeout(() => { mergeUserData(site, type, {}); }, 0);
    }
    return { ...result, value: merged };
  });
}

/**
 * Save a user-data record. Debounced 500ms per (site, type) key so that
 * rapid changes (e.g. typing into a strategy field) result in one server
 * write at the end of the burst, not one per keystroke.
 *
 * localStorage is updated immediately (no debounce) so the data is durable
 * across page reloads even before the debounced server write fires.
 *
 * Returns a Promise that resolves when the debounced write completes.
 * Most callers won't await this — fire-and-forget is fine.
 */
export function saveUserData(site, type, value) {
  if (!ALLOWED_TYPES.has(type)) {
    console.warn(`[userData] Invalid type: ${type}`);
    return Promise.resolve({ ok: false, error: 'invalid_type' });
  }
  // No local write either. Caching under the placeholder key would leave data
  // stranded there once a real site is connected.
  if (isPlaceholderSite(site)) return Promise.resolve({ ok: false, error: 'placeholder_site' });

  // Immediate local write — guarantees no data loss if the page reloads
  // before the debounced server write fires.
  writeLocal(site, type, value);

  const key = `${site}|${type}`;
  writeQueue.set(key, value);

  // Clear any pending timer for this key and schedule a fresh one.
  if (writeTimers.has(key)) clearTimeout(writeTimers.get(key));

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      writeTimers.delete(key);
      const valueToSend = writeQueue.get(key);
      writeQueue.delete(key);
      const result = await sendWrite(site, type, valueToSend);
      resolve(result);
    }, DEBOUNCE_MS);
    writeTimers.set(key, timer);
  });
}

/**
 * Force-flush any pending debounced writes for a key. Useful before
 * navigation away from a page that has unsaved changes.
 */
export async function flushUserData(site, type) {
  if (isPlaceholderSite(site)) return { ok: true, nothing: true };
  const key = `${site}|${type}`;
  if (!writeTimers.has(key)) return { ok: true, nothing: true };
  clearTimeout(writeTimers.get(key));
  writeTimers.delete(key);
  const valueToSend = writeQueue.get(key);
  writeQueue.delete(key);
  return sendWrite(site, type, valueToSend);
}

// ── Internal helpers ──

async function sendWrite(site, type, value) {
  try {
    const token = await _getToken();
    if (!token) return { ok: false, error: 'no_token' };

    const res = await fetchWithTimeout(
      `${WORKER_URL}/api/userdata/${type}?site=${encodeURIComponent(site)}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(value),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[userData] save ${type} failed (${res.status}): ${text}`);
      return { ok: false, error: `http_${res.status}` };
    }

    const data = await res.json();
    return { ok: true, updatedAt: data.updatedAt };
  } catch (err) {
    console.warn(`[userData] save ${type} threw:`, err.message);
    return { ok: false, error: 'network' };
  }
}

// A request that never answers would otherwise hold up every later append or
// merge for that type, which run one at a time.
const REQUEST_TIMEOUT_MS = 15000;
async function fetchWithTimeout(url, opts = {}) {
  if (typeof AbortController === 'undefined') return fetch(url, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function cancelDebounced(site, type) {
  const key = `${site}|${type}`;
  if (writeTimers.has(key)) { clearTimeout(writeTimers.get(key)); writeTimers.delete(key); }
  writeQueue.delete(key);
}

// One append or merge at a time per (site, type), in call order.
const exclusive = new Map();
function runExclusive(key, fn) {
  const prev = exclusive.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).catch((err) => {
    console.warn(`[userData] ${key} failed:`, err && err.message);
    return { ok: false, error: 'exception' };
  });
  exclusive.set(key, next);
  next.then(() => { if (exclusive.get(key) === next) exclusive.delete(key); });
  return next;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Entries are the same entry when their JSON is identical.
function mergeLists(base, extra) {
  const seen = new Set(base.map(e => JSON.stringify(e)));
  const out = base.slice();
  for (const e of extra) {
    const k = JSON.stringify(e);
    if (!seen.has(k)) { seen.add(k); out.push(e); }
  }
  return out;
}
function capList(list, cap) {
  return list.length > cap ? list.slice(-cap) : list;
}

function applyPatch(type, base, patch) {
  const maps = MAP_FIELDS[type] || new Set();
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue; }
    if (maps.has(k) && isPlainObject(v)) {
      const m = isPlainObject(out[k]) ? { ...out[k] } : {};
      for (const [mk, mv] of Object.entries(v)) {
        if (mv === null) delete m[mk]; else m[mk] = mv;
      }
      out[k] = m;
      continue;
    }
    out[k] = v;
  }
  return out;
}
// Like applyPatch, but keeps the nulls, because they are instructions.
function combinePatches(type, a, b) {
  const maps = MAP_FIELDS[type] || new Set();
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (maps.has(k) && isPlainObject(v) && isPlainObject(out[k])) ? { ...out[k], ...v } : v;
  }
  return out;
}

// ── Pending changes (not yet confirmed by the server) ──
// Kept in localStorage so they survive a reload. If localStorage stops
// working (a full quota, or older Safari private browsing), they are held in
// memory for the rest of the session instead of being dropped.
const memStore = new Map();
let storageBroken = false;
function storeGet(k) {
  if (storageBroken) return memStore.has(k) ? memStore.get(k) : null;
  try { return localStorage.getItem(k); }
  catch { storageBroken = true; return memStore.has(k) ? memStore.get(k) : null; }
}
function storeSet(k, v) {
  memStore.set(k, v);
  if (storageBroken) return;
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
  catch { storageBroken = true; }
}
const pendingKey = (site, type) => `ra_pending_${type}_${site}`;
function readPending(site, type) {
  try { const v = JSON.parse(storeGet(pendingKey(site, type)) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function writePending(site, type, list) {
  storeSet(pendingKey(site, type), list && list.length ? JSON.stringify(list) : null);
}
function readPendingPatch(site, type) {
  try { const v = JSON.parse(storeGet(pendingKey(site, type)) || 'null'); return isPlainObject(v) ? v : null; }
  catch { return null; }
}
function writePendingPatch(site, type, patch) {
  storeSet(pendingKey(site, type), patch && Object.keys(patch).length ? JSON.stringify(patch) : null);
}

function readLocalArray(site, type) {
  const v = readLocal(site, type);
  return Array.isArray(v) ? v : [];
}

function readLocal(site, type) {
  try {
    const raw = localStorage.getItem(localKey(site, type));
    if (raw == null || raw === 'null' || raw === '') return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLocal(site, type, value) {
  try {
    if (value == null) {
      localStorage.removeItem(localKey(site, type));
    } else {
      localStorage.setItem(localKey(site, type), JSON.stringify(value));
    }
  } catch {
    // Quota exceeded etc — non-fatal, server is source of truth.
  }
}

// ── React hook ──
// Drop-in-like replacement for `useState` that reads from server on mount
// and persists changes (debounced) to server. Returns [value, setValue, status].
//
// `status` lets the UI show a loading state on first render before the server
// read returns. Pass `fallback` to use as the initial value while loading.
//
// Re-loads when `site` or `type` changes — same site-switch semantics as
// before, but server-backed.
//
// Usage:
//   const [strategy, setStrategy, status] = useRemoteState(selectedSite, 'strategy', null);
//   if (status === 'loading') return <Skeleton/>;
import { useEffect, useMemo, useRef, useState } from 'react';

export function useRemoteState(site, type, fallback = null) {
  const [value, setValue] = useState(fallback);
  const [status, setStatus] = useState('loading');
  // Tracks the most recent (site, type) we asked to load. When a load promise
  // resolves, we drop its result if a newer load has been issued in the
  // meantime. This handles site-switch races without needing a mount tracker.
  const lastLoadKeyRef = useRef(null);

  useEffect(() => {
    if (!site) {
      setStatus('ready');
      return;
    }

    const loadKey = `${site}|${type}`;
    lastLoadKeyRef.current = loadKey;

    setStatus('loading');
    loadUserData(site, type)
      .then((data) => {
        // Drop stale results from older site/type combinations.
        if (lastLoadKeyRef.current !== loadKey) return;
        setValue(data == null ? fallback : data);
        setStatus('ready');
      })
      .catch((err) => {
        if (lastLoadKeyRef.current !== loadKey) return;
        console.warn(`[useRemoteState] ${type} load error:`, err);
        setStatus('error');
      });
    // fallback intentionally NOT in deps — it's an initial value, not a reset trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, type]);

  const update = (next) => {
    // Allow function form, matching useState API
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      // Fire-and-forget server write (with internal debounce + local cache).
      if (site) saveUserData(site, type, resolved);
      return resolved;
    });
  };

  return [value, update, status];
}

/**
 * useRemoteState wrapper for Set-typed values.
 *
 * Sets aren't JSON-serializable directly, so the wire format stays as an array
 * and we convert at the boundary. Returns [Set, setSet(setterAcceptsSetOrArray), status].
 *
 * Used by completed-actions (`done`) state — the existing code treats it as
 * a Set everywhere, so this keeps the call sites identical.
 */
export function useRemoteStateSet(site, type) {
  const [arr, setArr, status] = useRemoteState(site, type, []);

  // Memoise the Set so React-equality checks don't see a new Set every render.
  // The Set is rebuilt only when the underlying array reference changes.
  const setValue = useMemo(
    () => new Set(Array.isArray(arr) ? arr : []),
    [arr]
  );

  const update = (next) => {
    setArr((prevArr) => {
      const prevSet = new Set(Array.isArray(prevArr) ? prevArr : []);
      const resolved = typeof next === 'function' ? next(prevSet) : next;
      // Accept either a Set or an array from the caller, store as array.
      return resolved instanceof Set ? [...resolved] : Array.isArray(resolved) ? resolved : [];
    });
  };

  return [setValue, update, status];
}
