import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { KeyValue, StatRow } from "./key-value";

export const order = 129;

/** Facts with one verb each (and one without), then a count row. */
export default function KeyValueGallery() {
  const fix = (field: string) => <Button size="sm" variant="ghost" aria-label={`${field} ${tg("facts.fix")}`}>{tg("facts.fix")}</Button>;
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.facts")}</h2>
      <KeyValue
        label={tg("facts.label")}
        items={[
          { key: "name", label: tg("facts.name"), value: tg("facts.nameValue"), action: fix(tg("facts.name")) },
          { key: "rep", label: tg("facts.rep"), value: tg("facts.repValue"), action: fix(tg("facts.rep")) },
          { key: "open", label: tg("facts.open"), value: <span className="num">{tg("facts.openValue")}</span> },
        ]}
      />
      <StatRow
        label={tg("facts.stats")}
        items={[
          { key: "active", label: tg("facts.active"), value: "1,213" },
          { key: "leave", label: tg("facts.leave"), value: "23" },
          { key: "joining", label: tg("facts.joining"), value: "16" },
          { key: "total", label: tg("facts.total"), value: "1,236" },
        ]}
      />
    </section>
  );
}
