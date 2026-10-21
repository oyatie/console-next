import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { entityHistoryQuery, registrationHistoryQuery } from "../api";
import { RevisionItems } from "./history-tab";
import s from "./record.module.css";

/**
 * A save refused as stale (409 stale_revision, spec S11-conflict-field): what was recorded since the version this sheet
 * read, the value the user typed, and the two ways on: apply it on top of the change, or drop it. Nothing is
 * re-sent on its own; reapplying only moves the sheet onto the newest read so the next save is checked against it.
 */
export function Conflict({ entityId, owner, read, subject, mine, fresh, onReapply, onDrop }: {
  entityId: string;
  owner: { kind: "entity"; id: string } | { kind: "registration"; id: string };
  /** The newest version the sheet read: entries above it were recorded meanwhile. */
  read: number;
  subject: string;
  mine: string;
  /** The record has been read again since the refusal. */
  fresh: boolean;
  onReapply: () => void;
  onDrop: () => void;
}) {
  const entity = useQuery({ ...entityHistoryQuery(owner.id), retry: false, enabled: owner.kind === "entity" });
  const cert = useQuery({ ...registrationHistoryQuery(owner.id), retry: false, enabled: owner.kind === "registration" });
  const since = ((owner.kind === "entity" ? entity.data : cert.data)?.items ?? []).filter((r) => r.version > read);
  return (
    <section className={s.conflict} aria-labelledby="conflict-title">
      <h3 id="conflict-title" className={s.subhead}>{t("entityRecord.conflict.title")}</h3>
      <p><b>{t("entityRecord.conflict.mine", { value: mine })}</b></p>
      <div className="row">
        <Button aria-disabled={!fresh || undefined} aria-describedby={fresh ? undefined : "conflict-wait"} onClick={() => fresh && onReapply()}>{t("entityRecord.conflict.reapply")}</Button>
        <Button variant="ghost" onClick={onDrop}>{t("entityRecord.conflict.keep")}</Button>
      </div>
      {!fresh && <p className="muted" role="status" id="conflict-wait">{t("entityRecord.conflict.loading")}</p>}
      {since.length > 0 && <RevisionItems items={since} subject={subject} target={{ id: entityId }} />}
    </section>
  );
}
