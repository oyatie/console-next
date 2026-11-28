// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { FormPattern } from "../../../ui/patterns/form";
import { SelectField } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import {
  authorizePolicyBulk,
  authorizePolicyPoint,
  type PolicySimulationOutcome,
} from "../api/policy";
import { AccessNavTabs } from "./access-head";
import s from "./access.module.css";

const STANDARD_ACTIONS = ["view", "edit", "read_field", "console:configure", "console:deploy"];

export function AccessCheckPage() {
  return (
    <AccessGate domain="access" level="edit" tenant>
      <AccessCheckWorkspace />
    </AccessGate>
  );
}

function AccessCheckWorkspace() {
  const me = useQuery(get("/api/v1/users/me"));
  const org = useQuery(get("/api/v1/org-structure"));
  const [subjectId, setSubjectId] = useState("");
  const [orgId, setOrgId] = useState("");
  const [rolesInput, setRolesInput] = useState("");
  const [resourceType, setResourceType] = useState("employee");
  const [resourceId, setResourceId] = useState("emp-1");
  const [action, setAction] = useState("view");
  const [pointResult, setPointResult] = useState<PolicySimulationOutcome | null>(null);
  const [bulkResults, setBulkResults] = useState<{ action: string; outcome: PolicySimulationOutcome }[]>([]);

  const effectiveUser = subjectId.trim() || me.data?.id || "";
  const effectiveOrg = orgId.trim() || org.data?.entities[0]?.id || "";
  const parsedRoles = rolesInput
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  const singleCmd = useCommand({
    run: async () => {
      const res = await authorizePolicyPoint({
        user_id: effectiveUser,
        org: effectiveOrg,
        roles: parsedRoles,
        action,
        resource_type: resourceType.trim(),
        resource_id: resourceId.trim(),
      });
      setPointResult(res.outcome);
      return res;
    },
  });

  const bulkCmd = useCommand({
    run: async () => {
      const res = await authorizePolicyBulk({
        user_id: effectiveUser,
        org: effectiveOrg,
        roles: parsedRoles,
        resource_type: resourceType.trim(),
        resource_id: resourceId.trim(),
        actions: STANDARD_ACTIONS,
      });
      setBulkResults(
        STANDARD_ACTIONS.map((act, idx) => ({
          action: act,
          outcome: res.decisions[idx] ?? { effect: "deny" },
        })),
      );
      return res;
    },
  });

  const err = singleCmd.error ?? bulkCmd.error;

  return (
    <FormPattern
      q={me}
      tabs={<AccessNavTabs failed={Boolean(me.error)} />}
      head={{ title: t("accessCheck.title") }}
      notice={<CommandError error={err} />}
      onSubmit={() => {
        if (!effectiveUser || !effectiveOrg) return;
        singleCmd.mutate(undefined);
      }}
      sections={
        <div className={s.stack}>
          <Card title={t("accessCheck.title")}>
            <div className={s.stack}>
              <Field label={t("accessCheck.subjectLabel")} required>
                {(p) => <TextInput {...p} value={subjectId || effectiveUser} onChange={(e) => setSubjectId(e.target.value)} />}
              </Field>
              <Field label={t("accessCheck.orgLabel")} required>
                {(p) => <TextInput {...p} value={orgId || effectiveOrg} onChange={(e) => setOrgId(e.target.value)} />}
              </Field>
              <Field label={t("accessCheck.rolesLabel")} required={false}>
                {(p) => <TextInput {...p} value={rolesInput} onChange={(e) => setRolesInput(e.target.value)} />}
              </Field>
              <Field label={t("accessCheck.resourceType")} required>
                {(p) => <TextInput {...p} value={resourceType} onChange={(e) => setResourceType(e.target.value)} />}
              </Field>
              <Field label={t("accessCheck.resourceId")} required>
                {(p) => <TextInput {...p} value={resourceId} onChange={(e) => setResourceId(e.target.value)} />}
              </Field>
              <SelectField
                label={t("accessCheck.action")}
                placeholder={t("accessCheck.action")}
                value={action}
                onChange={setAction}
                options={STANDARD_ACTIONS.map((a) => ({ id: a, label: a }))}
              />
            </div>
          </Card>

          {pointResult && (
            <Card title={t("accessCheck.resultTitle")}>
              <KeyValue
                items={[
                  {
                    key: "effect",
                    label: t("accessCheck.resultTitle"),
                    value: (
                      <Chip tone={pointResult.effect === "allow" ? "ok" : "warn"}>
                        {pointResult.effect === "allow" ? t("accessCheck.effect.allow") : t("accessCheck.effect.deny")}
                      </Chip>
                    ),
                  },
                  {
                    key: "policies",
                    label: t("accessCheck.policies"),
                    value: (pointResult.determining_policies ?? []).join(", ") || "—",
                  },
                ]}
              />
            </Card>
          )}

          {bulkResults.length > 0 && (
            <Card title={t("accessCheck.runBulk")}>
              <Table
                label={t("accessCheck.runBulk")}
                rows={bulkResults}
                rowId={(r) => r.action}
                density="compact"
                columns={[
                  { header: t("accessCheck.action"), card: "title", cell: (r) => r.action },
                  {
                    header: t("accessCheck.resultTitle"),
                    card: "status",
                    cell: (r) => (
                      <Chip tone={r.outcome.effect === "allow" ? "ok" : "warn"}>
                        {r.outcome.effect === "allow" ? t("accessCheck.effect.allow") : t("accessCheck.effect.deny")}
                      </Chip>
                    ),
                  },
                ]}
              />
            </Card>
          )}
        </div>
      }
      actions={
        <div className={s.actions}>
          <Button
            type="button"
            variant="secondary"
            disabled={!effectiveUser || !effectiveOrg || bulkCmd.isPending}
            onClick={() => bulkCmd.mutate(undefined)}
          >
            {t("accessCheck.runBulk")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!effectiveUser || !effectiveOrg || singleCmd.isPending}
          >
            {t("accessCheck.runSingle")}
          </Button>
        </div>
      }
    />
  );
}
