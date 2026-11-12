// SPDX-License-Identifier: LicenseRef-Proprietary
export function readyHref(committedHref: string, browserHref: string) {
  const browser = new URL(browserHref);
  const committed = new URL(committedHref, browserHref);
  const href = browser.pathname + browser.search + browser.hash;
  browser.search = browser.searchParams.toString();
  committed.search = committed.searchParams.toString();
  return committed.href === browser.href ? href : undefined;
}
