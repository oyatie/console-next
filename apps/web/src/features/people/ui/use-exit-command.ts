import { useRef, useState } from "react";
import type { components } from "@console/api/schema";
import { useCommand } from "../../../lib/react/command";
import type { PathPrefix } from "../../../lib/query";
import { caseQuery, mySub, problemOf, unanswered } from "../api";
import { effectOf, type Effect } from "../domain/exits";

type Case = components["schemas"]["EmployeeExitCase"];
type Key = components["schemas"]["ExitCaseNextAction"]["key"];

/** Reads an exit step may change: the case and lists, the employee's status and history, unit headcounts. */
export const EXIT_INVALIDATES: readonly PathPrefix[] = ["/api/v1/hr/exit-cases", "/api/v1/employees", "/api/v1/org-units", "/api/v1/org-structure", "/api/v1/legal-entities", "/api/v1/workplaces", "/api/v1/employment-assignments"];

/**
 * After a lost response: `lost` waits for the user to look the record up; `elsewhere` found someone else's
 * record (the form turns read-only); `notRecorded` found nothing, so the form is open to send again.
 */
export type Phase = { kind: "idle" } | { kind: "lost" } | { kind: "elsewhere"; effect: Effect } | { kind: "notRecorded" };

/**
 * An exit step command whose response may be lost.
 *
 * `check: "resend"` is for a command with a request key (the report): looking it up sends it again under
 * the same key and the server replays what it recorded (useCommand keeps the key across a network error or
 * a 5xx and replaces it after a 4xx answer).
 *
 * Any other `check` names the step: these endpoints take no request key, so a resend after a lost
 * response is refused as an invalid transition even when the first click was recorded. Instead the
 * case is read again and compared (effectOf): recorded by me is success, by someone else is "done
 * elsewhere", and nothing means not recorded. A 409 invalid_transition is looked up the same way.
 */
export function useExitCommand<I>(opts: {
  caseId?: string;
  check: Key | "submit" | "resend";
  run: (input: I, key: string) => Promise<Case>;
  onSuccess: (out: Case, input: I) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const last = useRef<I | null>(null);
  const done = (out: Case, input: I) => {
    setPhase({ kind: "idle" });
    opts.onSuccess(out, input);
  };
  const cmd = useCommand({ run: opts.run, invalidates: EXIT_INVALIDATES, settle: true, onSuccess: done });
  const lookup = useCommand({
    run: () => caseQuery(opts.caseId!).queryFn(),
    invalidates: EXIT_INVALIDATES,
    settle: true,
    onSuccess: (now) => {
      if (opts.check === "resend") return;
      const e = effectOf(opts.check, now);
      if (!e) setPhase({ kind: "notRecorded" });
      else if (e.by && e.by === mySub()) done(now, last.current as I);
      else setPhase({ kind: "elsewhere", effect: e });
    },
  });
  const send = (input: I) =>
    cmd.mutate(input, {
      onError: (e) => {
        if (unanswered(e)) return setPhase({ kind: "lost" });
        const p = problemOf(e);
        setPhase({ kind: "idle" });
        if (opts.check !== "resend" && p?.status === 409 && p.code === "invalid_transition") lookup.mutate(undefined);
      },
    });
  const submit = (input: I) => {
    last.current = input;
    setPhase({ kind: "idle" });
    lookup.reset();
    send(input);
  };
  /** Look the lost request up: the same request again under its key, or a fresh read of the case. */
  const checkNow = () => (opts.check === "resend" ? send(last.current as I) : lookup.mutate(undefined));
  const checking = lookup.isPending || (opts.check === "resend" && phase.kind === "lost" && cmd.isPending);
  // A 409 that is being looked up, or that found someone else's record, is not shown as an error.
  const conflictHandled = phase.kind !== "idle" || lookup.isPending || lookup.isSuccess;
  return {
    submit,
    checkNow,
    phase,
    pending: cmd.isPending,
    checking,
    /** The form is read-only: sending, looking up, waiting to look up, or done by someone else. */
    locked: cmd.isPending || lookup.isPending || phase.kind === "lost" || phase.kind === "elsewhere",
    error: phase.kind === "lost" || conflictHandled ? null : cmd.error,
    lookupError: lookup.error,
  };
}

/** What the decision foot reads of a command (everything but how to send it). */
export type ExitCommand = Omit<ReturnType<typeof useExitCommand>, "submit">;

/** After a commit attempt with missing fields: focus the first one the form marks invalid (once it has rendered). */
export const focusFirstInvalid = (formId: string) =>
  requestAnimationFrame(() => document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]:not(:checked), [data-invalid] input:not(:checked)')?.focus());
