import s from "./avatar.module.css";
import { safeMediaUrl } from "../../lib/media-url";

/**
 * A person's initial in a circle (kit .avatar / .mlist .av): decorative, the name beside it says who. `sm` (22) in
 * lists and rows, `md` (32) at the head of a sheet or page, `lg` (64, a rounded square) at the head of a person's
 * record, where `src` shows their photo; `alt` names the photo and `fallbackAlt` names its absence.
 */
export function Avatar({ name, size = "md", src, alt, fallbackAlt }: { name: string; size?: "sm" | "md" | "lg"; src?: string; alt?: string; fallbackAlt?: string }) {
  const url = safeMediaUrl(src);
  if (url) return <img className={s.avatar} data-size={size} src={url} alt={alt ?? ""} />;
  if (fallbackAlt) return <span className={s.avatar} data-size={size} role="img" aria-label={fallbackAlt}>{name.trim().slice(0, 1)}</span>;
  return <span className={s.avatar} data-size={size} aria-hidden>{name.trim().slice(0, 1)}</span>;
}
