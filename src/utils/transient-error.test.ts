import { describe, expect, it } from "vitest";
import { shouldSuppressTransientConnectionErrorToast } from "./transient-error";

describe("shouldSuppressTransientConnectionErrorToast", () => {
  it("suppresses browser fetch failures", () => {
    expect(
      shouldSuppressTransientConnectionErrorToast(
        new Error("Request failed: Failed to fetch"),
      ),
    ).toBe(true);
  });

  it("suppresses failures nested in a cause chain (fetch-based clients)", () => {
    expect(
      shouldSuppressTransientConnectionErrorToast(
        new Error("Request failed", {
          cause: new TypeError("Failed to fetch"),
        }),
      ),
    ).toBe(true);
  });

  it("suppresses network errors and CORS blocks", () => {
    expect(
      shouldSuppressTransientConnectionErrorToast(new Error("Network Error")),
    ).toBe(true);
    expect(
      shouldSuppressTransientConnectionErrorToast(
        new Error("Request blocked by CORS policy"),
      ),
    ).toBe(true);
  });

  it("suppresses backend request timeouts", () => {
    expect(
      shouldSuppressTransientConnectionErrorToast(
        new Error("Request timeout after 5000ms"),
      ),
    ).toBe(true);
  });

  it("keeps ordinary server errors", () => {
    expect(
      shouldSuppressTransientConnectionErrorToast(new Error("Invalid API key")),
    ).toBe(false);
  });

  it("keeps Axios-style errors with a real server message", () => {
    expect(
      shouldSuppressTransientConnectionErrorToast({
        isAxiosError: true,
        message: "Request failed with status code 400",
        response: { status: 400 },
      }),
    ).toBe(false);
  });

  it("returns false for junk or empty input", () => {
    expect(shouldSuppressTransientConnectionErrorToast(null)).toBe(false);
    expect(shouldSuppressTransientConnectionErrorToast(undefined)).toBe(false);
    expect(shouldSuppressTransientConnectionErrorToast("")).toBe(false);
  });
});
