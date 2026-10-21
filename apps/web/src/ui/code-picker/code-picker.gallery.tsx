import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { CodePicker } from "./code-picker";

export const order = 221;
const POOL = [
  { code: "62010", label: tg("code.software"), context: tg("code.softwareGroup") },
  { code: "62021", label: tg("code.si"), context: tg("code.softwareGroup") },
];

export default function CodePickerGallery() {
  const [q, setQ] = useState("");
  const [code, setCode] = useState<string | null>(null);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.codePicker")}</h2>
      <div className="grid-3">
        <CodePicker label={tg("code.ksic")} required list={{ title: tg("code.ksicList"), version: tg("code.ksicVersion"), loaded: true }} query={q} onQueryChange={setQ} options={POOL.filter((o) => q && `${o.code} ${o.label}`.includes(q))} value={code} onChange={setCode} />
        <CodePicker label={tg("code.taxOffice")} required list={{ title: tg("code.taxOfficeList"), loaded: false }} query="" onQueryChange={() => {}} options={[]} value={null} onChange={() => {}} fallback={<span>{tg("code.printed")}</span>} />
      </div>
    </section>
  );
}
