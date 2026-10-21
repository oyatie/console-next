import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { RecordVerbs, WithdrawCascade } from "./record-verbs";

export const order = 213;

const noop = () => {};

/** Scheduled (change and withdraw allowed), applied (correct and withdraw), and the withdraw cascade shown before the commit. */
export default function RecordVerbsGallery() {
  const object = t("enum.lifecycleEvent.TRANSFER");
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiRecordVerbs.name")}</h2>
      <RecordVerbs object={object} onVerb={noop} actions={[{ verb: "amend", allowed: true }, { verb: "correct", allowed: false }, { verb: "withdraw", allowed: true }]} />
      <RecordVerbs object={object} onVerb={noop} pending="correct" actions={[{ verb: "amend", allowed: false }, { verb: "correct", allowed: true }, { verb: "withdraw", allowed: true }]} />
      <WithdrawCascade items={[
        { key: "a", what: tg("sample.team"), who: t("enum.stepDecision.PENDING") },
        { key: "b", what: tg("sample.teamLong"), who: t("enum.stepDecision.PENDING") },
      ]} />
      <WithdrawCascade items={[]} />
    </section>
  );
}
