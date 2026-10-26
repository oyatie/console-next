import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { TreeView } from "./tree";

export const order = 82;

type Node = { id: string; name: string; children: Node[] };
const leaf = (id: string, name: string, children: Node[] = []): Node => ({ id, name, children });

/** Expanded and collapsed branches, a leaf, a selected row. */
export default function Trees() {
  const roots = [
    leaf("c", tg("sample.company"), [
      leaf("s", tg("sample.site"), [leaf("d", tg("sample.dept"), [leaf("t1", tg("sample.team")), leaf("t2", tg("sample.teamLong"))])]),
      leaf("s2", tg("sample.site"), [leaf("d2", tg("sample.dept"))]),
    ]),
  ];
  const [expanded, setExpanded] = useState(new Set(["c", "s", "d"]));
  const [selected, setSelected] = useState<string | undefined>("t1");
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.tree")}</h2>
      <TreeView
        label={tg("tree.label")}
        roots={roots}
        childrenOf={(n) => n.children}
        textValue={(n) => n.name}
        row={(n) => <span className="grow">{n.name}</span>}
        selected={selected}
        onSelect={setSelected}
        expanded={expanded}
        onExpandedChange={setExpanded}
      />
      <TreeView
        label={tg("tree.label")}
        roots={[]}
        childrenOf={() => []}
        textValue={(n: Node) => n.name}
        row={(n: Node) => <span className="grow">{n.name}</span>}
        expanded={new Set()}
        onExpandedChange={() => undefined}
        onSelect={() => undefined}
      />
    </section>
  );
}
