// SPDX-License-Identifier: LicenseRef-Proprietary
import s from "./avatar.module.css";
import { safeMediaUrl } from "../../lib/media-url";

/**
 * A person's initial or photo (kit .avatar / .mlist .av): decorative unless `alt` or `fallbackAlt` names it.
 * `sm` (20–22 px) in rows and frame bars, `md` in sheets and headers, `lg` (64 px) on a person's record.
 * Radius follows `--radius-avatar` (round on baseline, square under Control room).
 */
export function Avatar({
  name,
  size = "md",
  tone = "default",
  src,
  alt,
  fallbackAlt,
}: {
  /** Person display name whose leading character supplies the fallback initial. */
  name: string;
  /** Visual size step (`sm`, `md`, or `lg`). */
  size?: "sm" | "md" | "lg";
  /** Optional `accent` fill for the signed-in actor mark on the frame. */
  tone?: "default" | "accent";
  /** Validated photo URL when present. */
  src?: string;
  /** Accessible name for `src` when non-decorative. */
  alt?: string;
  /** Accessible name for the initial fallback when non-decorative. */
  fallbackAlt?: string;
}) {
  const url = safeMediaUrl(src);
  const dataTone = tone === "accent" ? "accent" : undefined;
  if (url) return <img className={s.avatar} data-size={size} data-tone={dataTone} src={url} alt={alt ?? ""} />;
  if (fallbackAlt) return <span className={s.avatar} data-size={size} data-tone={dataTone} role="img" aria-label={fallbackAlt}>{name.trim().slice(0, 1)}</span>;
  return <span className={s.avatar} data-size={size} data-tone={dataTone} aria-hidden>{name.trim().slice(0, 1)}</span>;
}
