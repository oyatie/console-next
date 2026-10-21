import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { AddressField, type AddressValue } from "./address-field";

export const order = 222;
const HITS = [{ key: "1111010100100010000030843", road: tg("addr.road"), jibun: tg("addr.jibun"), zip: "03154", building: tg("addr.building") }];

export default function AddressFieldGallery() {
  const [q, setQ] = useState("");
  const [v, setV] = useState<AddressValue | null>(null);
  const [chosen, setChosen] = useState<AddressValue | null>({ key: HITS[0]!.key, road: HITS[0]!.road, jibun: HITS[0]!.jibun, zip: "03154", detail: tg("addr.detail"), verified: true });
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.address")}</h2>
      <div className="grid-3">
        <AddressField label={tg("addr.label")} required value={v} onChange={setV} query={q} onQueryChange={setQ} hits={q.length >= 2 ? HITS : []} printed={tg("addr.printed")} />
        <AddressField label={tg("addr.label")} required value={chosen} onChange={setChosen} query="" onQueryChange={() => {}} hits={[]} />
        <AddressField label={tg("addr.label")} required value={null} onChange={() => {}} query="" onQueryChange={() => {}} hits={[]} problem="unavailable" />
      </div>
    </section>
  );
}
