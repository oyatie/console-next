// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";

const route = getRouteApi("/app/org/entities/new");
const EntityWizardBaseline = lazy(() => chunk(import("./entity-wizard-baseline")).then((m) => ({ default: m.EntityWizardBaseline })));
const EntityWizardConsole = lazy(() => chunk(import("./entity-wizard-console")).then((m) => ({ default: m.EntityWizardConsole })));

export function NewEntityScreen() {
  const { kind, name } = route.useSearch();
  return (
    <AccessGate domain="org" level="edit" tenant>
      <ExperienceSwitch
        baseline={() => (
          <Suspense fallback={<ReadSkeleton layout="form" />}>
            <EntityWizardBaseline kind={kind} name={name} title={<h1 tabIndex={-1}>{t("entityCreate.title")}</h1>} />
          </Suspense>
        )}
      >
        {() => (
          <Suspense fallback={<ReadSkeleton layout="form" />}>
            <EntityWizardConsole kind={kind} name={name} />
          </Suspense>
        )}
      </ExperienceSwitch>
    </AccessGate>
  );
}
