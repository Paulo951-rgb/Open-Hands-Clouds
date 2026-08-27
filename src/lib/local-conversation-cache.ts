/**
 * Local (per-device) mirror of recent conversation events, stored in
 * IndexedDB so a returning visit can render instantly instead of waiting on
 * the network.
 *
 * IMPORTANT — this is a *resilience/UX* layer only, never a source of truth:
 *  - The Agent Server (local, VM, Docker, or OpenHands Cloud) remains the
 *    only authoritative store. Everything written here is re-validated and
 *    merged against the server's REST history + WebSocket replay
 *    (`useEventStore.addEvents`, which already de-dupes by event id).
 *  - Every export in this module is best-effort and MUST NOT throw: a quota
 *    error, a browser without IndexedDB, private-browsing restrictions, etc.
 *    should silently degrade to "no local cache" rather than break the app.
 *  - Nothing sensitive (API keys, session tokens) is ever written here —
 *    only the same conversation events already rendered on screen.
 */
import type { OHEvent } from "#/stores/use-event-store";

const DB_NAME = "oh-local-conversation-cache";
const DB_VERSION = 1;
const STORE_NAME = "conversation-events";

/** Local mirror entries older than this are treated as expired and pruned. */
export const CACHE_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

/** Upper bound on how many events we mirror per conversation. */
const MAX_EVENTS_PER_CONVERSATION = 400;

/** Soft byte budget per conversation entry (approx, via JSON length). */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024; // 2MB

/** Debounce window for writes, per the requested 200–500ms range. */
const WRITE_DEBOUNCE_MS = 350;

interface CacheEntry {
  conversationId: string;
  events: OHEvent[];
  updatedAt: number;
}

function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!isIndexedDbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "conversationId" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      // Any open failure (blocked, disabled storage, private mode in some
      // browsers) degrades to "no cache" rather than surfacing an error.
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * Trim an event list so its serialized size stays under the soft byte
 * budget, dropping the oldest events first. Cheap approximation via
 * JSON.stringify — this runs at most once per debounced write, on data
 * already held in memory by the event store.
 */
function trimToBudget(events: OHEvent[]): OHEvent[] {
  let working = events.slice(-MAX_EVENTS_PER_CONVERSATION);
  try {
    while (working.length > 1) {
      const size = JSON.stringify(working).length;
      if (size <= MAX_ENTRY_BYTES) break;
      // Drop the oldest quarter rather than one-by-one, so a single huge
      // conversation converges in a handful of iterations, not hundreds.
      const dropCount = Math.max(1, Math.floor(working.length / 4));
      working = working.slice(dropCount);
    }
  } catch {
    // Circular/unserializable data (shouldn't happen — events are plain
    // JSON already sent over the wire) — bail out to a small safe slice.
    return events.slice(-50);
  }
  return working;
}

/** Read the cached events for a conversation, newest write wins. */
export async function getCachedConversationEvents(
  conversationId: string,
): Promise<OHEvent[] | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(conversationId);
      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;
        if (!entry) {
          resolve(null);
          return;
        }
        if (Date.now() - entry.updatedAt > CACHE_MAX_AGE_MS) {
          resolve(null);
          return;
        }
        resolve(entry.events ?? null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Check (cheaply, without loading events) whether a fresh entry exists. */
export async function hasFreshCachedConversation(
  conversationId: string,
): Promise<boolean> {
  const events = await getCachedConversationEvents(conversationId);
  return !!events && events.length > 0;
}

async function writeNow(conversationId: string, events: OHEvent[]) {
  const db = await openDb();
  if (!db || events.length === 0) return;

  const entry: CacheEntry = {
    conversationId,
    events: trimToBudget(events),
    updatedAt: Date.now(),
  };

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });

  markConversationCachedSync(conversationId);
}

// --- Synchronous "do we have something cached?" marker -------------------
//
// IndexedDB reads are async, but the root app gate (src/root.tsx) needs a
// *synchronous* answer to decide whether it's safe to skip the blocking
// "connecting…" / "no backend" screens for a conversation we've already
// rendered before. localStorage is synchronous and perfect for this: we
// only ever store a small bounded list of conversation ids here, never the
// conversation content itself (that stays in IndexedDB, per the "small data
// only" rule for localStorage).
const CACHED_IDS_STORAGE_KEY = "oh:locally-cached-conversation-ids";
const MAX_TRACKED_IDS = 20;

function readCachedIdMarkers(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CACHED_IDS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function markConversationCachedSync(conversationId: string): void {
  try {
    const markers = readCachedIdMarkers();
    markers[conversationId] = Date.now();

    const entries = Object.entries(markers).sort(([, a], [, b]) => b - a);
    const trimmed = Object.fromEntries(entries.slice(0, MAX_TRACKED_IDS));

    localStorage.setItem(CACHED_IDS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full/unavailable (e.g. private mode) — the IndexedDB mirror
    // still works, we just lose the synchronous root-gate bypass for this
    // conversation. Never throw.
  }
}

/**
 * Synchronous, best-effort check used only to decide whether the root app
 * gate may optimistically render a previously-seen conversation while the
 * backend health probe is still in flight. Freshness (5-day TTL) is
 * enforced here too, mirroring {@link CACHE_MAX_AGE_MS}, so a marker never
 * outlives the IndexedDB entry it points at.
 */
export function hasSyncCacheMarker(conversationId: string | null): boolean {
  if (!conversationId) return false;
  try {
    const markers = readCachedIdMarkers();
    const updatedAt = markers[conversationId];
    return (
      typeof updatedAt === "number" &&
      Date.now() - updatedAt <= CACHE_MAX_AGE_MS
    );
  } catch {
    return false;
  }
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingWrites = new Map<string, OHEvent[]>();

/**
 * Schedule a debounced write for a conversation's events. Safe to call on
 * every store update (including once per streamed token) — the actual
 * IndexedDB write only happens after the debounce window is quiet, or when
 * `flushPendingCacheWrites` is called explicitly (backgrounding/close).
 */
export function scheduleCacheWrite(
  conversationId: string,
  events: OHEvent[],
): void {
  if (!conversationId || !isIndexedDbAvailable()) return;

  pendingWrites.set(conversationId, events);

  const existing = pendingTimers.get(conversationId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(conversationId);
    const toWrite = pendingWrites.get(conversationId);
    pendingWrites.delete(conversationId);
    if (toWrite) void writeNow(conversationId, toWrite);
  }, WRITE_DEBOUNCE_MS);

  pendingTimers.set(conversationId, timer);
}

/**
 * Immediately flush any debounced writes. Call this from `pagehide` /
 * `visibilitychange` handlers so a brutal tab close doesn't lose the last
 * few hundred milliseconds of streamed content that was still waiting on
 * the debounce timer.
 */
export function flushPendingCacheWrites(): void {
  for (const [conversationId, timer] of pendingTimers) {
    clearTimeout(timer);
    pendingTimers.delete(conversationId);
    const events = pendingWrites.get(conversationId);
    pendingWrites.delete(conversationId);
    if (events) {
      // Fire-and-forget: pagehide handlers can't reliably await a promise,
      // but IndexedDB writes queued synchronously here are typically given
      // a chance to complete by the browser even during teardown.
      void writeNow(conversationId, events);
    }
  }
}

/** Remove cache entries older than {@link CACHE_MAX_AGE_MS}. */
export async function pruneExpiredConversations(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const cursorRequest = store.openCursor();
      const cutoff = Date.now() - CACHE_MAX_AGE_MS;

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const entry = cursor.value as CacheEntry;
        if (entry.updatedAt < cutoff) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Delete a single conversation's cache (e.g. on explicit deletion). */
export async function deleteCachedConversation(
  conversationId: string,
): Promise<void> {
  try {
    const markers = readCachedIdMarkers();
    delete markers[conversationId];
    localStorage.setItem(CACHED_IDS_STORAGE_KEY, JSON.stringify(markers));
  } catch {
    // Best-effort; the IndexedDB delete below is the part that matters.
  }

  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(conversationId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Test-only: reset the module-level DB handle so tests get a fresh open(). */
export function __resetLocalConversationCacheForTests(): void {
  dbPromise = null;
  pendingTimers.forEach((t) => clearTimeout(t));
  pendingTimers.clear();
  pendingWrites.clear();
}

/**
 * Test-only: write a cache entry directly with a caller-chosen `updatedAt`,
 * bypassing the debounce and the "now" timestamp — used to exercise TTL
 * expiry/pruning without mocking global timers (which conflicts with
 * fake-indexeddb's own internal scheduling).
 */
export async function __setRawCacheEntryForTests(
  conversationId: string,
  events: OHEvent[],
  updatedAt: number,
): Promise<void> {
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      conversationId,
      events,
      updatedAt,
    } satisfies CacheEntry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });

  // Mirror the *given* updatedAt into the sync marker too (rather than
  // delegating to markConversationCachedSync, which always stamps "now") so
  // tests can exercise the marker's own TTL check independently of the
  // IndexedDB entry's TTL check.
  try {
    const markers = readCachedIdMarkers();
    markers[conversationId] = updatedAt;
    localStorage.setItem(CACHED_IDS_STORAGE_KEY, JSON.stringify(markers));
  } catch {
    // Best-effort, matching every other localStorage write in this module.
  }
}

/**
 * Test-only: wipe every entry from the underlying IndexedDB object store
 * (not just the module-level connection state). Needed for test isolation
 * because, exactly like a real browser, closing and reopening a connection
 * to the same database name does NOT clear its contents.
 */
export async function __clearAllCacheDataForTests(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
