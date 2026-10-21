import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { DockSheet } from "./dock-sheet";
import s from "./dock-sheet.gallery.module.css";

export const order = 219;

/** A docked sheet beside the view it works on: the view stays usable while it is open. */
export default function DockSheetGallery() {
  const [open, setOpen] = useState(true);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.dockSheet")}</h2>
      <div className={s.split}>
        <div>
          <Button onClick={() => setOpen(true)}>{tg("dockSheet.open")}</Button>
        </div>
        <DockSheet
          open={open}
          kicker={tg("sample.company")}
          title={tg("dockSheet.title")}
          onClose={() => setOpen(false)}
          consequence={<span>{tg("dockSheet.consequence")}</span>}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>{t("common.back")}</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>{tg("dockSheet.commit")}</Button>
            </>
          }
        >
          <p>{tg("dockSheet.body")}</p>
        </DockSheet>
      </div>
    </section>
  );
}
