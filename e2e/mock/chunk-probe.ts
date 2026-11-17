// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { PORTS } from "../slot";

/** Hold built chunks by manifest source so hash changes cannot silently bypass a probe. */
export async function holdChunks(page: Page, sources: readonly string[]) {
  const manifest = JSON.parse(readFileSync(`.cache/states-${PORTS.web}/.vite/manifest.json`, "utf8")) as Record<string, { file: string }>;
  const paths = new Set(sources.map(source => {
    expect(manifest[source], `${source} must remain a separate chunk`).toBeDefined();
    return `/${manifest[source]!.file}`;
  }));
  const held = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const requests: string[] = [];
  await page.route(url => paths.has(url.pathname), async route => {
    requests.push(new URL(route.request().url()).pathname);
    requested.resolve();
    await held.promise;
    if (!page.isClosed()) await route.continue();
  });
  return { requests, requested: requested.promise, release: held.resolve };
}
