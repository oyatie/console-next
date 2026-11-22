import type { EntityDocument } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { OpenOriginal } from "./open-original";

/** The entity's evidence (design §4.1): each document, when it was issued and uploaded, and until when it is kept. */
export function DocumentsTab({ docs, flat }: { docs: EntityDocument[]; flat?: boolean }) {
  if (docs.length === 0) return <section className={flat ? undefined : "card"}><EmptyState title={t("entity.docs.empty.title")} reason={t("entity.docs.empty.reason")} /></section>;
  return (
    <section className={flat ? undefined : "card"}>
      <Table
        label={t("entity.docs.table")}
        rows={docs}
        rowId={(x) => x.id}
        mobileLayout={flat ? "compact" : undefined}
        columns={[
          { header: t("entity.docs.col.kind"), card: flat ? "fact" : undefined, cell: (x) => t(`entity.docs.kind.${x.kind}`), fit: true },
          { header: t("entity.docs.col.file"), card: flat ? "title" : undefined, cell: (x) => x.file_name },
          { header: t("entity.docs.col.issued"), wide: flat ? true : undefined, cell: (x) => <span className="num">{x.issued_on ? fmtDate(x.issued_on) : t("entityOps.info.none")}</span>, fit: true },
          { header: t("entity.docs.col.uploaded"), cell: (x) => <span className="num">{fmtDateTime(x.uploaded_at)}</span>, fit: true, wide: true },
          { header: t("capture.docs.col.original"), card: flat ? "action" : undefined, cell: (x) => <OpenOriginal doc={x} />, fit: true },
          { header: t("entity.docs.col.retain"), card: flat ? "status" : undefined, cell: (x) => (x.retain_until ? <span className="num">{fmtDate(x.retain_until)}</span> : <Chip tone="info">{t("entity.docs.inUse")}</Chip>), fit: true },
        ]}
      />
    </section>
  );
}
