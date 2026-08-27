import {
  getRawErrorMessage,
  isBackendRequestTimeoutMessage,
  isCorsOrNetworkError,
} from "./user-facing-error";

/**
 * True for errors that are transient by nature — the network dropped, a
 * request timed out, or a CORS/reachability hiccup — rather than a permanent
 * failure of the request itself.
 *
 * These are expected during normal mobile use (a backgrounded refetch that
 * briefly fails while the link is slow, a timeout on a busy backend, a
 * reconnecting WebSocket) and the rest of the UI already surfaces the
 * connection state (status pillar, WebSocket banner) and recovers on its own.
 * The global React Query cache therefore skips the error toast for them so a
 * healthy, otherwise-working session does not spam "Unable to connect"
 * notifications. Permanent errors — HTTP 4xx/5xx carrying a real server
 * message, explicit per-query `disableToast` flags, auth failures — are
 * unaffected.
 */
export function shouldSuppressTransientConnectionErrorToast(
  error: unknown,
): boolean {
  if (isCorsOrNetworkError(error)) return true;
  return isBackendRequestTimeoutMessage(getRawErrorMessage(error) ?? "");
}
