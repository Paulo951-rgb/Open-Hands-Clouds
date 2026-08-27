import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OHEvent } from "#/stores/use-event-store";
import {
  __clearAllCacheDataForTests,
  __resetLocalConversationCacheForTests,
  __setRawCacheEntryForTests,
  CACHE_MAX_AGE_MS,
  deleteCachedConversation,
  flushPendingCacheWrites,
  getCachedConversationEvents,
  hasFreshCachedConversation,
  hasSyncCacheMarker,
  pruneExpiredConversations,
  scheduleCacheWrite,
} from "#/lib/local-conversation-cache";

function makeEvent(id: string, timestamp: string): OHEvent {
  return {
    id,
    timestamp,
    source: "agent",
    // Minimal shape — the cache module treats events as opaque JSON, it
    // never inspects fields beyond what's needed for trimming/sorting.
  } as unknown as OHEvent;
}

/** Real (short) wait — fake-indexeddb schedules its callbacks using real
 * timers internally, so faking global timers in these tests would hang the
 * underlying library rather than speeding it up. */
function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("local-conversation-cache", () => {
  beforeEach(async () => {
    localStorage.clear();
    __resetLocalConversationCacheForTests();
    await __clearAllCacheDataForTests();
  });

  afterEach(async () => {
    localStorage.clear();
    await __clearAllCacheDataForTests();
    __resetLocalConversationCacheForTests();
  });

  it("returns null for a conversation that was never cached", async () => {
    const result = await getCachedConversationEvents("unknown-convo");
    expect(result).toBeNull();
  });

  it("writes are debounced: no data is persisted before the debounce window elapses", async () => {
    const events = [makeEvent("1", "2026-01-01T00:00:00Z")];
    scheduleCacheWrite("convo-1", events);

    // Still within the debounce window — nothing written yet.
    await wait(20);
    expect(await getCachedConversationEvents("convo-1")).toBeNull();

    // Past the ~350ms debounce window.
    await wait(500);
    expect(await getCachedConversationEvents("convo-1")).toEqual(events);
  }, 10_000);

  it("a later scheduled write within the debounce window replaces the earlier one (no stale write)", async () => {
    scheduleCacheWrite("convo-1", [makeEvent("1", "2026-01-01T00:00:00Z")]);
    await wait(100);
    scheduleCacheWrite("convo-1", [
      makeEvent("1", "2026-01-01T00:00:00Z"),
      makeEvent("2", "2026-01-01T00:00:01Z"),
    ]);

    await wait(500);

    const result = await getCachedConversationEvents("convo-1");
    expect(result).toHaveLength(2);
  }, 10_000);

  it("flushPendingCacheWrites persists immediately without waiting for the debounce timer", async () => {
    scheduleCacheWrite("convo-1", [makeEvent("1", "2026-01-01T00:00:00Z")]);
    flushPendingCacheWrites();
    // The flushed write is fire-and-forget; give the transaction a tick.
    await wait(50);

    const result = await getCachedConversationEvents("convo-1");
    expect(result).toHaveLength(1);
  }, 10_000);

  it("hasFreshCachedConversation reflects whether a non-empty entry exists", async () => {
    expect(await hasFreshCachedConversation("convo-1")).toBe(false);

    scheduleCacheWrite("convo-1", [makeEvent("1", "2026-01-01T00:00:00Z")]);
    flushPendingCacheWrites();
    await wait(50);

    expect(await hasFreshCachedConversation("convo-1")).toBe(true);
  }, 10_000);

  it("expired entries (older than CACHE_MAX_AGE_MS) are treated as absent on read", async () => {
    await __setRawCacheEntryForTests(
      "convo-1",
      [makeEvent("1", "2026-01-01T00:00:00Z")],
      Date.now() - (CACHE_MAX_AGE_MS + 1000),
    );

    expect(await getCachedConversationEvents("convo-1")).toBeNull();
  });

  it("a fresh entry (well within CACHE_MAX_AGE_MS) is returned", async () => {
    await __setRawCacheEntryForTests(
      "convo-1",
      [makeEvent("1", "2026-01-01T00:00:00Z")],
      Date.now() - 1000,
    );

    expect(await getCachedConversationEvents("convo-1")).toHaveLength(1);
  });

  it("pruneExpiredConversations removes stale entries but keeps fresh ones", async () => {
    await __setRawCacheEntryForTests(
      "old-convo",
      [makeEvent("1", "2026-01-01T00:00:00Z")],
      Date.now() - (CACHE_MAX_AGE_MS + 1000),
    );
    await __setRawCacheEntryForTests(
      "fresh-convo",
      [makeEvent("2", "2026-01-08T00:00:00Z")],
      Date.now() - 1000,
    );

    await pruneExpiredConversations();

    expect(await hasFreshCachedConversation("old-convo")).toBe(false);
    expect(await hasFreshCachedConversation("fresh-convo")).toBe(true);
  });

  it("deleteCachedConversation removes both the IndexedDB entry and the sync marker", async () => {
    scheduleCacheWrite("convo-1", [makeEvent("1", "2026-01-01T00:00:00Z")]);
    flushPendingCacheWrites();
    await wait(50);

    expect(hasSyncCacheMarker("convo-1")).toBe(true);

    await deleteCachedConversation("convo-1");

    expect(await getCachedConversationEvents("convo-1")).toBeNull();
    expect(hasSyncCacheMarker("convo-1")).toBe(false);
  }, 10_000);

  it("hasSyncCacheMarker is synchronous and reflects a successful write immediately", async () => {
    expect(hasSyncCacheMarker("convo-1")).toBe(false);

    scheduleCacheWrite("convo-1", [makeEvent("1", "2026-01-01T00:00:00Z")]);
    flushPendingCacheWrites();
    await wait(50);

    expect(hasSyncCacheMarker("convo-1")).toBe(true);
  }, 10_000);

  it("hasSyncCacheMarker returns false for a null/empty conversation id", () => {
    expect(hasSyncCacheMarker(null)).toBe(false);
    expect(hasSyncCacheMarker("")).toBe(false);
  });

  it("hasSyncCacheMarker enforces the same 5-day TTL as the IndexedDB entry", async () => {
    await __setRawCacheEntryForTests(
      "convo-1",
      [makeEvent("1", "t")],
      Date.now() - (CACHE_MAX_AGE_MS + 1000),
    );

    expect(hasSyncCacheMarker("convo-1")).toBe(false);
  });

  it("scheduleCacheWrite is a safe no-op for an empty conversation id", async () => {
    expect(() => scheduleCacheWrite("", [makeEvent("1", "t")])).not.toThrow();
    flushPendingCacheWrites();
    await wait(50);
    expect(await getCachedConversationEvents("")).toBeNull();
  }, 10_000);
});
