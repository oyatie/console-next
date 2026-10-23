// SPDX-License-Identifier: LicenseRef-Proprietary
/** Photos accept same-origin paths, HTTPS, loopback HTTP, object URLs and raster image data. */
export function safeMediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const relative = /^\/(?!\/)[^\\\s]*$/.test(value);
    const url = new URL(value, relative ? globalThis.location?.origin : undefined);
    if (url.protocol === "blob:" && url.origin !== "null") return url.href;
    if (url.protocol === "https:"
      || (url.protocol === "http:" && (relative || ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
      || /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(url.href)) return url.href;
  } catch {
    return null;
  }
  return null;
}
