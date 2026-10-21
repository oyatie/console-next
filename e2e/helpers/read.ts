import type { Page, Route } from "@playwright/test";

/** Hold a real read until the test has checked what stays hidden or pending while it loads. */
export async function holdRead(page: Page, url: string | RegExp) {
  let release!: () => void;
  let reading!: () => void;
  let continued!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { reading = resolve; });
  const answered = new Promise<void>((resolve) => { continued = resolve; });
  const handler = async (route: Route) => { reading(); await held; await route.continue(); continued(); };
  await page.route(url, handler);
  return { requested, release: async () => { release(); await answered; await page.unroute(url, handler); } };
}
