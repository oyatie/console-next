// SPDX-License-Identifier: LicenseRef-Proprietary
/** Embedded documents use local object URLs; photos also accept HTTPS and raster image data. */
export function safeMediaUrl(value: string | null | undefined, kind: "image" | "document"): string | null {
  if (!value) return null;
  if (kind === "image" && /^\/(?!\/)[^\\\s]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "blob:" && url.origin !== "null") return url.href;
    if (kind === "image" && (url.protocol === "https:" || /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(url.href))) return url.href;
  } catch {
    return null;
  }
  return null;
}
