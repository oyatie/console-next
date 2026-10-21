import s from "./avatar.module.css";

/**
 * A person's initial in a circle (kit .avatar / .mlist .av): decorative, the name beside it says who. `sm` (22) in
 * lists and rows, `md` (32) at the head of a sheet or page, `lg` (64, a rounded square) at the head of a person's
 * record, where `src` shows their photo instead of the initial; `alt` names the photo, or its absence.
 */
export function Avatar({ name, size = "md", src, alt }: { name: string; size?: "sm" | "md" | "lg"; src?: string; alt?: string }) {
  if (src) return <img className={s.avatar} data-size={size} src={src} alt={alt ?? ""} />;
  // With `alt` the initial stands for a missing photo and is named ("no photo"); without it, it is decoration.
  if (alt) return <span className={s.avatar} data-size={size} role="img" aria-label={alt}>{name.trim().slice(0, 1)}</span>;
  return <span className={s.avatar} data-size={size} aria-hidden>{name.trim().slice(0, 1)}</span>;
}
