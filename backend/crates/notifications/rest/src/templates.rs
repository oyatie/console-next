// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::http::HeaderMap;
use console_notifications_application::NotificationSummary;
use console_platform_request_context::error_i18n::prefers_korean;

pub(super) fn localize(notice: &mut NotificationSummary, headers: &HeaderMap) {
    if notice.category == "org_change.sole_holder" {
        notice.text = render(&notice.text, prefers_korean(headers)).to_owned();
    }
}

fn render(key: &str, korean: bool) -> &str {
    match (key, korean) {
        ("org_change.sole_holder.recorded.v1", true) => {
            "단독 권한 보유자가 본인 확인 후 조직 변경의 결재 단계를 승인했습니다. 사후 검토가 필요합니다."
        }
        ("org_change.sole_holder.recorded.v1", false) => {
            "The sole permission holder verified their identity and approved an organization change step. A follow-up review is required."
        }
        _ => key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sole_holder_template_has_both_locales_and_preserves_other_bodies() {
        assert!(render("org_change.sole_holder.recorded.v1", true).contains("사후 검토"));
        assert!(render("org_change.sole_holder.recorded.v1", false).contains("follow-up review"));
        assert_eq!(render("Existing notice", true), "Existing notice");
    }
}
