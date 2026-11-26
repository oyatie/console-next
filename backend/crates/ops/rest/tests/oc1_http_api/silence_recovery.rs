// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[tokio::test]
async fn applied_silence_returns_id_and_audit_reference_when_final_append_fails() -> TestResult {
    use console_ops_application::alert_actions::{SilenceAuditRecord, SilenceAuditStore};
    use console_ops_application::obligations::{Context, Error};
    use std::sync::Arc;

    struct RejectOutcome(Arc<dyn SilenceAuditStore>);
    impl SilenceAuditStore for RejectOutcome {
        fn list_records(&self) -> Result<Vec<SilenceAuditRecord>, Error> {
            self.0.list_records()
        }

        fn record_event(
            &self,
            action: &str,
            id: Option<&str>,
            group: Option<&str>,
            detail: Option<&str>,
            ctx: &Context,
        ) -> Result<SilenceAuditRecord, Error> {
            if matches!(action, "silence_created" | "silence_expired") {
                return Err(Error::WriteFailed);
            }
            self.0.record_event(action, id, group, detail, ctx)
        }
    }

    let mut h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;
    let store = h
        .state
        .silence_store
        .clone()
        .ok_or("missing silence store")?;
    h.state.silence_store = Some(Arc::new(RejectOutcome(store.clone())));
    h.app = console_ops_rest::router(h.state.clone(), None);
    let (status, created) = post_silence(
        &h,
        "HighLatency",
        1,
        "Maintenance window",
        Some(&h.page_key),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["silence_id"]
        .as_str()
        .ok_or("missing upstream ID")?;
    let request_ref = created["audit_recovery_ref"]
        .as_str()
        .ok_or("missing create reference")?;
    {
        let writes = h
            .am_writer
            .created
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(writes.len(), 1);
        assert!(writes[0].comment.ends_with(&format!("[{request_ref}]")));
    }

    let (status, _, expired) = send_json(
        &h.app,
        req_delete(&format!("/api/ops/v1/silences/{id}"), &h.operator_jwt),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{expired}");
    assert_eq!(expired["deleted"], true);
    assert_eq!(expired["silence_id"], id);
    let expire_ref = expired["audit_recovery_ref"]
        .as_str()
        .ok_or("missing expire reference")?;
    let requests = store.list_records().map_err(|e| format!("{e:?}"))?;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].action, "silence_requested");
    assert_eq!(requests[0].support_ref, request_ref);
    assert_eq!(requests[1].action, "silence_expire_requested");
    assert_eq!(requests[1].support_ref, expire_ref);
    assert_eq!(requests[1].silence_id.as_deref(), Some(id));
    Ok(())
}
