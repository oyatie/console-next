// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Field, TextInput } from "../field/field";
import { SelectInput } from "../field/select-input";
import { KeyValue } from "../key-value/key-value";
import { Receipt } from "../receipt/receipt";
import { Sheet } from "../sheet/sheet";
import { StepLine } from "../step-line/step-line";
import { WizardPattern } from "./wizard";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { stepCount: 3 }, refetch() {} };

const STEP_IDS = ["basics", "cert", "review"] as const;

/** Synthetic no-network showcase for Wizard (`P8`). */
export default function WizardExample({ q = READY }: { q?: ReadState }) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState("corp");
  const [name, setName] = useState(() => tg("pat.wizard.nameSample"));
  const [regNo, setRegNo] = useState(() => tg("pat.wizard.regNoSample"));
  const [submitted, setSubmitted] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const steps = STEP_IDS.map((key, index) => ({
    key,
    label: tg(key === "basics" ? "pat.wizard.stepBasics" : key === "cert" ? "pat.wizard.stepCert" : "pat.wizard.stepReview"),
    state: (index < step ? "done" : index === step ? "current" : "waiting") as "done" | "current" | "waiting",
  }));

  return (
    <WizardPattern
      q={q}
      head={{
        title: tg("pat.wizard.head"),
        titleId: "wizard-pattern-title",
        actions: (
          <Button onClick={() => setSheetOpen(true)}>{tg("pat.wizard.saveDraft")}</Button>
        ),
      }}
      steps={<StepLine label={tg("pat.wizard.stepsLabel")} steps={steps} />}
      notes={submitted ? <Receipt state="recorded" message={tg("pat.wizard.submitted")} /> : undefined}
      body={
        <section className={fx.wizardSection} aria-labelledby="wizard-step-title">
          <h2 id="wizard-step-title" className={fx.wizardSectionHead}>
            {steps[step]!.label}
          </h2>
          {step === 0 ? (
            <>
              <Field label={tg("pat.wizard.kindLabel")} required>
                {props => (
                  <SelectInput {...props} value={kind} onChange={e => setKind(e.target.value)}>
                    <option value="corp">{tg("pat.wizard.kindCorp")}</option>
                    <option value="sole">{tg("pat.wizard.kindSole")}</option>
                  </SelectInput>
                )}
              </Field>
              <Field label={tg("pat.wizard.nameLabel")} required>
                {props => <TextInput {...props} value={name} onChange={e => setName(e.target.value)} />}
              </Field>
            </>
          ) : step === 1 ? (
            <Field label={tg("pat.wizard.regNoLabel")} required>
              {props => <TextInput {...props} value={regNo} onChange={e => setRegNo(e.target.value)} />}
            </Field>
          ) : (
            <KeyValue
              label={tg("pat.wizard.stepReview")}
              items={[
                { key: "kind", label: tg("pat.wizard.kindLabel"), value: tg(kind === "corp" ? "pat.wizard.kindCorp" : "pat.wizard.kindSole") },
                { key: "name", label: tg("pat.wizard.nameLabel"), value: name },
                { key: "reg", label: tg("pat.wizard.regNoLabel"), value: regNo },
              ]}
            />
          )}
        </section>
      }
      asideLabel={tg("pat.wizard.asideTitle")}
      aside={
        <div className={fx.bandPad}>
          <KeyValue
            label={tg("pat.wizard.asideTitle")}
            density="dense"
            items={[
              { key: "tax", label: tg("pat.wizard.asideTitle"), value: tg("pat.wizard.asideStatus") },
              { key: "seal", label: tg("pat.wizard.stepCert"), value: tg("pat.wizard.asideSeal") },
            ]}
          />
        </div>
      }
      consequence={<bdi>{tg("pat.wizard.consequence")}</bdi>}
      actions={
        <>
          {step > 0 ? (
            <Button onClick={() => setStep(s => Math.max(0, s - 1))}>{tg("pat.wizard.back")}</Button>
          ) : null}
          {step < STEP_IDS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep(s => Math.min(STEP_IDS.length - 1, s + 1))}>
              {tg("pat.wizard.next")}
            </Button>
          ) : (
            <Button variant="primary" data-submitted={submitted ? "1" : "0"} onClick={() => setSubmitted(true)}>
              {tg("pat.wizard.commit")}
            </Button>
          )}
        </>
      }
      overlays={
        <Sheet
          open={sheetOpen}
          title={tg("pat.wizard.saveDraft")}
          onClose={() => setSheetOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setSheetOpen(false)}>{tg("pat.wizard.back")}</Button>}
        >
          <bdi>{tg("pat.wizard.consequence")}</bdi>
        </Sheet>
      }
    />
  );
}
