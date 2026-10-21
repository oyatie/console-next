import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { ReasonField } from "./reason-field";
import type { Reason } from "./reason";

export const order = 100;

// The server's list for one area; Other arrives anywhere and is always shown last.
const CODES = (["OTHER", "SCOPE", "DATE", "GROUNDS", "TARGET", "POLICY"] as const).map((code) => ({ code, label: tg(`reason.${code}`) }));
const MEMO_MAX = 500;

function Demo({ initial, showErrors = false }: { initial: Reason; showErrors?: boolean }) {
  const [value, setValue] = useState(initial);
  return <ReasonField label={tg("reason.label")} codes={CODES} other="OTHER" value={value} onChange={setValue} memoMax={MEMO_MAX} showErrors={showErrors} />;
}

export default function ReasonGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.reason")}</h2>
      <div className="grid-3">
        <Demo initial={{ code: null, memo: "" }} />
        <Demo initial={{ code: "OTHER", memo: "" }} showErrors />
        <Demo initial={{ code: "DATE", memo: tg("reason.memoSample") }} showErrors />
      </div>
    </section>
  );
}
