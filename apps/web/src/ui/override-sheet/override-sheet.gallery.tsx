import { useState } from "react";
import { Button, Label, TextArea, TextField } from "react-aria-components";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ExceptionMark, OverrideSheet, type OverrideRisk, type OverrideRoute } from "./override-sheet";

export const order = 214;

const who = (n: number) => `${tg("sample.person", { n })} · ${tg("sample.position")}`;
const samples: { risk: OverrideRisk; route: OverrideRoute }[] = [
  { risk: "high", route: { kind: "second", steps: [{ key: "1", who: who(1), state: "done" }, { key: "2", who: who(2), state: "current", note: t("periodLocks.unlock.consequence", { domain: tg("sample.dept"), period: "2026-09" }) }] } },
  { risk: "high", route: { kind: "sole-holder", notified: 3, binding: { action: "PERIOD_UNLOCK", hash: "3f9a…c21" } } },
  { risk: "mid", route: { kind: "step-up", binding: { action: "EXIT_CONFIRM", hash: "81be…07d", confirmedAt: "10:21" } } },
];

function Sample({ risk, route }: { risk: OverrideRisk; route: OverrideRoute }) {
  const [open, setOpen] = useState(false);
  const [memo, setMemo] = useState("");
  return (
    <>
      <Button className="btn" onPress={() => setOpen(true)}>{t(`uiOverrideSheet.risk.${risk}`)} · {route.kind}</Button>
      <OverrideSheet
        open={open}
        title={t("uiOverrideSheet.name")}
        rule={{ title: t("periodLocks.reason"), detail: t("periodLocks.consequence", { domain: tg("sample.dept") }), code: "LIFECYCLE_BACKDATED_CLOSED_PERIOD" }}
        risk={risk}
        route={route}
        reason={
          <TextField className="field" value={memo} onChange={setMemo} isRequired>
            <Label className="field__label">{t("periodLocks.unlock.reason")}</Label>
            <TextArea className="field__input field__area" />
          </TextField>
        }
        reasonComplete={memo.trim() !== ""}
        commitLabel={t("periodLocks.unlock.reason")}
        onCommit={() => setOpen(false)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export default function OverrideSheets() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiOverrideSheet.name")}</h2>
      <div className="row">
        {samples.map((s) => <Sample key={s.route.kind} {...s} />)}
        <ExceptionMark />
      </div>
    </section>
  );
}
