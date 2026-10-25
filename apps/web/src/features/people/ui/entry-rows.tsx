import { useState } from "react";
import { t } from "@console/i18n";
import { Tag } from "../../../ui/record/record-section";
import { RecordRows, type RowColumn } from "../../../ui/record/rows";
import { ListAdd, RowActions } from "../../../ui/record-actions/record-actions";
import { addRecord, correctRecord, type RecordEntry } from "../api/record";
import { ROW_SPEC, fromFields, segmentOf, toFields, type Segment } from "../domain/record-spec";
import { tx } from "../present";
import { RecordHistory } from "./record-history";
import { RowEditor } from "./row-editor";
import type { Card } from "./use-card";
import { VoidBar } from "./void-bar";

/**
 * The personnel record's section entries (Form No.16: education, licences, military, languages, training, awards, family) with the record-actions grammar
 * (docs/design/record-actions.md §3): "{section} add" in the head, and on each row edit (a correction: the next version,
 * with why), the overflow menu history (every version) and void (struck in place; the server keeps no hard delete for an entry).
 */
export function useEntryRows(c: Card) {
  const [adding, setAdding] = useState<Segment | null>(null);
  const [editing, setEditing] = useState<RecordEntry | null>(null);
  const [voiding, setVoiding] = useState<RecordEntry | null>(null);
  const [history, setHistory] = useState<{ entry: RecordEntry; name: string } | null>(null);
  const entries = c.records.data?.items ?? [];
  const of = (sec: Segment) => entries.filter((x) => x.section === sec.toUpperCase());
  const path = c.setup ? "setup" : "correction";
  const add = (sec: Segment) => c.editable && <ListAdd object={tx(`empRec.${sec}`)} onAdd={() => (setEditing(null), setAdding(sec))} />;
  const actions = (x: RecordEntry, name: string) =>
    c.editable && (
      <RowActions
        field={name}
        onEdit={x.voided ? undefined : () => (setAdding(null), setEditing(x))}
        path={path}
        history={() => setHistory({ entry: x, name })}
        end={x.voided ? undefined : { verb: "void", onPress: () => setVoiding(x) }}
      />
    );
  const rows = (sec: Segment, cols: RowColumn<RecordEntry>[], name: (x: RecordEntry) => string) => {
    const list = of(sec);
    return list.length ? (
      <RecordRows label={t(`empRec.${sec}`)} rows={list} rowId={(x) => x.id} isVoid={(x) => x.voided} columns={[...cols, { end: true, cell: (x) => <>{x.voided && <Tag kind="void">{t("empRec.voided")}</Tag>}{actions(x, name(x))}</> }]} />
    ) : null;
  };
  const editor = (sec: Segment) => {
    const spec = ROW_SPEC[sec]!;
    if (adding === sec) return <RowEditor section={sec} spec={spec} reads="/api/v1/employees/{id}/records" path={path} onClose={() => setAdding(null)} onSave={(row, key) => addRecord(c.e.id, sec, toFields(spec, row), key)} />;
    if (editing && segmentOf(editing.section) === sec)
      return (
        <RowEditor
          key={editing.id}
          section={sec}
          spec={spec}
          reads="/api/v1/employees/{id}/records"
          path={path}
          initial={fromFields(spec, editing.fields)}
          onClose={() => setEditing(null)}
          onSave={(row, key, why) => correctRecord(c.e.id, sec, editing, toFields(spec, row), why ? tx(`empFix.reason.${why}`) : "", key)}
        />
      );
    return null;
  };
  const overlays = (
    <>
      {voiding && <VoidBar c={c} entry={voiding} onDone={() => setVoiding(null)} />}
      {history && <RecordHistory c={c} entry={history.entry} name={history.name} onClose={() => setHistory(null)} />}
    </>
  );
  return { of, add, rows, editor, overlays };
}
