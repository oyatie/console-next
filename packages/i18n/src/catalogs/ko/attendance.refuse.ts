// SPDX-License-Identifier: LicenseRef-Proprietary
import type { enAttendanceRefusals } from "../en/attendance.refuse";

export const koAttendanceRefusals: Record<keyof typeof enAttendanceRefusals, string> = {
  "attendance.refuse.missing_grant": "근태를 기록할 권한이 없어 처리하지 않았습니다. 권한 관리 담당자에게 해당 직원의 근태 기록 권한을 요청하십시오.",
  "attendance.refuse.console_clock_out_disabled": "적용된 근태 정책에서는 콘솔에서 퇴근을 기록할 수 없습니다.",
};
