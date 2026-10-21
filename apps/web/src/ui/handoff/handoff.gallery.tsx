import { Button, Input, Label, TextField } from "react-aria-components";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { BlindReentry, HandoffState, MismatchCompare } from "./handoff";

export const order = 215;

const who = (n: number) => `${tg("sample.person", { n })} · ${tg("sample.position")}`;

/** The same item in both queues, the blind re-entry field, and the server's mismatch with both values. */
export default function Handoffs() {
  const title = t("exit.action.reject_exit");
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiHandoff.name")}</h2>
      <HandoffState title={title} from={{ who: who(1), note: tg("sample.site") }} to={{ who: who(2), note: tg("sample.dept") }} />
      <BlindReentry>
        {(hint) => (
          <TextField className="field" isRequired aria-describedby={hint}>
            <Label className="field__label">{t("exit.field.note")}</Label>
            <Input className="field__input" />
          </TextField>
        )}
      </BlindReentry>
      <MismatchCompare
        title={title}
        code="409 exit_date_mismatch"
        values={[{ who: who(1), value: "2026-10-15" }, { who: who(2), value: "2026-10-05" }]}
        remedies={<><Button className="btn">{t("exit.action.reject_exit")}</Button><Button className="btn">{t("uiRecordVerbs.button.correct", { object: t("exit.field.note") })}</Button></>}
      />
    </section>
  );
}
