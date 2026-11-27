// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import type { ExportPurpose } from "../../../reference/directory/domain/export";

export type RecordSegment = components["schemas"]["PersonRecordSectionSegment"];
export type RecordImportRequest = components["schemas"]["PersonRecordImportRequest"];
export type RecordImportReport = components["schemas"]["PersonRecordImportReport"];
export type RecordSheet = components["schemas"]["PersonRecordSheet"];

/** Export live entries of one personnel card section (`GET /api/v1/employee-records/{section}`). */
export const exportRecordSheet = (section: RecordSegment, exportPurpose: ExportPurpose) =>
  unwrap(
    api.GET("/api/v1/employee-records/{section}", {
      params: { path: { section }, query: { export_purpose: exportPurpose, limit: 1000 } },
    }),
  );

/** Preview a parsed personnel card section sheet (`POST /api/v1/employee-records/{section}/import/preview`). */
export const previewRecordImport = (section: RecordSegment, body: RecordImportRequest) =>
  unwrap(
    api.POST("/api/v1/employee-records/{section}/import/preview", {
      params: { path: { section } },
      body,
    }),
  );

/** Apply a previewed personnel card section sheet (`POST /api/v1/employee-records/{section}/import/apply`). */
export const applyRecordImport = (
  section: RecordSegment,
  body: RecordImportRequest,
  key: string,
) =>
  unwrap(
    api.POST("/api/v1/employee-records/{section}/import/apply", {
      params: { path: { section }, header: { "Idempotency-Key": key } },
      body,
    }),
  );
