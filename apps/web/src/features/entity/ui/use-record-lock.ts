import { createContext, useContext } from "react";
import type { LegalEntity } from "@console/api/pending";

/** Why the record offers no edit verbs: a historical view, a closed record, or a grant that does not reach it. */
export type RecordLock = "asof" | "closed" | "reach" | null;
export const lockOf = (e: LegalEntity): RecordLock => (e.read_only ? "asof" : e.closed_on ? "closed" : !e.can_manage ? "reach" : null);

const LockContext = createContext<RecordLock>(null);
export const RecordLockProvider = LockContext.Provider;
/** Inside a locked record every fact row drops its verb (FactRow reads this). */
export const useRecordLock = () => useContext(LockContext);

