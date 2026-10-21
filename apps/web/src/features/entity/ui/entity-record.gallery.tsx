import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { tg } from "@console/i18n/gallery";
import { FORMATS } from "../../../lib/pure/formats";
import { Section } from "../../../gallery/Section";
import { Item as CreateItem } from "./create-item";
import { FactRow } from "./record-fact-row";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

export const order = 420;

const noop = () => {};

/**
 * The entity record's fact rows (spec S3, D10) with each verb: edit (change or correction), correct-only, an
 * identifier's lock, and a fact without a verb; then a certificate item with its printed number as the create wizard
 * shows it (spec S4).
 */
export default function EntityRecordGallery() {
  return (
    <Section title={t("entityRecord.cert.title")}>
      <div className={s.facts}>
        <FactRow no={1} label={t("entityRecord.field.corpName")} action={{ kind: "fix", onPress: noop }}>{tg("sample.company")}</FactRow>
        <FactRow no={3} label={t("entityRecord.field.openedOn")} action={{ kind: "cor", onPress: noop }}>{fmtDate("2020-03-02")}</FactRow>
        <FactRow label={t("entityRecord.field.brn")} action={{ kind: "lock", onPress: noop }}>{FORMATS.bizRegNo.display("0000000000")}</FactRow>
        <FactRow no={8} label={t("entityRecord.field.issueReason")}>{t("enum.issueReason.NEW")}</FactRow>
        <FactRow no={7} label={t("entityRecord.field.businessTypes")} wide action={{ kind: "fix", onPress: noop }}>{tg("sample.teamLong")}</FactRow>
      </div>
      <CreateItem no={4}>
        <span className="field__label">{t("entityCreate.field.crn")}</span>
        <Muted>{t("entityCreate.problem.crnChecksum")}</Muted>
      </CreateItem>
    </Section>
  );
}
