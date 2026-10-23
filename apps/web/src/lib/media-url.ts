// SPDX-License-Identifier: LicenseRef-Proprietary
/** Documents use object URLs; photos also accept HTTPS, loopback HTTP and raster image data. */
export function safeMediaUrl(value: string | null | undefined, kind: "image" | "document"): string | null {
  if (!value) return null;
  if (kind === "image" && /^\/(?!\/)[^\\\s]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "blob:" && url.origin !== "null") return url.href;
    if (kind === "image" && (url.protocol === "https:"
      || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
      || /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(url.href))) return url.href;
  } catch {
    return null;
  }
  return null;
}
