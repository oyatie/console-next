import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ServerPicker, type PickerEscape, type PickerOption } from "./server-picker";

export const order = 217;

const person = (n: number, code: string, unit = tg("sample.team")): PickerOption => ({ id: code, name: tg("sample.person", { n }), code, status: t("enum.employeeStatus.ACTIVE"), context: unit });
const POOL = [person(1, "HK-0112"), person(12, "HK-0187", tg("sample.dept")), person(5, "HK-0045"), person(5, "HK-0203", tg("sample.dept"))];

/** The caller's server search, stood in by filtering a fixed pool. */
function Sample({ initial, escape }: { initial: string; escape?: PickerEscape }) {
  const [q, setQ] = useState(initial);
  const [value, setValue] = useState<string | null>(null);
  const options = POOL.filter((o) => q.trim() !== "" && `${o.name} ${o.code}`.includes(q.trim()));
  return (
    <ServerPicker
      label={tg("col.name")}
      group={tg("col.name")}
      query={q}
      onQueryChange={setQ}
      options={options}
      value={value}
      onChange={setValue}
      empty={tg("empty.reason")}
      escape={escape}
      isRequired
    />
  );
}

export default function ServerPickers() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiServerPicker.name")}</h2>
      <div className="grid-3">
        <Sample initial={tg("sample.person", { n: 1 })} />
        <Sample initial={tg("sample.person", { n: 5 })} />
        <Sample initial={tg("sample.position")} escape={{ kind: "add", note: tg("sample.company"), onAdd: () => {} }} />
        <Sample initial={tg("sample.site")} escape={{ kind: "request", note: tg("sample.dept"), onRequest: () => {} }} />
      </div>
    </section>
  );
}
