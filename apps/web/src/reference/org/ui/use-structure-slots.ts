import { createContext, useContext, type ReactNode } from "react";
import type { Located, Place, StructureAct } from "../domain/structure";

/** What a workplace panel gets from the company structure page: its place, and how to close it or open an act. */
export type WorkplacePanelProps = { place: Place; tenant: string; setup: boolean; onClose: () => void; onAct: (act: StructureAct) => void };
/** What a workplace sheet gets: its act, the selection it applies to, and how to leave it. */
export type WorkplaceSheetProps = { act: StructureAct; at: NonNullable<Located>; setup: boolean; onClose: () => void; onSelect: (id?: string) => void; onAct: (act: StructureAct) => void };
export type StructureSlotsValue = { workplacePanel: (p: WorkplacePanelProps) => ReactNode; workplaceSheet: (p: WorkplaceSheetProps) => ReactNode };

/**
 * The workplace panel and sheets come from the entity slice and the department ones from the org slice; the
 * route composes them (routes/org-screen.tsx), so neither slice imports the other.
 */
export const StructureSlots = createContext<StructureSlotsValue | null>(null);
export const useStructureSlots = () => useContext(StructureSlots);
