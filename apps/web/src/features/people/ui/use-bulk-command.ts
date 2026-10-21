import { useRef, useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { ORG_READS } from "../../../reference/org/api";
import { failureOf, type BulkRequest } from "../api";
import { commitChangeSet, openChangeSet, syncLines } from "../api";
import { linesOf } from "../domain/bulk-lines";
import { NO_ACKS } from "./use-lifecycle-command";

export type Recorded = { ids: string[]; count: number; scheduled: boolean; batchId: string };
export type Refusal = { code: string; message: string };


/**
 * Records a bulk transfer or promotion through the caller's change set (BW-38): the server-side draft holds one line
 * per person (redrafting keeps the version each was first drafted against), and the commit records every line as
 * one batch, all or nothing, under one key per exact draft (a lost response is asked again and replays the record).
 * A person changed since drafting refuses the set (`stale_record`), one the rules refuse refuses it too
 * (`bulk_lifecycle_refused`); both name the people, and `repin` redrafts the changed ones against their record now.
 */
export function useBulkCommand(onAllDone: (recorded: Recorded[]) => void) {
  const keys = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState<Recorded[]>([]);
  const [refused, setRefused] = useState<ReadonlyMap<string, Refusal>>(new Map());
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set());
  const [lost, setLost] = useState(false);
  const run = useCommand({
    run: async ({ batches, repin }: { batches: BulkRequest[]; repin: ReadonlySet<string> }) => {
      const set = await openChangeSet(batches[0]!.event_type as "TRANSFER" | "PROMOTE");
      await syncLines(set, linesOf(batches), repin);
      // No lifecycle act needs an acknowledgement (BW-11 A13); the commit body still carries the four, unset.
      const signoffs = NO_ACKS;
      const payload = JSON.stringify([set.id, linesOf(batches), signoffs]);
      let key = keys.current.get(payload);
      if (!key) keys.current.set(payload, (key = crypto.randomUUID()));
      return commitChangeSet(set.id, signoffs, key);
    },
    // Unit members and headcounts change with a transfer, and so does a dissolution's preflight.
    invalidates: ["/api/v1/employees", "/api/v1/change-sets", ...ORG_READS],
  });
  const send = async (batches: BulkRequest[], repin: ReadonlySet<string> = new Set()) => {
    if (batches.length === 0) return;
    setBusy(true);
    setRefused(new Map());
    setStale(new Set());
    setLost(false);
    try {
      const r = await run.mutateAsync({ batches, repin });
      const done = [{ ids: batches.flatMap((b) => b.employee_ids ?? []), count: r.items.length, scheduled: r.items[0]?.state === "SCHEDULED", batchId: r.batch_id }];
      setRecorded(done);
      onAllDone(done);
    } catch (e) {
      const f = failureOf(e);
      if (f.kind === "refused" && f.code === "stale_record") {
        // The refusal names each changed line by its person; it carries no per-line words.
        setRefused(new Map(f.refusals.map((x) => [x.employee_id, { code: f.code, message: t("bulk.stale.row") }])));
        setStale(new Set(f.refusals.map((x) => x.employee_id)));
      } else if (f.kind === "refused") setRefused(new Map(f.refusals.map((x) => [x.employee_id, x])));
      setLost(f.kind === "lost");
    } finally {
      setBusy(false);
    }
  };
  const failure = run.error ? failureOf(run.error) : null;
  return {
    send,
    busy,
    recorded,
    recordedIds: new Set(recorded.flatMap((r) => r.ids)),
    refused,
    /** People who changed since their line was drafted (re-check them, then `send` with them as `repin`). */
    stale,
    lost,
    /** A refusal the screen has no per-person answer for (validation, a dissolved unit): shown with its request id. */
    error: failure?.kind === "answered" && !busy ? run.error : null,
  };
}
