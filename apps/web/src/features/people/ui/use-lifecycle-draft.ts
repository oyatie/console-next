import { useEffect, useRef, useState } from "react";
import type { Seniority, Settle } from "../../../reference/group-transfer/domain/facts";

/** What a lifecycle sheet holds before it is recorded. */
export type Draft = {
  date: string;
  unit: string;
  position: string;
  leaveType: string | null;
  returnDate: string;
  endDate: string;
  exceptionId?: string;
  comment: string;
  acks: Record<string, boolean>;
  /** BW-07 reason code of a transfer or promotion (the comment is its note). */
  reasonCode: string | null;
  /** BW-13 catalog title of a promotion (empty: typed position). */
  titleId: string;
  gradeId: string;
  /** The lifecycle_cancel reason of a replacement, correction or rescission, and its note. */
  voidCode: string | null;
  voidNote: string;
  /** APPOINT (MR-25): the role after (a catalog id, or "vacate" to hold none), the job and job family after. */
  roleId: string;
  jobId: string;
  familyId: string;
  /** EMPLOYMENT_TYPE_CHANGE (MR-24): the type after. */
  toType: string | null;
  /** GROUP_TRANSFER (group transfer): the receiving workplace (the unit's), each continuity choice (no default) and the consent's facts. */
  workplaceId: string;
  severance: Settle | null;
  annualLeave: Settle | null;
  seniority: Seniority | null;
  consentDate: string;
  consentRef: string;
  successionRef: string;
  groupStart: string;
};
export const EMPTY: Draft = { date: "", unit: "", position: "", leaveType: null, returnDate: "", endDate: "", comment: "", acks: {}, reasonCode: null, titleId: "", gradeId: "", voidCode: null, voidNote: "", roleId: "", jobId: "", familyId: "", toType: null, workplaceId: "", severance: null, annualLeave: null, seniority: null, consentDate: "", consentRef: "", successionRef: "", groupStart: "" };

// One draft per (employee, act) for this page session, so a sheet closed by Back, by a refusal's
// "cancel that reservation" detour or by a re-render keeps what was typed (challenge C3, C11). Never stored: a reload drops it.
// unbounded for the session; a handful of entries per admin, prune if that ever matters.
const drafts = new Map<string, Draft>();
const keyOf = (employeeId: string, act: string) => `${employeeId}:${act}`;

/**
 * The sheet's form state, restored from this session's draft when there is one (`restored` says so),
 * else from `initial` (values carried from a recorded event). `clear` forgets it; `done` after a
 * recorded command.
 */
export function useDraft(employeeId: string, act: string, initial: Partial<Draft>) {
  const key = keyOf(employeeId, act);
  const [saved] = useState(() => drafts.get(key));
  const [draft, setDraft] = useState<Draft>(() => saved ?? { ...EMPTY, ...initial });
  const [restored, setRestored] = useState(Boolean(saved));
  // Only what the user changed is kept: opening and closing a sheet leaves no draft behind.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) drafts.set(key, draft);
  }, [key, draft]);
  return {
    draft,
    set: (patch: Partial<Draft>) => {
      touched.current = true;
      setDraft((d) => ({ ...d, ...patch }));
    },
    restored,
    clear: () => {
      touched.current = false;
      drafts.delete(key);
      setRestored(false);
      setDraft({ ...EMPTY, ...initial });
    },
    done: () => void drafts.delete(key),
  };
}
