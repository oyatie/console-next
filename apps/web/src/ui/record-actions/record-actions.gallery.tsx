import { tg } from "@console/i18n/gallery";
import { ListAdd, PathNote, RowActions } from "./record-actions";

export const order = 223;

/** A row's edit and overflow (history, end verb), a list's add, a blocked edit with its reason, and each path line. */
export default function RecordActionsGallery() {
  const none = () => {};
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.recordActions")}</h2>
      <RowActions field={tg("recordActions.field")} onEdit={none} path="revision" history={none} end={{ verb: "clear", onPress: none }} />
      <ListAdd object={tg("recordActions.list")} onAdd={none} />
      <RowActions field={tg("recordActions.field")} onEdit={none} why={tg("recordActions.why")} history={none} />
      {(["setup", "revision", "correction", "approval", "second", "stepUp"] as const).map((p) => <div key={p}><PathNote path={p} /></div>)}
    </section>
  );
}
