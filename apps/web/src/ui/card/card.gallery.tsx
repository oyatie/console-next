import { Plus } from "lucide-react";
import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { Card } from "./card";
import { SectionHead } from "./section-head";

export const order = 128;

/** A titled card with its count and tool, a section head with its tool inside it, and an untitled surface. */
export default function CardGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.card")}</h2>
      <Card title={tg("card.title")} meta={tg("card.count")} tools={<Button size="sm"><Plus size={14} aria-hidden />{tg("card.add")}</Button>}>
        <SectionHead tools={<Button size="sm" variant="ghost">{tg("card.sectionEdit")}</Button>}>{tg("card.section")}</SectionHead>
        <span>{tg("card.body")}</span>
      </Card>
      <Card><span className="muted">{tg("card.plain")}</span></Card>
    </section>
  );
}
