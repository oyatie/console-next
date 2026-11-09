// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Section } from "../../../gallery/Section";
import type { AccessLogFilters } from "../api";
import { AccessLogFiltersForm } from "./access-log-filters";

export const order = 128;
export default function AccessLogFiltersGallery() {
  const [value, setValue] = useState<AccessLogFilters>({});
  return <Section title={t("accessLog.filters")}>
    <AccessLogFiltersForm key={JSON.stringify(value)} value={value} onApply={setValue}
      period={{ from: "2026-10-01", to: "2026-11-01" }}
      options={{ actors: [{ id: "account-1", label: tg("blocker.ceo") }],
        actions: [{ id: "employee.export", label_key: "accessLog.action.employee.export" }], target_types: [] }} />
  </Section>;
}
