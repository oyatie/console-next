// SPDX-License-Identifier: LicenseRef-Proprietary

export function normalizeAppPath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.replace(/\/+$/, "") || "/";
  }
  return collapsed || "/";
}

const splitHref = (href: string): { path: string; search: string; hash: string } => {
  const hashIdx = href.indexOf("#");
  const hash = hashIdx === -1 ? "" : href.slice(hashIdx);
  const beforeHash = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const queryIdx = beforeHash.indexOf("?");
  const search = queryIdx === -1 ? "" : beforeHash.slice(queryIdx);
  const rawPath = queryIdx === -1 ? beforeHash : beforeHash.slice(0, queryIdx);
  return { path: normalizeAppPath(rawPath || "/"), search, hash };
};

export const hrefPath = (href: string): string => splitHref(href).path;

export const canonicalHref = (href: string): string => {
  const { path, search, hash } = splitHref(href);
  if (!search) return `${path}${hash.length > 1 ? hash : ""}`;
  const params = new URLSearchParams(search);
  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const normalizedSearch = entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : "";
  return `${path}${normalizedSearch}${hash.length > 1 ? hash : ""}`;
};

export const sameCanonicalHref = (a: string, b: string): boolean => canonicalHref(a) === canonicalHref(b);

const VIEW_QUERY_KEYS: Readonly<Record<string, readonly string[]>> = {
  "/org": ["tab", "filter"],
  "/people": ["view", "placement", "tab"],
  "/attendance": ["tab", "view"],
  "/statutory": ["tab"],
};

export const isViewQueryRoute = (href: string): boolean => {
  const { path, search } = splitHref(href);
  const keys = VIEW_QUERY_KEYS[path];
  if (!keys || !search) return false;
  const params = new URLSearchParams(search);
  return keys.some(key => {
    const val = params.get(key);
    return val !== null && val !== "";
  });
};

export const hasHash = (href: string): boolean => splitHref(href).hash.length > 1;

const hrefWithoutHash = (href: string): string => {
  const { path, search } = splitHref(href);
  return `${path}${search}`;
};

export function canonicalViewTarget(href: string): string {
  const { path, search } = splitHref(href);
  if (!search) return path;
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  if (path === "/org") {
    const tab = params.get("tab");
    if (tab === "entities" || tab === "changes") kept.set("tab", tab);
    if (tab === "changes" && params.get("filter") === "history") kept.set("filter", "history");
  } else if (path === "/people") {
    const view = params.get("view");
    const placement = params.get("placement");
    const tab = params.get("tab");
    if (view === "accounts") kept.set("view", view);
    else if (placement === "unplaced") kept.set("placement", placement);
    else if (tab) kept.set("tab", tab);
  } else if (path === "/attendance") {
    const tab = params.get("tab");
    const view = params.get("view");
    if (tab && tab !== "month") kept.set("tab", tab);
    else if (view) kept.set("view", view);
  } else if (path === "/statutory") {
    const tab = params.get("tab");
    if (tab === "register") kept.set("tab", tab);
  }
  const qs = kept.toString();
  return qs ? `${path}?${qs}` : path;
}

export const hasQueryOrHash = (href: string): boolean => {
  const { search, hash } = splitHref(href);
  return Boolean(search || hash.length > 1);
};

export const sameTabTarget = (tabHref: string, target: string): boolean => {
  if (sameCanonicalHref(tabHref, target)) return true;
  if (hrefPath(tabHref) !== hrefPath(target)) return false;
  if (hasHash(target)) return false;
  if (sameCanonicalHref(hrefWithoutHash(tabHref), target)) return true;
  if (isViewQueryRoute(target) && sameCanonicalHref(canonicalViewTarget(tabHref), target)) return true;
  if (hasQueryOrHash(target)) return false;
  return !isViewQueryRoute(tabHref);
};
