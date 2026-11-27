// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { PageHead } from "../../../ui/page-head/page-head";
import { FormPattern } from "../../../ui/patterns/form";
import { FormSection } from "../../../ui/patterns/form-section";
import { SelectField } from "../../../ui/select/select-field";
import {
  startWorkflowRun,
  submittableDefinitionsQuery,
  type ApprovalLineOverrideStep,
} from "../api/new-approval";

type DraftStep = { key: string; node_key: string; assignee_role_key: string; title: string };

export function ApprovalNewPage() {
  const defsQ = useQuery(submittableDefinitionsQuery);
  const defs = defsQ.data?.items ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [tried, setTried] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  const activeDef = defs.find((d) => d.id === selectedId) ?? defs[0];
  const allowOverride = Boolean(activeDef?.allow_approval_line_override);

  const submitCmd = useCommand({
    run: () => {
      const overrides: ApprovalLineOverrideStep[] = allowOverride
        ? steps
            .filter((s) => s.assignee_role_key.trim().length > 0)
            .map((s) => ({
              assignee_role_key: s.assignee_role_key.trim(),
              ...(s.node_key.trim() ? { node_key: s.node_key.trim() } : {}),
              ...(s.title.trim() ? { title: s.title.trim() } : {}),
            }))
        : [];
      return startWorkflowRun({
        definition_id: activeDef!.id,
        trigger_type: "MANUAL",
        idempotency_key: idempotencyKey,
        input_payload: {
          title: subject.trim(),
          reason: reason.trim(),
          ...(effectiveDate.trim() ? { effective_date: effectiveDate.trim() } : {}),
        },
        ...(overrides.length > 0 ? { approval_line_overrides: overrides } : {}),
      });
    },
    invalidates: ["/api/v1/approvals", "/api/v1/me/action-inbox"],
    onSuccess: (res) => {
      setStartedRunId(res.run.id);
      setIdempotencyKey(crypto.randomUUID());
      announce(t("approvals.new.submitted", { id: res.run.id }));
    },
  });

  const handleSubmit = () => {
    setTried(true);
    if (!activeDef || !subject.trim() || !reason.trim()) return;
    submitCmd.mutate(undefined);
  };

  const addStep = () =>
    setSteps((prev) => [
      ...prev,
      { key: crypto.randomUUID(), node_key: "", assignee_role_key: "", title: "" },
    ]);

  const updateStep = (key: string, patch: Partial<DraftStep>) =>
    setSteps((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const removeStep = (key: string) =>
    setSteps((prev) => prev.filter((item) => item.key !== key));

  const sections = (
    <>
      {startedRunId && (
        <Banner
          tone="ok"
          actions={
            <Link to="/approvals" search={{ box: "requested" }} className={buttonClass("secondary", { size: "sm" })}>
              {t("approvals.new.viewRequested")}
            </Link>
          }
        >
          {t("approvals.new.submitted", { id: startedRunId })}
        </Banner>
      )}
      <FormSection>
        <h2>{t("approvals.new.templateSection")}</h2>
        {defs.length === 0 ? (
          <EmptyState compact title={t("approvals.new.templateEmpty")} reason={null} />
        ) : (
          <SelectField
            label={t("approvals.new.template")}
            placeholder={t("approvals.new.template")}
            value={activeDef?.id ?? null}
            onChange={setSelectedId}
            options={defs.map((d) => ({
              id: d.id,
              label: `${d.display_name} (${d.workflow_key})`,
            }))}
          />
        )}
      </FormSection>

      {defs.length > 0 && (
        <FormSection>
          <h2>{t("approvals.new.detailsSection")}</h2>
          <Field
            label={t("approvals.new.subject")}
            required
            error={tried && !subject.trim() ? t("approvals.new.requiredFields") : undefined}
          >
            {(p) => <TextInput {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}
          </Field>
          <Field label={t("approvals.new.effectiveDate")} required={false} example="2026-12-01">
            {(p) => <TextInput {...p} value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />}
          </Field>
          <Field
            label={t("approvals.new.reason")}
            required
            error={tried && !reason.trim() ? t("approvals.new.requiredFields") : undefined}
          >
            {(p) => <TextInput {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </FormSection>
      )}

      {allowOverride && (
        <FormSection>
          <h2>{t("approvals.new.lineSection")}</h2>
          <p className="muted">{t("approvals.new.lineHint")}</p>
          {steps.map((step) => (
            <div key={step.key} className="form">
              <Field label={t("approvals.new.stepRole")} required>
                {(p) => (
                  <TextInput
                    {...p}
                    value={step.assignee_role_key}
                    onChange={(e) => updateStep(step.key, { assignee_role_key: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("approvals.new.stepTitle")} required={false}>
                {(p) => (
                  <TextInput
                    {...p}
                    value={step.title}
                    onChange={(e) => updateStep(step.key, { title: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("approvals.new.stepNode")} required={false}>
                {(p) => (
                  <TextInput
                    {...p}
                    value={step.node_key}
                    onChange={(e) => updateStep(step.key, { node_key: e.target.value })}
                  />
                )}
              </Field>
              <div>
                <Button size="sm" variant="secondary" onClick={() => removeStep(step.key)}>
                  {t("approvals.new.removeStep")}
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button size="sm" variant="secondary" onClick={addStep}>
              {t("approvals.new.addStep")}
            </Button>
          </div>
        </FormSection>
      )}
      <CommandError error={submitCmd.error} />
    </>
  );

  const actions = (
    <>
      <Link to="/approvals" className={buttonClass("secondary")}>
        {t("common.back")}
      </Link>
      <Button variant="primary" disabled={!activeDef || submitCmd.isPending} onClick={handleSubmit}>
        {t("approvals.new.submit")}
      </Button>
    </>
  );

  return (
    <FormPattern
      q={defsQ}
      back={{ to: "/approvals", label: t("approvals.title") }}
      head={{ title: t("approvals.new.title"), titleId: "approval-new-title" }}
      sections={sections}
      actions={actions}
      onSubmit={handleSubmit}
      noValidate
      baseline={() => (
        <main className="page" data-floorplan="P-04">
          <PageHead title={t("approvals.new.title")} />
          <QueryState q={defsQ} layout="form">
            {() => (
              <Card>
                <div className="form">
                  {sections}
                  <div className="form__actions">{actions}</div>
                </div>
              </Card>
            )}
          </QueryState>
        </main>
      )}
    />
  );
}
