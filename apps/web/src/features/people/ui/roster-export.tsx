// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { Button } from "../../../ui/button/button";

const ExportDialog = lazy(() => chunk(import("./roster-export-dialog")).then(module => ({ default: module.RosterExportDialog })));

export function RosterExport(props: { query: object; total: number | undefined }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{t("roster.export")}</Button>
    {open && <Suspense fallback={null}><ExportDialog {...props} close={() => setOpen(false)} /></Suspense>}
  </>;
}
