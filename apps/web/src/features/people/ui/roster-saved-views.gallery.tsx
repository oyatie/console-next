// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import type { EmployeeViewFilters } from "@console/api/pending";
import { Section } from "../../../gallery/Section";
import { RosterSavedViews } from "./roster-saved-views";

export default function RosterSavedViewsGallery() {
  const [filters, setFilters] = useState<EmployeeViewFilters>({ status: "ON_LEAVE", sort: "-hire_date" });
  return <Section title={t("directoryViews.open")}><RosterSavedViews filters={filters} onApply={setFilters} /></Section>;
}
