import type { ReactNode } from "react";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";
export const Chip = ({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) => (
  <span className={[`chip chip--${tone}`, className].filter(Boolean).join(" ")}>{children}</span>
);
