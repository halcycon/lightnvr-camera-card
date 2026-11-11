import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientFactory } from "../../../src/api";
import { controllers, configuration, harness, mockClient } from "./fixture";

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const cleanup = Promise.all(controllers.splice(0).map((c) => c.dispose()));
  await vi.advanceTimersByTimeAsync(2100);
  await cleanup;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("refcounted API integration", () => {
  it("keeps the second API reference and cached identity alive after the first card releases", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const body = url.pathname.endsWith("/verify")
        ? {
            authenticated: true,
            username: "generated-viewer",
            must_change_password: false,
          }
        : url.pathname.endsWith("/login")
          ? { success: true }
          : url.pathname.endsWith("/client-config")
            ? { go2rtc_enabled: true }
            : {
                streams: [
                  { name: "generated", enabled: true, status: "Running" },
                ],
                page: 1,
                page_size: 100,
                total: 1,
                total_pages: 1,
              };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const factory = createClientFactory({
      documentUrl: "https://dashboard.example.test/",
      fetch,
    });
    const config = configuration({
        username: "generated-viewer",
        password: "generated-owned-only",
      }),
      firstClient = factory(config),
      secondClient = factory(config);
    const first = harness({
      api: { ...mockClient(), asClient: () => firstClient },
    });
    const second = harness({
      api: { ...mockClient(), asClient: () => secondClient },
    });
    try {
      await Promise.all([
        first.controller.start(first.video.asVideo(), config),
        second.controller.start(second.video.asVideo(), config),
      ]);
      first.last().frame();
      second.last().frame();
      expect(
        fetch.mock.calls.filter(([url]) => String(url).endsWith("/verify")),
      ).toHaveLength(1);
      await first.controller.dispose();
      firstClient.dispose();
      await second.controller.retry();
      second.last().frame();
      expect(second.controller.snapshot.state).toBe("playing");
      expect(first.adapters).toHaveLength(1);
      expect(
        fetch.mock.calls.filter(([url]) => String(url).endsWith("/verify")),
      ).toHaveLength(1);
      expect(
        fetch.mock.calls.some(([url]) =>
          /refresh|control|go2rtc\/api\/streams/.test(String(url)),
        ),
      ).toBe(false);
      await second.controller.dispose();
      secondClient.dispose();
      const fresh = factory(config);
      try {
        await fresh.connect();
      } finally {
        fresh.dispose();
      }
      expect(
        fetch.mock.calls.filter(([url]) => String(url).endsWith("/verify")),
      ).toHaveLength(2);
    } finally {
      await Promise.all([
        first.controller.dispose(),
        second.controller.dispose(),
      ]);
      firstClient.dispose();
      secondClient.dispose();
    }
  });
});
