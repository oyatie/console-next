// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";

const DataHealthConsole = lazy(() => chunk(import("./data-health-console")).then((m) => ({ default: m.DataHealthConsole })));

function DataHealthBaseline() {
  return (
    <EmptyState
      title={t("dataHealth.title")}
      reason={t("dataHealth.baseline.note")}
      actions={<Link to="/people" search={{}} className={buttonClass("primary")}>{t("dataHealth.baseline.back")}</Link>}
    />
  );
}

export function DataHealthPage() {
  return (
    <AccessGate domain="hr_basic" level="view">
      <ExperienceSwitch baseline={() => <DataHealthBaseline />}>
        {() => (
          <Suspense fallback={<ReadSkeleton layout="list" />}>
            <DataHealthConsole />
          </Suspense>
        )}
      </ExperienceSwitch>
    </AccessGate>
  );
}
