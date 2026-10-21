import { ArrowUp, Ellipsis, X } from "lucide-react";
import { tg } from "@console/i18n/gallery";
import { Button, IconButton } from "./button";

export const order = 81;

/** The small size (a row's verbs, a panel's tools) beside the default, and icon-only buttons with their names. */
export default function ButtonSizes() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.buttonSizes")}</h2>
      <div className="row">
        <Button size="sm" variant="ghost">{tg("buttonSize.sm")}</Button>
        <Button size="sm">{tg("buttonSize.sm")}</Button>
        <Button size="sm" variant="primary">{tg("buttonSize.smPrimary")}</Button>
        <Button size="sm" disabled>{tg("buttonSize.smPrimary")}</Button>
        <IconButton label={tg("buttonSize.close")}><X size={16} aria-hidden /></IconButton>
        <IconButton label={tg("buttonSize.more")} variant="secondary"><Ellipsis size={16} aria-hidden /></IconButton>
        <IconButton label={tg("buttonSize.up")} size="sm"><ArrowUp size={14} aria-hidden /></IconButton>
      </div>
    </section>
  );
}
