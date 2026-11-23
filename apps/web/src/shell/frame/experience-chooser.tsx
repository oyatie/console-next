// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { api, session, unwrap } from "@console/api";
import { t } from "@console/i18n";
import { useCommand } from "../../lib/react/command";
import { CommandError } from "../../lib/react/command-error";
import { settingsQuery } from "../../reference/settings/api";
import { SelectInput } from "../../ui/field/select-input";
import { hasUnsavedInput, installDirtyTracker } from "../../experience/dirty-guard";
import { applyDomExperience, useActiveExperienceId, type ExperienceId, type ExperienceSource } from "../../experience/dom";
import {
  mergeWorkspaceExperience,
  readStoredExperience,
  resolveEffectiveExperience,
  workspaceQuery,
  writeStoredExperience,
  type ExperienceChoice,
} from "../../experience/store";
import { offeredExperiences, resolveExperience } from "../../experience/table";

const saveWorkspaceLayout = (layout: Record<string, unknown>) =>
  unwrap(api.PUT("/api/v1/me/workspace", { body: { layout } }));

type LocalProblem = "unsaved" | "storage" | null;

function formatOptionLabel(id: string) {
  const experience = resolveExperience(id);
  return experience.listing === "preview"
    ? t("account.experience.preview", { style: t(experience.label) })
    : t(experience.label);
}

function DeviceExperienceChooser({ id }: { id: string }) {
  const [problem, setProblem] = useState<LocalProblem>(null);
  const activeId = useActiveExperienceId();
  const selected = resolveExperience(activeId);
  useEffect(() => {
    installDirtyTracker();
  }, []);
  return <>
    <SelectInput id={id} data-experience-ignore-dirty aria-label={t("account.experience")} aria-describedby={`${id}-hint`}
      value={selected.id} onChange={event => {
        if (hasUnsavedInput(document, event.currentTarget)) {
          setProblem("unsaved");
          return;
        }
        const next = resolveExperience(event.target.value);
        if (!writeStoredExperience(next.id, "personal")) {
          setProblem("storage");
          return;
        }
        setProblem(null);
        applyDomExperience(next.id, "personal");
      }}>
      {offeredExperiences(selected.id).map(experience => <option key={experience.id} value={experience.id}>
        {formatOptionLabel(experience.id)}
      </option>)}
    </SelectInput>
    <p id={`${id}-hint`} className="muted">{t("account.experience.device")}</p>
    {problem === "unsaved" && <span role="alert">{t("account.experience.unsaved")}</span>}
    {problem === "storage" && <span role="alert">{t("account.experience.failed")}</span>}
  </>;
}

function TenantExperienceChooser({ id }: { id: string }) {
  const [problem, setProblem] = useState<LocalProblem>(null);
  const activeId = useActiveExperienceId();
  const workspace = useQuery(workspaceQuery);
  const settings = useQuery(settingsQuery);
  useEffect(() => {
    installDirtyTracker();
  }, []);

  const layout = workspace.data?.layout && typeof workspace.data.layout === "object" && !Array.isArray(workspace.data.layout)
    ? workspace.data.layout
    : undefined;
  const items = Array.isArray(settings.data?.items) ? settings.data.items : undefined;
  const resolved = resolveEffectiveExperience({
    workspaceLayout: layout,
    settingsItems: items,
    storedDevice: readStoredExperience(),
  });

  const save = useCommand({
    run: (input: { layout: Record<string, unknown>; id: ExperienceId; source: ExperienceSource }) =>
      saveWorkspaceLayout(input.layout),
    invalidates: ["/api/v1/me/workspace"],
    awaitFirstRead: true,
    onSuccess: (_response, input) => {
      const stored = writeStoredExperience(input.id, input.source);
      setProblem(stored ? null : "storage");
      applyDomExperience(input.id, input.source);
    },
  });

  const currentForListing = resolved.choice === "tenant" ? activeId : resolved.choice;
  return <>
    <SelectInput id={id} data-experience-ignore-dirty aria-label={t("account.experience")} aria-describedby={`${id}-hint`}
      value={resolved.choice} onChange={event => {
        if (hasUnsavedInput(document, event.currentTarget)) {
          setProblem("unsaved");
          return;
        }
        const raw = event.target.value;
        const choice: ExperienceChoice = raw === "tenant" ? "tenant" : resolveExperience(raw).id;
        const nextId = choice === "tenant" ? resolved.tenantId : choice;
        const nextSource: ExperienceSource = choice === "tenant" ? "tenant" : "personal";
        setProblem(null);
        save.reset();
        save.mutate({ layout: mergeWorkspaceExperience(layout, choice), id: nextId, source: nextSource });
      }}>
      <option value="tenant">{t("account.experience.organizationDefault", { style: formatOptionLabel(resolved.tenantId) })}</option>
      {offeredExperiences(currentForListing).map(experience => <option key={experience.id} value={experience.id}>
        {formatOptionLabel(experience.id)}
      </option>)}
    </SelectInput>
    <p id={`${id}-hint`} className="muted">{t("account.experience.personal")}</p>
    {problem === "unsaved" && <span role="alert">{t("account.experience.unsaved")}</span>}
    {problem === "storage" && <span role="alert">{t("account.experience.failed")}</span>}
    <CommandError error={save.error} />
  </>;
}

export function ExperienceChooser({ id }: { id: string }) {
  const client = useContext(QueryClientContext);
  const inTenant = useSyncExternalStore(
    session.subscribe,
    () => Boolean(session.token && !session.claims?.platform),
    () => false,
  );
  return client && inTenant ? <TenantExperienceChooser id={id} /> : <DeviceExperienceChooser id={id} />;
}
