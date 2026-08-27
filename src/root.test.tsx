import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import {
  __resetHealthStoreForTests,
  recordBackendFailure,
} from "#/api/backend-registry/health-store";
import { MAX_CONSECUTIVE_FAILURES } from "#/api/backend-registry/health-storage";
import { CLOUD_BACKEND_API_KEY_OR_NETWORK_ERROR } from "#/hooks/query/use-backends-health";
import type { Backend } from "#/api/backend-registry/types";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import { ONBOARDING_COMPLETED_STORAGE_KEY } from "#/components/features/onboarding/use-onboarding-completion";
import { __resetLocalConversationCacheForTests } from "#/lib/local-conversation-cache";
import App from "#/root";

// The recovery screen lazy-loads the Manage Backends modal; stub it so the test
// asserts the routing decision rather than the modal's internals.
vi.mock("#/components/features/backends/manage-backends-modal", () => ({
  ManageBackendsModal: () => <div data-testid="manage-backends-modal" />,
}));

const cloudBackend: Backend = {
  id: "cloud-ohe",
  name: "Adorable Enterprise",
  host: "https://app.adorable.build.one",
  apiKey: "oh-cloud-key",
  kind: "cloud",
};

function renderApp(initialPath = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: App,
        children: [
          { index: true, element: <div data-testid="app-outlet-content" /> },
          {
            path: "conversations/:id",
            element: <div data-testid="app-outlet-content" />,
          },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );

  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveBackendProvider>
        <RouterProvider router={router} />
      </ActiveBackendProvider>
    </QueryClientProvider>,
  );
}

describe("App root — active cloud backend connectivity gate", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetHealthStoreForTests();
    localStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, "1");
    setRegisteredBackends([cloudBackend]);
    setActiveSelection({ backendId: cloudBackend.id });
  });

  afterEach(() => {
    setActiveSelection(null);
    setRegisteredBackends([]);
    localStorage.clear();
    __resetHealthStoreForTests();
  });

  it("shows the backend recovery screen when the active cloud backend is unreachable (CORS/network)", async () => {
    // Emulate a self-hosted OHE that doesn't allow this frontend's origin:
    // repeated CORS/network probe failures until the backend is disabled.
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      recordBackendFailure(
        cloudBackend.id,
        new Error(CLOUD_BACKEND_API_KEY_OR_NETWORK_ERROR),
      );
    }

    renderApp();

    expect(
      await screen.findByTestId("agent-server-onboarding-screen"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app-outlet-content")).not.toBeInTheDocument();
  });
});

describe("App root — optimistic render of a locally-cached conversation", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetHealthStoreForTests();
    __resetLocalConversationCacheForTests();
    localStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, "1");
    setRegisteredBackends([cloudBackend]);
    setActiveSelection({ backendId: cloudBackend.id });
  });

  afterEach(() => {
    setActiveSelection(null);
    setRegisteredBackends([]);
    localStorage.clear();
    __resetHealthStoreForTests();
    __resetLocalConversationCacheForTests();
  });

  it("still shows the recovery screen for an unreachable backend when there is NO local cache for the route", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      recordBackendFailure(
        cloudBackend.id,
        new Error(CLOUD_BACKEND_API_KEY_OR_NETWORK_ERROR),
      );
    }

    renderApp("/conversations/convo-without-cache");

    expect(
      await screen.findByTestId("agent-server-onboarding-screen"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app-outlet-content")).not.toBeInTheDocument();
  });

  it("optimistically renders a conversation route the user has a fresh local mirror for, instead of the recovery screen", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      recordBackendFailure(
        cloudBackend.id,
        new Error(CLOUD_BACKEND_API_KEY_OR_NETWORK_ERROR),
      );
    }

    // Simulate a conversation we've already rendered locally in a previous
    // session, per the synchronous marker written by
    // src/lib/local-conversation-cache.ts.
    localStorage.setItem(
      "oh:locally-cached-conversation-ids",
      JSON.stringify({ "cached-convo": Date.now() }),
    );

    renderApp("/conversations/cached-convo");

    expect(await screen.findByTestId("app-outlet-content")).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-server-onboarding-screen"),
    ).not.toBeInTheDocument();
  });

  it("does not bypass the recovery screen for a stale (>5 day) local cache marker", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      recordBackendFailure(
        cloudBackend.id,
        new Error(CLOUD_BACKEND_API_KEY_OR_NETWORK_ERROR),
      );
    }

    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      "oh:locally-cached-conversation-ids",
      JSON.stringify({ "stale-convo": sixDaysAgo }),
    );

    renderApp("/conversations/stale-convo");

    expect(
      await screen.findByTestId("agent-server-onboarding-screen"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app-outlet-content")).not.toBeInTheDocument();
  });
});
