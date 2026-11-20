// SPDX-License-Identifier: LicenseRef-Proprietary
export const DEFAULT_STATUS_ORIGIN = "https://status.cosskorea.com";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasUnsafeOriginChars(value: string): boolean {
  if (hasAsciiControl(value) || /\s/.test(value)) return true;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === ";" || ch === "," || ch === "*" || ch === "'" || ch === '"' || ch === "\\" || ch === "%" || ch === "@") {
      return true;
    }
  }
  return false;
}

export function resolveStatusOrigin(raw?: string | null): string {
  if (!raw || hasAsciiControl(raw)) return DEFAULT_STATUS_ORIGIN;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_STATUS_ORIGIN;
  if (
    hasUnsafeOriginChars(trimmed) ||
    trimmed.endsWith("/") ||
    trimmed.endsWith("/.") ||
    trimmed.endsWith("/..")
  ) {
    return DEFAULT_STATUS_ORIGIN;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return DEFAULT_STATUS_ORIGIN;
    }
    if (parsed.pathname !== "/" || parsed.port === "0") {
      return DEFAULT_STATUS_ORIGIN;
    }
    if (
      parsed.origin === "null" ||
      !parsed.hostname ||
      parsed.hostname.includes("*") ||
      hasUnsafeOriginChars(parsed.origin)
    ) {
      return DEFAULT_STATUS_ORIGIN;
    }
    if (parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.origin;
    return DEFAULT_STATUS_ORIGIN;
  } catch {
    return DEFAULT_STATUS_ORIGIN;
  }
}

export const STATUS_PAGE_URL = resolveStatusOrigin(import.meta.env?.VITE_STATUS_ORIGIN);
