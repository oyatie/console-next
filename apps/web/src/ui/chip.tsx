import type { ReactNode } from "react";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";
export const Chip = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`chip chip--${tone}`}>{children}</span>
);
