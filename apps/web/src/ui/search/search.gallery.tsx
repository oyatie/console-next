import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { Avatar } from "../avatar/avatar";
import { SearchField } from "./search-field";

export const order = 154;

/** The find box, empty and typed; avatars at both sizes. */
export default function SearchGallery() {
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState(tg("search.typed"));
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.search")}</h2>
      <SearchField label={tg("search.label")} value={q} onChange={setQ} />
      <SearchField label={tg("search.label")} value={typed} onChange={setTyped} />
      <div className="row">
        <Avatar name={tg("search.person")} />
        <span>{tg("search.person")}</span>
        <Avatar name={tg("search.person")} size="sm" />
      </div>
    </section>
  );
}
