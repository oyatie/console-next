// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { DocumentDecision } from "../../../ui/patterns/document-decision";
import { SelectField } from "../../../ui/select/select-field";
import {
  POLICY_READS,
  policyDraftQuery,
  reviewPolicyDraft,
  simulatePolicyDecision,
  submitPolicyDraft,
  updatePolicyDraft,
  validatePolicyDraft,
  type PolicyNoCodeBlocks,
  type PolicySimulationOutcome,
} from "../api/policy";
import s from "./access.module.css";

const route = getRouteApi("/app/access/policies/$draftId");

export function PolicyDraftPage() {
  const { draftId } = route.useParams();
  return (
    <AccessGate domain="access" level="edit" tenant>
      <PolicyDraftWorkspace draftId={draftId} />
    </AccessGate>
  );
}

function PolicyDraftWorkspace({ draftId }: { draftId: string }) {
  const me = useQuery(get("/api/v1/users/me"));
  const org = useQuery(get("/api/v1/org-structure"));
  const q = useQuery(policyDraftQuery(draftId));
  const draft = q.data;

  const [title, setTitle] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [effect, setEffect] = useState<"permit" | "forbid" | null>(null);
  const [action, setAction] = useState<PolicyNoCodeBlocks["action"] | null>(null);
  const [resourceType, setResourceType] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [simSubject, setSimSubject] = useState("");
  const [simResource, setSimResource] = useState("res-1");
  const [simOutcome, setSimOutcome] = useState<PolicySimulationOutcome | null>(null);

  const curTitle = title ?? draft?.title ?? "";
  const curNote = note ?? draft?.author_note ?? "";
  const curEffect = effect ?? draft?.blocks?.effect ?? "permit";
  const curAction = action ?? draft?.blocks?.action ?? "view";
  const curResType = resourceType ?? draft?.blocks?.resource_type ?? "employee";

  const saveCmd = useCommand({
    run: () =>
      updatePolicyDraft(draftId, {
        title: curTitle.trim(),
        author_note: curNote.trim() || null,
        blocks: {
          effect: curEffect,
          action: curAction,
          resource_type: curResType.trim(),
          conditions: draft?.blocks?.conditions ?? [],
        },
      }),
    invalidates: POLICY_READS,
    announce: () => t("accessPolicies.draft.saved"),
  });

  const validateCmd = useCommand({
    run: () => validatePolicyDraft(draftId),
    invalidates: POLICY_READS,
    announce: () => t("accessPolicies.draft.validated"),
  });

  const submitCmd = useCommand({
    run: () => submitPolicyDraft(draftId),
    invalidates: POLICY_READS,
    announce: () => t("accessPolicies.draft.submitted"),
  });

  const reviewCmd = useCommand({
    run: (decision: "approve" | "reject") =>
      reviewPolicyDraft(draftId, { decision, note: reviewNote.trim() || null }),
    invalidates: POLICY_READS,
    announce: () => t("accessPolicies.draft.reviewed"),
  });

  const simCmd = useCommand({
    run: async () => {
      const res = await simulatePolicyDecision({
        subject: {
          user_id: simSubject.trim() || me.data?.id || "00000000-0000-0000-0000-000000000001",
          org: org.data?.entities[0]?.id || "00000000-0000-0000-0000-000000000001",
          roles: [],
        },
        action: curAction,
        resource: { resource_type: curResType.trim(), resource_id: simResource.trim() || "res-1" },
        include_draft_id: draftId,
      });
      setSimOutcome(res.outcome);
      return res;
    },
  });

  const err = reviewCmd.error ?? submitCmd.error ?? validateCmd.error ?? saveCmd.error ?? simCmd.error;

  return (
    <DocumentDecision
      q={q}
      back={{ to: "/access/policies", label: t("accessPolicies.title") }}
      head={{
        title: draft?.title ?? t("accessPolicies.title"),
        meta: draft ? <Chip tone="info">{draft.status}</Chip> : undefined,
      }}
      notes={<CommandError error={err} />}
      document={
        <div className={s.stack}>
          <Card title={t("accessPolicies.title")}>
            <div className={s.stack}>
              {draft && (
                <KeyValue
                  items={[
                    { key: "key", label: t("accessPolicies.form.draftKey"), value: draft.draft_key },
                    { key: "status", label: t("accessPolicies.col.status"), value: draft.status },
                    { key: "val", label: t("accessPolicies.draft.validate"), value: draft.validation_status ?? "—" },
                  ]}
                />
              )}
              <Field label={t("accessPolicies.form.title")} required>
                {(p) => <TextInput {...p} value={curTitle} onChange={(e) => setTitle(e.target.value)} />}
              </Field>
              <ChoiceField
                label={t("accessPolicies.form.effect")}
                required
                value={curEffect}
                onChange={(v) => setEffect(v as "permit" | "forbid")}
                options={[
                  { value: "permit", label: "permit" },
                  { value: "forbid", label: "forbid" },
                ]}
              />
              <SelectField
                label={t("accessPolicies.form.action")}
                placeholder={t("accessPolicies.form.action")}
                value={curAction}
                onChange={(v) => setAction(v as PolicyNoCodeBlocks["action"])}
                options={[
                  { id: "view", label: "view" },
                  { id: "edit", label: "edit" },
                  { id: "read_field", label: "read_field" },
                  { id: "console:configure", label: "console:configure" },
                  { id: "console:deploy", label: "console:deploy" },
                ]}
              />
              <Field label={t("accessPolicies.form.resourceType")} required>
                {(p) => <TextInput {...p} value={curResType} onChange={(e) => setResourceType(e.target.value)} />}
              </Field>
              <Field label={t("accessPolicies.form.note")} required={false}>
                {(p) => <TextInput {...p} value={curNote} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <div className={s.actions}>
                <Button variant="secondary" disabled={saveCmd.isPending} onClick={() => saveCmd.mutate(undefined)}>
                  {t("accessPolicies.draft.save")}
                </Button>
                <Button variant="secondary" disabled={validateCmd.isPending} onClick={() => validateCmd.mutate(undefined)}>
                  {t("accessPolicies.draft.validate")}
                </Button>
                <Button variant="primary" disabled={submitCmd.isPending} onClick={() => submitCmd.mutate(undefined)}>
                  {t("accessPolicies.draft.submit")}
                </Button>
              </div>
            </div>
          </Card>

          <Card title={t("accessPolicies.draft.simulate")}>
            <div className={s.stack}>
              <Field label={t("accessPolicies.sim.subjectUser")} required={false}>
                {(p) => <TextInput {...p} value={simSubject} onChange={(e) => setSimSubject(e.target.value)} />}
              </Field>
              <Field label={t("accessPolicies.sim.resourceId")} required>
                {(p) => <TextInput {...p} value={simResource} onChange={(e) => setSimResource(e.target.value)} />}
              </Field>
              <div>
                <Button size="sm" variant="secondary" disabled={simCmd.isPending} onClick={() => simCmd.mutate(undefined)}>
                  {t("accessPolicies.draft.simulate")}
                </Button>
              </div>
              {simOutcome && (
                <Banner tone={simOutcome.effect === "allow" ? "ok" : "warn"}>
                  {t("accessPolicies.sim.result", { effect: simOutcome.effect })}
                </Banner>
              )}
            </div>
          </Card>
        </div>
      }
      decisionLabel={t("accessPolicies.draft.approve")}
      decision={
        <Card title={t("accessPolicies.draft.approve")}>
          <div className={s.stack}>
            <Field label={t("accessPolicies.draft.reviewNote")} required={false}>
              {(p) => <TextInput {...p} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />}
            </Field>
            <div className={s.actions}>
              <Button
                variant="primary"
                disabled={reviewCmd.isPending || draft?.status !== "review_pending"}
                onClick={() => reviewCmd.mutate("approve")}
              >
                {t("accessPolicies.draft.approve")}
              </Button>
              <Button
                variant="danger"
                disabled={reviewCmd.isPending || draft?.status !== "review_pending"}
                onClick={() => reviewCmd.mutate("reject")}
              >
                {t("accessPolicies.draft.reject")}
              </Button>
            </div>
          </div>
        </Card>
      }
    />
  );
}
