import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { DisabledReason } from "./disabled-reason";

export const order = 152;

/** Plain, with a remedy, and inline in a row list (one action per row, the reason beside it). */
export default function DisabledReasons() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.disabledReason")}</h2>
      <DisabledReason control={(p) => <Button variant="primary" {...p}>{tg("disabledReason.effectuate")}</Button>} reason={tg("disabledReason.effectuateWhy")} />
      <DisabledReason
        control={(p) => <Button {...p}>{tg("disabledReason.remove")}</Button>}
        reason={tg("disabledReason.removeWhy")}
        remedy={<Button variant="ghost">{tg("disabledReason.removeFix")}</Button>}
      />
      <ul className="list-plain">
        <li><DisabledReason layout="inline" control={(p) => <Button {...p}>{tg("disabledReason.rowMove")}</Button>} reason={tg("disabledReason.rowMoveWhy")} /></li>
        <li>
          <DisabledReason
            layout="inline"
            control={(p) => <Button {...p}>{tg("disabledReason.rowDissolve")}</Button>}
            reason={tg("disabledReason.rowDissolveWhy")}
            remedy={<Button variant="ghost">{tg("disabledReason.rowDissolveFix")}</Button>}
          />
        </li>
      </ul>
    </section>
  );
}
