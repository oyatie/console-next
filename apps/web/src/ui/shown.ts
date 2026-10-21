import type { ReactNode } from "react";

/** Whether an optional slot has something to render: `cond && node` leaves false, "" or null behind, never a box. */
export const shown = (n: ReactNode) => n != null && n !== false && n !== "";
