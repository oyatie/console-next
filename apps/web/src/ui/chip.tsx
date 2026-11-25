import type { ReactNode } from "react";
import { useActiveExperienceId } from "../experience/dom";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "outline" | "accent";
export const Chip = ({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) => (
  <span className={[`chip chip--${tone}`, className].filter(Boolean).join(" ")}>{children}</span>
);

/** The viewer's turn on a document: the tinted accent tag in the Console style, the info tag in every other style. */
export function TurnChip({ children }: { children: ReactNode }) {
  return <Chip tone={useActiveExperienceId() === "console" ? "accent" : "info"}>{children}</Chip>;
}
