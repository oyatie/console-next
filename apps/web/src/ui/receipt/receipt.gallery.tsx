import { tg } from "@console/i18n/gallery";
import { Receipt } from "./receipt";

export const order = 150;

export default function ReceiptGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.receipt")}</h2>
      <Receipt state="draft" message={tg("receipt.draft")} onUndo={() => undefined} />
      <Receipt state="sending" message={tg("receipt.sending")} />
      <Receipt
        state="recorded"
        message={tg("receipt.recorded")}
        meta={tg("receipt.meta")}
        actions={
          <>
            <button type="button" className="btn btn--ghost">{tg("receipt.audit")}</button>
            <button type="button" className="btn">{tg("receipt.change")}</button>
            <button type="button" className="btn">{tg("receipt.withdraw")}</button>
          </>
        }
      />
      <Receipt state="checking" />
      <Receipt state="applied" message={tg("receipt.applied")} onUndo={() => undefined} onDismiss={() => undefined} />
    </section>
  );
}
