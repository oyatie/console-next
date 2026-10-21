import { tg } from "@console/i18n/gallery";
import { BlockedPanel } from "./blocked-panel";

export const order = 130;

export default function BlockerGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.blocker")}</h2>
      <BlockedPanel
        kind="lock"
        title={tg("blocker.lockTitle")}
        code="effective_date_locked"
        ability={tg("blocker.lockAbility")}
        unblockers={[{ name: tg("blocker.finance"), role: tg("blocker.financeRole") }, { name: tg("blocker.exec"), role: tg("blocker.execRole") }]}
        actions={
          <>
            <button type="button" className="btn">{tg("blocker.changeDate")}</button>
            <button type="button" className="btn btn--primary">{tg("blocker.askBackdate")}</button>
          </>
        }
      >
        {tg("blocker.lockBody")}
      </BlockedPanel>
      <BlockedPanel
        kind="route"
        title={tg("blocker.routeTitle")}
        code="approval_route_incomplete"
        ability={tg("blocker.routeAbility")}
        unblockers={[{ name: tg("blocker.ceo"), role: tg("blocker.ceoRole") }]}
        actions={
          <>
            <button type="button" className="btn btn--primary">{tg("blocker.askRoute")}</button>
            <button type="button" className="btn">{tg("form.saveDraft")}</button>
          </>
        }
      >
        {tg("blocker.routeBody")}
      </BlockedPanel>
    </section>
  );
}
