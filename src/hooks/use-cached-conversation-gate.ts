import * as React from "react";
import { hasSyncCacheMarker } from "#/lib/local-conversation-cache";

const CONVERSATION_PATH_PATTERN = /^\/conversations\/([^/]+)/;

/**
 * How long we let a previously-seen conversation render optimistically from
 * local cache while the root backend health probe (`/server_info`) is still
 * resolving or retrying, before falling back to the normal blocking
 * loading/error screens.
 *
 * Long enough to ride out a mobile network blip, a backgrounded-tab wake-up,
 * or a Cloud sandbox cold-start reconnect. Short enough that a genuinely
 * dead backend or a real logout doesn't strand the user on a silently stale
 * screen forever — after the window elapses, `src/root.tsx` reverts to
 * exactly the behavior it had before this change.
 */
export const GRACE_PERIOD_MS = 10_000;

export function getConversationIdFromPath(pathname: string): string | null {
  return CONVERSATION_PATH_PATTERN.exec(pathname)?.[1] ?? null;
}

/**
 * Whether the root app gate should optimistically render the current route
 * from local cache instead of the blocking "connecting…" / "no backend"
 * screens: true only when (a) the current path is a conversation we have a
 * fresh local mirror for, and (b) the grace window since landing on it
 * hasn't elapsed yet.
 *
 * This is scoped deliberately narrowly — every other gate in `root.tsx`
 * (first-run onboarding, missing auth, locked-Cloud host mismatch) is
 * evaluated before this one ever runs, and is completely unaffected by it.
 */
export function useCachedConversationGate(pathname: string): boolean {
  const conversationId = getConversationIdFromPath(pathname);

  // Fast, fully-inert path: when we're not on a conversation route, or we
  // don't have a fresh local mirror for it, the hook is a synchronous no-op
  // that returns false immediately ("no cached conversation"). This keeps
  // every other root gate (onboarding, auth, locked-Cloud, host mismatch) —
  // and the lazy no-backend recovery modal — completely unaffected whenever
  // there is nothing to restore, which is the behavior the pre-existing
  // tests rely on.
  const cached = conversationId !== null && hasSyncCacheMarker(conversationId);

  // The grace window only exists when there is a fresh cached conversation.
  // When there is nothing cached the effect below is a no-op that schedules
  // no timer and triggers no extra render.
  const [withinGrace, setWithinGrace] = React.useState(cached);

  React.useEffect(() => {
    if (!cached) {
      // Nothing cached → leave state untouched and arm no timer, so the
      // mount effect never triggers a redundant render in this case.
      return undefined;
    }
    setWithinGrace(true);
    const timer = setTimeout(() => setWithinGrace(false), GRACE_PERIOD_MS);
    return () => clearTimeout(timer);
    // Re-arms whenever the resolved conversation id changes (navigating
    // between cached conversations gets its own fresh grace window).
  }, [conversationId, cached]);

  return cached && withinGrace;
}
