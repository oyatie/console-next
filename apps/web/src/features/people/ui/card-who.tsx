import { UserRound } from "lucide-react";
import type { Card } from "./use-card";

/** Whose record a sheet acts on, above its title (E4/E9 sheets): name · number · workplace › unit. */
export function Who({ c }: { c: Card }) {
  const where = [c.place.workplace, c.place.path.at(-1)].filter(Boolean).join(" › ");
  return <><UserRound size={13} aria-hidden /> {[c.e.name, c.e.employee_number, where].filter(Boolean).join(" · ")}</>;
}
