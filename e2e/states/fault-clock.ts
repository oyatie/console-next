// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page, Request } from "@playwright/test";
import { REALTIME } from "../../apps/web/src/lib/freshness";

// Upper bounds of queryDefaults.retryDelay's jitter for the two automatic retries.
const retrySteps = [2_000, 4_000];
export const faultAttempts = retrySteps.length + 1;

const apiRead = (request: Request) => request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/");

/** Advance once per completed fault with retries left. Parallel failures share the same clock step. */
export async function installFaultClock(page: Page, isRead = apiRead) {
  await page.clock.install();
  const failures = new Map<string, number>();
  let advanced = 0;
  let pending = 0;
  const onFault = async (request: Request) => {
    if (!isRead(request)) return;
    const attempt = failures.get(request.url()) ?? 0;
    failures.set(request.url(), (attempt + 1) % faultAttempts);
    const step = retrySteps[attempt];
    if (!step) return;
    if (pending) {
      pending = Math.max(pending, step);
      return;
    }
    pending = step;
    try {
      // Let fetch consume the reply and the query client schedule its retry before advancing.
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const jump = pending;
      pending = 0;
      if (advanced + jump >= REALTIME.heartbeatInterval * REALTIME.deadAfterHeartbeats) return;
      advanced += jump;
      await page.clock.fastForward(jump);
    } catch (error) {
      pending = 0;
      // Navigation cancels the old document's retry along with its animation frame.
      if (!page.isClosed() && !(error instanceof Error && error.message.includes("Execution context was destroyed"))) throw error;
    }
  };
  page.on("requestfinished", request => {
    if ((request.existingResponse()?.status() ?? 0) >= 500) return onFault(request);
    failures.delete(request.url());
  });
  page.on("requestfailed", request => {
    if (!/abort/i.test(request.failure()?.errorText ?? "")) return onFault(request);
  });
}
