// SPDX-License-Identifier: LicenseRef-Proprietary
//! The approval document's decision: an adapter over the source's own
//! command, taken only where the document read offered it.
use super::document::{OPINION_MAX, missing, read, source_id};
use super::*;
use axum::response::{IntoResponse, Response};
use console_orgchange_domain::StepDecisionCommand;
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::ReasonDomain;
use serde_json::json;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Decision {
    Approve,
    Reject,
    Return,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DecisionRequest {
    decision: Decision,
    seen_fingerprint: String,
    #[serde(default)]
    opinion: String,
    reason_code: Option<String>,
    note: Option<String>,
}

/// What the decision will run with, settled in one snapshot with the read.
struct Admitted {
    request: Uuid,
    step: Uuid,
    command: StepDecisionCommand,
}

fn changed() -> KernelError {
    KernelError::conflict("the approval document changed after it was read")
        .with_code("approval_document_changed")
}

/// The opinion and a rejection's note in the step's one memo; neither is dropped.
fn memo(opinion: &str, note: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = [note.unwrap_or(""), opinion]
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

pub(super) async fn post(
    State(state): State<Approvals>,
    Extension(principal): Extension<Principal>,
    Path(key): Path<String>,
    Json(body): Json<DecisionRequest>,
) -> Response {
    match decide(state, principal, key, body).await {
        Ok(receipt) => Json(receipt).into_response(),
        Err(refusal) => *refusal,
    }
}

async fn decide(
    state: Approvals,
    principal: Principal,
    key: String,
    body: DecisionRequest,
) -> Result<Value, Box<Response>> {
    let refuse = |error: KernelError| Box::new(InboxError::from(error).into_response());
    let id = source_id(&key).ok_or_else(|| refuse(missing()))?;
    let reader = principal.clone();
    let admitted = console_platform_db::with_org_locking_snapshot::<_, _, crate::error::AppError>(
        &state.pool,
        principal.org_id,
        move |tx| Box::pin(async move { Ok(admit(tx, &reader, id, key, body).await) }),
    )
    .await
    .map_err(|error| refuse(db(error)))?
    .map_err(refuse)?;
    let approved = admitted.command.approved;
    // The snapshot is closed: the command takes its own locks and re-checks
    // authority, separation of duties, order and the version read above.
    let detail = console_orgchange_rest::decide_step_as(
        &state.org_changes,
        &principal,
        admitted.request,
        admitted.step,
        admitted.command,
    )
    .await
    .map_err(|refusal| {
        if refusal.code() == "lifecycle.refuse.stale_version" {
            refuse(changed())
        } else {
            Box::new(refusal.into_response())
        }
    })?;
    Ok(json!({
        "decision": if approved { "APPROVED" } else { "REJECTED" },
        "status": detail.summary.status.as_db(),
    }))
}

async fn admit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    id: Uuid,
    key: String,
    body: DecisionRequest,
) -> Result<Admitted, KernelError> {
    // Hidden or missing is the read's own 404, before any other refusal.
    let loaded = read(tx, principal, id, key).await?.ok_or_else(missing)?;
    if body.decision == Decision::Return {
        return Err(KernelError::validation(
            "decision: this document does not take a return",
        ));
    }
    if body.opinion.chars().count() > OPINION_MAX {
        return Err(KernelError::validation(format!(
            "opinion: at most {OPINION_MAX} characters"
        )));
    }
    if loaded.document["fingerprint"] != json!(body.seen_fingerprint) {
        return Err(changed());
    }
    let step = loaded.step.ok_or_else(|| {
        KernelError::conflict("this document is not awaiting your decision")
            .with_code("approval_decision_unavailable")
    })?;
    let approved = body.decision == Decision::Approve;
    let reason = if approved {
        None
    } else {
        let code = body
            .reason_code
            .as_deref()
            .ok_or_else(|| KernelError::validation("reason_code: a rejection names its reason"))?;
        Some(
            validate_reason_in_tx(
                tx.as_mut(),
                principal.org_id,
                ReasonDomain::OrgChangeReject,
                code,
                body.note.as_deref(),
            )
            .await?,
        )
    };
    Ok(Admitted {
        request: id,
        step,
        command: StepDecisionCommand {
            approved,
            memo: memo(
                &body.opinion,
                reason.as_ref().and_then(|r| r.note.as_deref()),
            ),
            expected_version: Some(loaded.version),
            reason_code: reason.map(|r| r.code),
            ..StepDecisionCommand::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::memo;

    #[test]
    fn the_memo_keeps_the_note_and_the_opinion() {
        assert_eq!(memo("", None), None);
        assert_eq!(
            memo(" 검토했습니다 ", None).as_deref(),
            Some("검토했습니다")
        );
        assert_eq!(memo("", Some("근거 없음")).as_deref(), Some("근거 없음"));
        assert_eq!(
            memo("다시 올려 주십시오", Some("근거 없음")).as_deref(),
            Some("근거 없음\n\n다시 올려 주십시오")
        );
    }
}
