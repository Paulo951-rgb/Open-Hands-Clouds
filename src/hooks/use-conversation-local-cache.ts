import * as React from "react";
import { useEventStore, type OHEvent } from "#/stores/use-event-store";
import {
  getCachedConversationEvents,
  scheduleCacheWrite,
  flushPendingCacheWrites,
} from "#/lib/local-conversation-cache";

/**
 * On mount (or when switching to a conversation we haven't loaded events
 * for yet), read the local IndexedDB mirror and seed the event store with
 * it right away — before the REST history fetch or the WebSocket replay
 * have had a chance to respond. This is what lets `chat-interface.tsx`'s
 * existing `showConversationMessages` check skip the loading skeleton.
 *
 * Safe by construction:
 *  - `addEvents` de-dupes by event id, so whatever the server later sends
 *    (REST history + WS `since` replay) merges cleanly with no duplicates.
 *  - A staleness guard (`requestedIdRef`) drops the result if the user has
 *    already navigated to a different conversation by the time the async
 *    IndexedDB read resolves.
 *  - Never overwrites live data: it only *adds* events, it never clears the
 *    store (clearing on conversation switch is owned by
 *    `conversation-websocket-context.tsx`, which runs first).
 */
export function useHydrateConversationFromLocalCache(
  conversationId: string | undefined | null,
): void {
  const addEvents = useEventStore((state) => state.addEvents);

  React.useEffect(() => {
    if (!conversationId) return undefined;

    let cancelled = false;
    getCachedConversationEvents(conversationId)
      .then((cached) => {
        if (cancelled || !cached || cached.length === 0) return;
        // Only seed if this conversation is still the one loaded/loading —
        // avoids a slow read racing a fast conversation switch.
        const current = useEventStore.getState();
        if (
          current.loadedConversationId !== null &&
          current.loadedConversationId !== conversationId
        ) {
          return;
        }
        addEvents(cached);
      })
      .catch(() => {
        // Best-effort cache; a failed read just means we fall back to the
        // normal network path, same as if there were no cache at all.
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, addEvents]);
}

/**
 * Mirrors the active conversation's events into the local IndexedDB cache
 * as they change, debounced inside `scheduleCacheWrite`. Cheap to leave
 * mounted for the lifetime of the conversation view — the debounce means a
 * fast-streaming response triggers at most a handful of writes, not one per
 * token.
 */
export function usePersistConversationToLocalCache(): void {
  React.useEffect(
    () =>
      useEventStore.subscribe((state, prevState) => {
        if (state.events === prevState.events || !state.loadedConversationId) {
          return;
        }
        scheduleCacheWrite(
          state.loadedConversationId,
          state.events as OHEvent[],
        );
      }),
    [],
  );
}

/**
 * Installed once near the app root. Flushes any pending debounced cache
 * writes when the tab is backgrounded or torn down, so a brutal close
 * (phone lock, swipe-away, browser kill) loses at most the last
 * `WRITE_DEBOUNCE_MS` of streamed content instead of the whole session.
 *
 * Deliberately listens to `visibilitychange`/`pagehide` rather than relying
 * on `beforeunload`, which mobile browsers frequently skip entirely.
 */
export function useFlushLocalCacheOnBackground(): void {
  React.useEffect(() => {
    const flush = () => flushPendingCacheWrites();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flush);
    // Kept as a last-resort net in addition to the above, never as the
    // primary mechanism (see module doc).
    window.addEventListener("beforeunload", flush);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);
}
