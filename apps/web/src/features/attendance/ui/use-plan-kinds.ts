// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo } from "react";
import { cellKey } from "../domain/grid";

type Row = { employee_id: string } & (
  { cells: readonly { plan_kind: string }[] } | { day: { plan: { kind: string } } }
);

/** Live plans indexed once per payload, shared by draft validation and the save dock. */
export function usePlanKinds(rows: readonly Row[], dates: readonly string[] | string) {
  return useMemo(() => {
    const kinds = new Map<string, string>();
    for (const row of rows) {
      if (typeof dates === "string" && "day" in row) {
        kinds.set(cellKey(row.employee_id, dates), row.day.plan.kind);
      } else if (typeof dates !== "string" && "cells" in row) {
        row.cells.forEach((cell, i) => {
          const date = dates[i];
          if (date !== undefined) kinds.set(cellKey(row.employee_id, date), cell.plan_kind);
        });
      }
    }
    return (key: string) => kinds.get(key);
  }, [rows, dates]);
}
