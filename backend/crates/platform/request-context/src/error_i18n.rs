//! Korean error messages for `Accept-Language: ko`: the message table and the
//! language preference, moved down verbatim from `app/src/error_i18n.rs`
//! (R2 step 0, OD-8). The app keeps the response-rewriting layer and
//! re-exports these.
//!
//! **Frozen** (OD-8): never reword or drop an English key; the Korean fallback
//! matches the English text, so a reword silently degrades to generic Korean.
//! New meaning gets a new error code. `frozen_keys.rs` pins every key.
//!
//! Lookup order: exact English message ([`MESSAGES`], its parts in order), a
//! parameterised pattern, then the per-code fallback ([`CODES`]).

use http::{HeaderMap, header};

mod auth;
mod employees;
#[cfg(test)]
mod frozen_keys;
mod locks_exits;
mod org_change;
mod personal;

/// Exact English message → Korean (합니다체), split by area; the first match
/// in this order wins.
const MESSAGES: &[&[(&str, &str)]] = &[
    auth::MESSAGES,
    org_change::MESSAGES,
    employees::MESSAGES,
    locks_exits::MESSAGES,
    personal::MESSAGES,
];

/// Per-code fallback when the exact message is not in [`MESSAGES`].
const CODES: &[(&str, &str)] = &[
    (
        "contract_overlap",
        "기존 계약과 기간이 겹칩니다. 계약 내역에서 겹치는 계약을 정정하십시오.",
    ),
    (
        "rehire_date_not_after_exit",
        "재입사일은 마지막 퇴직일 다음 날부터 선택하십시오.",
    ),
    ("validation", "요청 값이 올바르지 않습니다."),
    ("bad_request", "요청 형식이 올바르지 않습니다."),
    (
        "lifecycle_schedule_conflict",
        "이 변경 뒤에는 예약된 인사 이벤트를 적용할 수 없습니다. 해당 예약을 먼저 취소하거나 고쳐 주십시오.",
    ),
    (
        "lifecycle_scheduled_state",
        "예약된 인사 이벤트 때문에 그날에는 이 인사 이벤트를 기록할 수 없습니다.",
    ),
    ("not_found", "대상을 찾을 수 없습니다."),
    ("forbidden", "이 작업을 수행할 권한이 없습니다."),
    ("conflict", "요청이 현재 상태와 충돌합니다."),
    (
        "preflight_blocked",
        "사전점검 차단 항목이 있어 상신할 수 없습니다.",
    ),
    (
        "lifecycle_noop",
        "바뀌는 내용이 없어 인사 이벤트를 기록하지 않았습니다.",
    ),
    (
        "bulk_lifecycle_refused",
        "일부 직원에게 적용할 수 없어 일괄 발령을 기록하지 않았습니다.",
    ),
    (
        "admin_already_enrolled",
        "테넌트 관리자가 이미 패스키를 등록했습니다.",
    ),
    (
        "invalid_transition",
        "현재 상태에서는 이 작업을 할 수 없습니다.",
    ),
    ("unauthorized", "인증이 필요합니다."),
    (
        "passkey_required",
        "이 작업을 하려면 먼저 패스키를 등록해야 합니다.",
    ),
    (
        "lifecycle_signoff_required",
        "필수 확인 항목이 누락되었습니다.",
    ),
    (
        "too_many_requests",
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주십시오.",
    ),
    ("internal", "서버 오류가 발생했습니다."),
    ("unavailable", "일시적으로 사용할 수 없습니다."),
    // The generic 5xx messages (app/src/http/redact.rs) and the JSON envelope
    // for plain-text rejections translate by code.
    ("service_unavailable", "일시적으로 사용할 수 없습니다."),
    (
        "bad_gateway",
        "외부 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주십시오.",
    ),
    ("payload_too_large", "요청 크기가 너무 큽니다."),
    ("unsupported_media_type", "지원하지 않는 요청 형식입니다."),
    ("method_not_allowed", "허용되지 않는 요청 방식입니다."),
    // --- lane: PEOPLE-B ---
    (
        "export_purpose_required",
        "내려받기 용도(export_purpose)를 선택해 주십시오.",
    ),
    (
        "exit_case_open",
        "이 직원에게는 이미 진행 중인 퇴사 건이 있습니다.",
    ),
    // --- lane: PEOPLE-READS-2 ---
    (
        "bulk_selection_changed",
        "조건에 맞는 인원이 확인한 인원과 달라졌습니다. 인원을 다시 확인해 주십시오.",
    ),
    // --- lane: TR-33 ---
    (
        "transfer_cross_entity",
        "다른 법인으로는 전보할 수 없습니다. 법인 간 이동은 전적으로 합니다.",
    ),
    // --- lane: UX-R3 SCOPE (AX-5) ---
    (
        "out_of_scope",
        "이 계정의 권한 범위 밖입니다. 범위를 넓히려면 권한 관리 담당자에게 요청해 주십시오.",
    ),
    (
        "scope_tenant_wide_only",
        "이 작업은 모든 법인에 한꺼번에 적용되어 「전체」 범위 권한이 있어야 합니다.",
    ),
    (
        "scope_node_closed",
        "종료된 법인이나 사업장에는 권한을 줄 수 없습니다.",
    ),
    (
        "access_request_note_required",
        "기타를 고르면 사유를 적어 주십시오.",
    ),
    ("access_request_not_found", "권한 요청을 찾을 수 없습니다."),
    ("access_request_closed", "이미 처리된 권한 요청입니다."),
];

/// Server-authored org-change `reason` strings (legacy org-setup drafts).
const STATUS_LABELS: &[(&str, &str)] = &[
    ("ACTIVE", "재직"),
    ("ON_LEAVE", "휴직"),
    ("EXITED", "퇴사"),
    ("UNKNOWN", "확인 필요"),
];

const EVENT_LABELS: &[(&str, &str)] = &[
    ("TRANSFER", "전보"),
    ("PROMOTE", "승진"),
    ("LEAVE_OF_ABSENCE", "휴직"),
    ("RETURN_FROM_LEAVE", "복직"),
    ("CONTRACT_RENEWAL", "계약 갱신"),
    ("TERMINATE", "퇴사"),
];

const SIGNOFF_LABELS: &[(&str, &str)] = &[
    ("privacy_notice_ack", "개인정보 처리 고지 확인"),
    ("korean_labor_law_ack", "근로기준법 검토 확인"),
    ("payroll_cutoff_ack", "급여 마감 확인"),
    ("retirement_settlement_ack", "퇴직금 정산 확인"),
];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// The Korean message for an error `code` + English `message`.
#[must_use]
pub fn korean_message(code: &str, message: &str) -> String {
    if let Some(ko) = MESSAGES.iter().find_map(|part| lookup(part, message)) {
        return ko.to_owned();
    }
    // "{ack} is required for {event_type}" (hr lifecycle signoff gate).
    if code == "lifecycle_signoff_required"
        && let Some((ack, event)) = message.split_once(" is required for ")
        && let Some(label) = lookup(SIGNOFF_LABELS, ack)
    {
        return format!("{event} 이벤트에는 {label}({ack})이 필요합니다.");
    }
    // "the employee will be {STATUS} from {date} by the scheduled {EVENT}".
    if code == "lifecycle_scheduled_state"
        && let Some(rest) = message.strip_prefix("the employee will be ")
        && let Some((status, rest)) = rest.split_once(" from ")
        && let Some((date, event)) = rest.split_once(" by the scheduled ")
        && let (Some(status), Some(event)) =
            (lookup(STATUS_LABELS, status), lookup(EVENT_LABELS, event))
    {
        return format!(
            "{date}부터 예약된 {event}에 따라 {status} 상태가 되므로 이 인사 이벤트를 기록할 수 없습니다."
        );
    }
    // "{n} scheduled lifecycle events would no longer apply after this change; …".
    if code == "lifecycle_schedule_conflict"
        && let Some((count, _)) =
            message.split_once(" scheduled lifecycle events would no longer apply")
    {
        return format!(
            "이 변경 뒤에는 예약된 인사 이벤트 {count}건을 적용할 수 없습니다. 해당 예약을 먼저 취소하거나 고쳐 주십시오."
        );
    }
    // "{domain} period {start}..{end} is locked; write dated {from}..{to} refused".
    if let Some((_, rest)) = message.split_once(" period ")
        && let Some((period, rest)) = rest.split_once(" is locked; write dated ")
        && let Some(dates) = rest.strip_suffix(" refused")
    {
        let range = |text: &str| text.replace("..", "~");
        return format!(
            "{} 기간이 마감되어 {} 날짜로는 기록할 수 없습니다.",
            range(period),
            range(dates)
        );
    }
    // `unknown role "WIZARD"` (role keys in user writes and directory filters).
    if let Some(role) = message.strip_prefix("unknown role ") {
        return format!("알 수 없는 역할입니다: {role}");
    }
    lookup(CODES, code)
        .unwrap_or("요청을 처리하지 못했습니다.")
        .to_owned()
}

/// Whether `Accept-Language` ranks Korean strictly above every other listed
/// language (q-values honoured; a missing q is 1).
pub fn prefers_korean(headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let mut best: Option<(bool, f32)> = None;
    for part in value.split(',') {
        let mut pieces = part.split(';');
        let tag = pieces.next().unwrap_or("").trim().to_ascii_lowercase();
        if tag.is_empty() {
            continue;
        }
        let q = pieces
            .find_map(|p| p.trim().strip_prefix("q="))
            .and_then(|q| q.trim().parse::<f32>().ok())
            .unwrap_or(1.0);
        let is_ko = tag == "ko" || tag.starts_with("ko-");
        if best.is_none_or(|(_, bq)| q > bq) {
            best = Some((is_ko, q));
        }
    }
    best.is_some_and(|(is_ko, q)| is_ko && q > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lang(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_LANGUAGE, value.parse().unwrap());
        headers
    }

    #[test]
    fn korean_preference_honours_q_values() {
        assert!(prefers_korean(&lang("ko")));
        assert!(prefers_korean(&lang("ko-KR,ko;q=0.9,en;q=0.8")));
        assert!(prefers_korean(&lang("en;q=0.5, ko;q=0.9")));
        assert!(!prefers_korean(&lang("en-US,en;q=0.9,ko;q=0.8")));
        assert!(!prefers_korean(&lang("ko;q=0")));
        assert!(!prefers_korean(&HeaderMap::new()));
    }

    #[test]
    fn messages_resolve_exact_then_pattern_then_code() {
        assert_eq!(
            korean_message("validation", "Idempotency-Key header is required"),
            "Idempotency-Key 헤더가 필요합니다."
        );
        assert_eq!(
            korean_message(
                "lifecycle_signoff_required",
                "payroll_cutoff_ack is required for TERMINATE"
            ),
            "TERMINATE 이벤트에는 급여 마감 확인(payroll_cutoff_ack)이 필요합니다."
        );
        assert_eq!(
            korean_message("not_found", "something new"),
            "대상을 찾을 수 없습니다."
        );
        assert_eq!(
            korean_message("bad_request", "something new"),
            "요청 형식이 올바르지 않습니다."
        );
        assert_eq!(
            korean_message(
                "transfer_cross_entity",
                "a transfer stays inside the employee's 법인; moving to another 법인 is a 전적"
            ),
            "다른 법인으로는 전보할 수 없습니다. 법인 간 이동은 전적으로 합니다."
        );
        assert_eq!(
            korean_message(
                "lifecycle_scheduled_state",
                "the employee will be EXITED from 2026-11-10 by the scheduled TERMINATE"
            ),
            "2026-11-10부터 예약된 퇴사에 따라 퇴사 상태가 되므로 이 인사 이벤트를 기록할 수 없습니다."
        );
        assert_eq!(
            korean_message(
                "lifecycle_schedule_conflict",
                "2 scheduled lifecycle events would no longer apply after this change; cancel or change them first"
            ),
            "이 변경 뒤에는 예약된 인사 이벤트 2건을 적용할 수 없습니다. 해당 예약을 먼저 취소하거나 고쳐 주십시오."
        );
        assert_eq!(
            korean_message(
                "conflict",
                "hr period 2026-09-01..2026-09-30 is locked; write dated 2026-09-15..2026-09-15 refused"
            ),
            "2026-09-01~2026-09-30 기간이 마감되어 2026-09-15~2026-09-15 날짜로는 기록할 수 없습니다."
        );
        assert_eq!(
            korean_message("validation", "unknown role \"WIZARD\""),
            "알 수 없는 역할입니다: \"WIZARD\""
        );
    }

    /// OD-8 freeze: every English key recorded at the move still resolves.
    /// Lines may be added to `frozen_keys.rs`, never removed or reworded.
    #[test]
    fn frozen_english_keys_still_resolve() {
        let mut table: Option<&str> = None;
        let mut checked = 0;
        for line in frozen_keys::FROZEN_KEYS.lines() {
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                table = Some(name);
                continue;
            }
            let hit = match table {
                Some("MESSAGES") => MESSAGES.iter().any(|part| lookup(part, line).is_some()),
                Some("CODES") => lookup(CODES, line).is_some(),
                Some("STATUS_LABELS") => lookup(STATUS_LABELS, line).is_some(),
                Some("EVENT_LABELS") => lookup(EVENT_LABELS, line).is_some(),
                Some("SIGNOFF_LABELS") => lookup(SIGNOFF_LABELS, line).is_some(),
                other => panic!("unknown table {other:?} in frozen_keys.rs"),
            };
            assert!(hit, "frozen error_i18n key disappeared: {line:?}");
            checked += 1;
        }
        assert!(checked >= 197, "frozen_keys.rs lost lines: {checked}");
    }
}
