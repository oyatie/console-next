import type { ReactNode } from "react";
import { Button } from "../button/button";
import s from "./record.module.css";

/**
 * A record's numbered strip (the employee register items 1-9 on a personnel card): one row of cells split by hairlines, each
 * a label over its value, each a press that jumps to its field. Three to a row on a narrow screen.
 */
export function Strip({ children }: { children: ReactNode }) {
  return <div className={s.strip}>{children}</div>;
}

export function StripItem({ label, children, onPress }: { label: ReactNode; children: ReactNode; onPress: () => void }) {
  return (
    <Button variant="ghost" className={s.stripItem} onClick={onPress}>
      <span className={s.stripLabel}>{label}</span>
      <span>{children}</span>
    </Button>
  );
}
