// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::UserId;
use http::StatusCode;
use serde_json::json;
use uuid::Uuid;

use super::ApplyJob;
use crate::HrError;

#[test]
fn failed_jobs_store_only_safe_error_fields() {
    for (status, code) in [
        (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        (StatusCode::SERVICE_UNAVAILABLE, "import_apply_timed_out"),
        (StatusCode::FORBIDDEN, "import_apply_forbidden"),
        (StatusCode::CONFLICT, "rows_changed_since_preview"),
    ] {
        let error = HrError {
            status,
            code,
            message: "private database detail".into(),
            errors: None,
            refusals: Some(Box::new(json!([{"detail": "private refusal value"}]))),
        };
        let job = ApplyJob::queued(Uuid::new_v4(), "digest", UserId::new()).failed(&error);
        let stored = json!(job);
        assert_eq!(stored["state"], "failed");
        assert_eq!(stored["error"]["code"], code);
        assert!(stored["error"]["message"].is_string());
        let reference = stored["error"]["support_ref"].as_str().unwrap_or_default();
        assert_eq!(reference.len(), 32, "{stored}");
        assert!(!stored.to_string().contains("private"), "{stored}");
        assert_eq!(stored["error"].as_object().map(|e| e.len()), Some(3));
    }
}

#[tokio::test]
async fn failed_job_keeps_the_driver_support_reference() {
    let reference = console_kernel_core::TraceContext::generate()
        .trace_id()
        .to_owned();
    let job = crate::import::apply::with_apply_support_reference(reference.clone(), async {
        ApplyJob::queued(Uuid::new_v4(), "digest", UserId::new())
            .failed(&HrError::internal("private database detail"))
    })
    .await;
    assert_eq!(json!(job)["error"]["support_ref"], reference);
}

#[test]
fn legacy_job_diagnostics_are_redacted_when_read() -> Result<(), serde_json::Error> {
    let mut stored = json!(ApplyJob::queued(Uuid::new_v4(), "digest", UserId::new()));
    stored["state"] = "failed".into();
    stored["error"] = json!({
        "code": "internal", "message": "private database detail",
        "refusals": [{"detail": "private row value"}], "detail": "private context",
    });
    let job: ApplyJob = serde_json::from_value(stored)?;
    assert_eq!(
        json!(job)["error"],
        json!({
            "code": "internal", "message": "internal server error",
        })
    );
    Ok(())
}
