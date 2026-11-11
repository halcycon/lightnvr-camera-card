import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";

// Absent infrastructure is an explicit skip, never a simulated compatibility pass.
test("owned Home Assistant and lightNVR: real card acceptance matrix", async () => {
  test.skip(
    !process.env.LIGHTNVR_HA_FIXTURE || !process.env.LIGHTNVR_PROBE_FIXTURE,
    "NOT TESTED: provision both isolated fixtures; see tests/e2e/README.md",
  );
  test.setTimeout(600_000);
  const result = await new Promise<{ code: number | null; passed: number }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["tests/e2e/ha-acceptance.mjs"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 550_000,
      });
      let output = "";
      // Browser exceptions may contain authorization redirects. Do not publish raw output.
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          code,
          passed: output.split("\n").filter((line) => line.startsWith("PASS "))
            .length,
        }),
      );
    },
  );
  expect(
    result.code,
    "Inspect the private sanitized receipt; raw browser redirects are suppressed",
  ).toBe(0);
  expect(result.passed).toBeGreaterThanOrEqual(14);
});
