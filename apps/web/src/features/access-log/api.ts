// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import { cursorRead } from "../../lib/query";

export type AccessLogFlag = "download" | "download_repeat" | "off_hours" | "bulk_subjects" | "sensitive_read" | "repeated_denial";
export type AccessLogEvent = {
  event_id: string; created_at: string; occurred_at: string; actor_id: string | null; actor_name: string;
  principal_type: string; action: string; target_type: string; subject_count: number; ip: string | null;
  outcome: "ALLOWED" | "DENIED"; export_purpose: string | null; row_count: number | null; flags: AccessLogFlag[];
};
type AccessLogPage = {
  period: { from: string; to: string; time_zone: string; closed: boolean };
  totals: { events: number; flagged: number; by_flag: Partial<Record<AccessLogFlag, number>> };
  items: AccessLogEvent[]; next_cursor: string | null;
};

const path = "/api/v1/access/access-log";
const page = (query: Record<string, string | number | boolean | undefined>) => unwrap((api.GET as unknown as (
  path: string, init: { params: { query: typeof query } },
) => Promise<{ data?: AccessLogPage; error?: unknown; response: Response }>)(path, { params: { query } }));

export const accessLogPages = (period: string | undefined, flagged: boolean) =>
  cursorRead(path, { period, flagged }, cursor => page({ period, flagged, cursor, limit: 200 }));
