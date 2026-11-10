// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Section } from "../../../gallery/Section";
import { EMPTY_EVIDENCE } from "../domain/evidence";
import { EvidenceField } from "./evidence-field";

export const order = 218;
export default function AttendanceEvidenceGallery() {
  const [client] = useState(() => new QueryClient());
  const [value, setValue] = useState(EMPTY_EVIDENCE);
  return <QueryClientProvider client={client}><Section title={t("attendanceRecords.evidence.label")}>
    <EvidenceField value={value} onChange={setValue} />
  </Section></QueryClientProvider>;
}
