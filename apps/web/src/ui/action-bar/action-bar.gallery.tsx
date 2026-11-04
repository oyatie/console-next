import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { DisabledReason } from "../disabled-reason/disabled-reason";
import { ActionBar } from "./action-bar";

export const order = 153;

/** The consequence in numbers above the actions, the primary last; `sticky` pins full-page commits to the viewport bottom. */
export default function ActionBarGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.actionBar")}</h2>
      <ActionBar
        consequence={tg("actionBar.consequence")}
        actions={<><Button>{tg("actionBar.cancel")}</Button><Button variant="primary">{tg("actionBar.commit")}</Button></>}
      />
      <ActionBar
        sticky
        consequence={tg("actionBar.consequence")}
        actions={<><Button>{tg("actionBar.cancel")}</Button><DisabledReason reason={tg("disabledReason.effectuateWhy")} control={p => <Button variant="primary" {...p}>{tg("actionBar.commit")}</Button>} /></>}
      />
    </section>
  );
}
