// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { get, read } from "../../../lib/query";
export type Certificate = components["schemas"]["Certificate"];
export type CertificateSettings = components["schemas"]["CertificateSettings"];
export type IssueCertificate = components["schemas"]["IssueCertificateRequest"];
export const certificateQuery = (id: string) => get("/api/v1/hr/certificates/{id}", { params: { path: { id } } });
export const certificatesQuery = (employee_id?: string, cursor?: string) => get("/api/v1/hr/certificates", { params: { query: { employee_id, cursor } } });
// Pending server projection of certificate_settings_manage; an older response grants no remedy link.
export const certificateSettingsQuery = read<components["schemas"]["CertificateSettingsView"] & { can_manage?: boolean }>("/api/v1/hr/certificate-settings", () => unwrap(api.GET("/api/v1/hr/certificate-settings")));
export const issueCertificate = (body: IssueCertificate, key: string) => unwrap(api.POST("/api/v1/hr/certificates", { body, params: { header: { "Idempotency-Key": key } } }));
export const voidCertificate = (id: string, reason: string, key: string) => unwrap(api.POST("/api/v1/hr/certificates/{id}/void", { params: { path: { id }, header: { "Idempotency-Key": key } }, body: { reason } }));
export const reissueCertificate = (id: string, reason: string, key: string) => unwrap(api.POST("/api/v1/hr/certificates/{id}/reissue", { params: { path: { id }, header: { "Idempotency-Key": key } }, body: { reason } }));
export const setCertificateSettings = (body: components["schemas"]["CertificateSettingsRequest"]) => unwrap(api.PUT("/api/v1/hr/certificate-settings", { body }));
export const certificateError = (code: string) => {
  const id = `empDoc.certificate.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};
