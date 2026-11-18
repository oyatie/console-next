// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useDirtyEscape } from "../lib/react/dirty-escape";
import { PanelShell } from "../reference/org/ui/panel-shell";
import { ActionGrid } from "./action-grid/action-grid";
import { ApprovalCard } from "./approval-card/approval-card";
import { TextInput } from "./field/field";
import { TextArea } from "./field/text-area";
import { MaskedField } from "./masked-field/masked-field";
import { KeyMap } from "./palette/key-map";
import { Palette } from "./palette/palette";
import { PersonDayGrid } from "./person-day-grid/person-day-grid";
import { ReasonField } from "./reason/reason-field";
import { Sheet } from "./sheet/sheet";
import "../app.css";

const ROWS = [{ id: "a", name: "Yoon Hajun" }];
const which = new URLSearchParams(location.search).get("case") ?? "";
const escapeOrTab = (e: { key: string }) => e.key === "Escape" || e.key === "Tab";
/** A handler that adds its name to `#heard` when an Escape or Tab reaches it. */
const hear = (who: string) => (e: { key: string }) => {
  if (escapeOrTab(e)) document.getElementById("heard")!.textContent += ` ${who}`;
};

/**
 * A text-entry primitive with everything that may act on its Escape and Tab: the caller's handler (it clears on
 * Escape and marks on Tab, like a find box and an outline), a handler above, a native listener above and one on the
 * window. `#heard` lists who heard the key, in order.
 */
function Entry() {
  const [text, setText] = useState("ab");
  const [digits, setDigits] = useState("12");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current!.addEventListener("keydown", hear("native"));
    window.addEventListener("keydown", hear("window"));
  }, []);
  const keys = (e: ReactKeyboardEvent) => {
    hear("caller")(e);
    if (e.key === "Escape") setText("");
    else if (e.key === "Tab") {
      e.preventDefault();
      setText(v => `${v}>`);
    }
  };
  return (
    <main>
      <div ref={box} role="presentation" onKeyDown={hear("above")}>
        {which === "field" && <TextInput aria-label="Name" value={text} onChange={e => setText(e.target.value)} onKeyDown={keys} />}
        {which === "area" && <TextArea aria-label="Name" value={text} onChange={e => setText(e.target.value)} onKeyDown={keys} />}
        {which === "masked" && <MaskedField label="Name" required format={{ max: 10, display: d => d }} value={digits} onChange={setDigits} />}
        {which === "reason" && <ReasonField label="Why" codes={[]} other="other" value={{ code: null, memo: text }} onChange={r => setText(r.memo)} memoMax={100} />}
      </div>
      <button type="button">Next</button>
      <output id="heard" />
    </main>
  );
}

/** One listener that closes on Escape, with a bare input in its reach: the listener's own check is what is tested. */
function Site() {
  const [closed, setClosed] = useState(0);
  const close = () => setClosed(n => n + 1);
  const { ref, armed } = useDirtyEscape<HTMLDivElement>(true, close);
  const raw = <input aria-label="Raw" />;
  const sites: Record<string, ReactNode> = {
    sheet: <Sheet open title="Note" onClose={close} dirty consequence="" actions={null}>{raw}</Sheet>,
    dirty: <div ref={ref}>{raw}</div>,
    panel: <PanelShell crumb={["Org"]} icon={null} title="Unit" anchors={[]} onClose={close}>{raw}</PanelShell>,
    card: <ApprovalCard eyebrow="Change" step="My step" title="Dissolve" consequence="Approves" rejectConsequence="Rejects" approveLabel="Approve it" rejectLabel="Reject it"
      reason={() => raw} reasonComplete={false} onApprove={close} onReject={close}>Body</ApprovalCard>,
    actions: <><ActionGrid label="Acts" head="Acts" groups={[{ title: "Group", items: [{ id: "act", icon: null, title: "Act", desc: "Does it" }] }]} onPick={close} onClose={close} />{raw}</>,
    keymap: <KeyMap open onClose={close} title="Keys" groups={[{ id: "g", title: "Group", keys: [{ keys: ["J"], what: "Next row" }] }]} filter={{ label: "Filter" }} />,
  };
  return <>{sites[which]}<output id="closed">{closed}</output><output id="armed">{String(armed)}</output></>;
}

/** One text-entry handler per page (`?case=`): the palette and the sheet are modal, so the cases cannot share a document. */
export function Fixture() {
  const [acted, setActed] = useState(0);
  const [committed, setCommitted] = useState(0);
  const [closed, setClosed] = useState(0);
  const [above, setAbove] = useState(0);
  const [value, setValue] = useState<string | null>("8");
  if (which === "palette") return (
    <Palette
      open
      onClose={() => setClosed(n => n + 1)}
      label="Find a person"
      query="yoon"
      onQuery={() => undefined}
      placeholder="Name"
      sections={[{ id: "people", title: "People", items: [{ id: "p1", text: "Yoon Hajun", title: "Yoon Hajun" }] }]}
      onAction={() => setActed(n => n + 1)}
      foot={<><output id="acted">{acted}</output><output id="closed">{closed}</output></>}
    />
  );
  if (which !== "grid") return ["field", "area", "masked", "reason"].includes(which) ? <Entry /> : <Site />;
  return (
    <main>
      <div role="presentation" onKeyDown={e => escapeOrTab(e) && setAbove(n => n + 1)}>
      <PersonDayGrid
        label="October"
        total={1}
        rows={ROWS}
        rowKey={r => r.id}
        lead={[{ key: "n", header: "Name", cell: r => r.name, width: "name" }]}
        days={[{ key: "1", label: 1, sub: "" }]}
        tail={[]}
        cell={() => "8"}
        look={() => undefined}
        describe={r => `${r.name} day 1`}
        range={{ anchor: { row: "a", col: "1" }, focus: { row: "a", col: "1" } }}
        onRange={() => undefined}
        editing={value === null ? null : { value, cell: { row: "a", col: "1" } }}
        onEdit={setValue}
        onCommit={() => setCommitted(n => n + 1)}
        onKey={() => false}
        rowHeight={32}
      />
      </div>
      <output id="committed">{committed}</output>
      <output id="open">{value === null ? "closed" : "open"}</output>
      <output id="above">{above}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
