import { useState } from "react";
import { parseColumns, type ColumnId } from "../domain/columns";

const KEY = "console.roster.columns";
const DENSITY = "console.roster.density";
export type Density = "compact" | "regular";

/** The viewer's column choice, kept on this device only (a per-viewer convenience; the view store is not served). */
export function useRosterColumns() {
  const [shown, setShown] = useState<ColumnId[]>(() => {
    try {
      return parseColumns(localStorage.getItem(KEY));
    } catch {
      return parseColumns(null);
    }
  });
  const set = (next: ColumnId[]) => {
    setShown(next);
    try {
      localStorage.setItem(KEY, next.join(","));
    } catch {
      // Storage refused (private window): the choice lasts for this page only.
    }
  };
  const [density, setDensity] = useState<Density>(() => {
    try {
      return localStorage.getItem(DENSITY) === "regular" ? "regular" : "compact";
    } catch {
      return "compact";
    }
  });
  const changeDensity = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem(DENSITY, d);
    } catch {
      // Storage refused: this page only.
    }
  };
  return { shown, set, density, setDensity: changeDensity };
}
