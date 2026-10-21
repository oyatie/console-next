// SPDX-License-Identifier: LicenseRef-Proprietary
//! Saved certificate responses are readable only under the domain's current scope.
use console_hr_adapter_postgres::HrService;
use console_platform_authz::Principal;
use console_platform_db::command_outcomes::CommandOutcome;
use console_platform_request_context::record_access::outcome::ReadFuture;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) fn handles(out: &CommandOutcome) -> bool {
    out.touched.as_array().is_some_and(|items| {
        !items.is_empty()
            && items.iter().all(|item| {
                matches!(
                    item.get("type").and_then(serde_json::Value::as_str),
                    Some("hr_certificate" | "hr_certificate_settings")
                )
            })
    })
}
pub(crate) fn read_outcome<'a>(
    pool: &'a PgPool,
    p: &'a Principal,
    out: &'a mut CommandOutcome,
) -> ReadFuture<'a> {
    Box::pin(async move {
        if !handles(out) {
            return super::statutory::read_outcome(pool, p, out).await;
        }
        let Some(items) = out.touched.as_array() else {
            return false;
        };
        let hr = HrService::new(pool.clone());
        for item in items {
            let Some(id) = item
                .get("id")
                .and_then(serde_json::Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok())
            else {
                return false;
            };
            let allowed = if item["type"] == "hr_certificate_settings" {
                id == *p.org_id.as_uuid() && hr.certificate_settings(p.clone()).await.is_ok()
            } else {
                hr.certificate(p.clone(), id).await.is_ok()
            };
            if !allowed {
                return false;
            }
        }
        true
    })
}
