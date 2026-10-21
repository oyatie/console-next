import { Check, CircleAlert, TriangleAlert } from "lucide-react";
import { tg } from "@console/i18n/gallery";
import { Avatar } from "../avatar/avatar";
import { Legend } from "../legend/legend";
import { Skeleton } from "../skeleton/skeleton";
import { ItemList } from "./item-list";

export const order = 155;

/** A short checklist in each tone, a people list, the change-mark legend, and the loading skeleton. */
export default function ItemListGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.itemList")}</h2>
      <ItemList
        label={tg("itemList.checks")}
        items={[
          { key: "a", tone: "ok", mark: <Check size={14} aria-hidden />, text: tg("itemList.ok"), end: "1/1" },
          { key: "b", tone: "warn", mark: <TriangleAlert size={14} aria-hidden />, text: tg("itemList.warn"), end: "0/1" },
          { key: "c", tone: "danger", mark: <CircleAlert size={14} aria-hidden />, text: tg("itemList.danger") },
        ]}
      />
      <ItemList label={tg("itemList.people")} items={[{ key: "p", mark: <Avatar name={tg("search.person")} size="sm" />, text: tg("search.person"), end: "10587" }]} />
      <Legend label={tg("itemList.legend")} items={[{ swatch: "new", text: tg("legend.new") }, { swatch: "mov", text: tg("legend.mov") }, { swatch: "chg", text: tg("legend.chg") }, { swatch: "gone", text: tg("legend.gone") }]} />
      <Skeleton label={tg("itemList.loading")} bones={["title", "line", "row"]} />
    </section>
  );
}
