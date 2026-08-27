import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConversationIdFromPath,
  GRACE_PERIOD_MS,
  useCachedConversationGate,
} from "#/hooks/use-cached-conversation-gate";

const MARKERS_KEY = "oh:locally-cached-conversation-ids";

function setMarker(conversationId: string, ageMs = 0) {
  const raw = localStorage.getItem(MARKERS_KEY);
  const markers = raw ? JSON.parse(raw) : {};
  markers[conversationId] = Date.now() - ageMs;
  localStorage.setItem(MARKERS_KEY, JSON.stringify(markers));
}

describe("getConversationIdFromPath", () => {
  it("extracts the conversation id from a conversation route", () => {
    expect(getConversationIdFromPath("/conversations/abc-123")).toBe("abc-123");
  });

  it("extracts the id when the route has trailing segments", () => {
    expect(
      getConversationIdFromPath("/conversations/abc-123/files/foo.ts"),
    ).toBe("abc-123");
  });

  it("returns null for a non-conversation route", () => {
    expect(getConversationIdFromPath("/settings")).toBeNull();
    expect(getConversationIdFromPath("/")).toBeNull();
  });
});

describe("useCachedConversationGate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("returns false for a route with no local cache marker", () => {
    const { result } = renderHook(() =>
      useCachedConversationGate("/conversations/no-cache"),
    );
    expect(result.current).toBe(false);
  });

  it("returns false for a non-conversation route even with markers present", () => {
    setMarker("some-convo");
    const { result } = renderHook(() => useCachedConversationGate("/"));
    expect(result.current).toBe(false);
  });

  it("returns true immediately for a conversation with a fresh marker", () => {
    setMarker("cached-convo");
    const { result } = renderHook(() =>
      useCachedConversationGate("/conversations/cached-convo"),
    );
    expect(result.current).toBe(true);
  });

  it("reverts to false once the grace period elapses", () => {
    setMarker("cached-convo");
    const { result } = renderHook(() =>
      useCachedConversationGate("/conversations/cached-convo"),
    );
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(GRACE_PERIOD_MS + 100);
    });

    expect(result.current).toBe(false);
  });

  it("does not bypass for a marker older than the 5-day TTL", () => {
    setMarker("stale-convo", 6 * 24 * 60 * 60 * 1000);
    const { result } = renderHook(() =>
      useCachedConversationGate("/conversations/stale-convo"),
    );
    expect(result.current).toBe(false);
  });

  it("re-arms a fresh grace window when navigating to a different cached conversation", () => {
    setMarker("convo-a");
    setMarker("convo-b");

    const { result, rerender } = renderHook(
      ({ pathname }: { pathname: string }) =>
        useCachedConversationGate(pathname),
      { initialProps: { pathname: "/conversations/convo-a" } },
    );
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(GRACE_PERIOD_MS - 100);
    });
    expect(result.current).toBe(true);

    // Navigate to a different cached conversation just before convo-a's
    // grace window would have expired — it should get its own fresh window
    // rather than inheriting the near-expired one.
    rerender({ pathname: "/conversations/convo-b" });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(GRACE_PERIOD_MS - 100);
    });
    expect(result.current).toBe(true);
  });
});
