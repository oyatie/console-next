//! `POST /change-requests/{id}/decide`: a second HR person applies or declines
//! (the named assignee answers an answer kind); the requester withdraws. The
//! requester never decides (domain rule, DB CHECK).

use console_hr_domain::requests::{
    ChangeRequestDecision, ChangeRequestKind, CloseRefusal, check_close, validate_answer,
};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::cedar::{DecideFacts, enforce_change_request_decide};
use super::read::change_request_from_row;
use super::{ChangeRequestResponse, DecideChangeRequest, note, reason_code, refusal};
use crate::authz::{HrReach, hr_reach, person_in_reach};
use crate::corrections::{SecondPersonContext, apply_requested_correction_in_tx};
use crate::{HrError, HrService, change_request_columns};

fn close_refusal(refused: CloseRefusal) -> HrError {
    match refused {
        CloseRefusal::AlreadyClosed => refusal(
            StatusCode::CONFLICT,
            "change_request_closed",
            "the change request is already closed",
        ),
        CloseRefusal::SelfDecision => refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "change_request_self_decision",
            "the requester cannot decide their own change request",
        ),
        CloseRefusal::NotRequester => refusal(
            StatusCode::FORBIDDEN,
            "change_request_not_requester",
            "only the requester can withdraw a change request",
        ),
        CloseRefusal::NotAssignee => refusal(
            StatusCode::FORBIDDEN,
            "change_request_not_assignee",
            "the change request is assigned to another person",
        ),
    }
}

impl HrService {
    pub async fn decide_change_request(
        &self,
        principal: Principal,
        request_id: Uuid,
        body: DecideChangeRequest,
        holders: SecondPersonContext,
    ) -> Result<ChangeRequestResponse, HrError> {
        let decision = ChangeRequestDecision::parse(body.decision.trim())?;
        // Apply and decline are the HR tier's, except that the named assignee
        // answers an answer kind; withdrawing is the requester's. Outside HR
        // the row decides (below), so a named 취급자 is never a dead end.
        let reach = hr_reach(&principal, Feature::EmployeeDirectoryManage).ok();
        let reason = reason_code(&body.reason_code, "reason_code")?;
        let note = note(body.note.as_deref())?;
        let me = *principal.user_id.as_uuid();
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(concat!(
                    "SELECT ",
                    change_request_columns!(),
                    " FROM change_requests WHERE org_id = $1 AND id = $2 FOR UPDATE"
                ))
                .bind(org_uuid)
                .bind(request_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(not_found)?;
                let current = change_request_from_row(&row)?;
                let kind = ChangeRequestKind::parse(&current.kind)?;
                // AX-5: HR decides a request about a person inside its grant
                // set (the whole tenant for any other subject).
                let hr = match &reach {
                    Some(HrReach::All) => true,
                    Some(reach) if current.subject_type == "EMPLOYEE" => {
                        person_in_reach(tx, reach, current.subject_id).await?
                    }
                    _ => false,
                };
                // Outside HR a caller sees only requests it filed or is named on.
                let named = current.assignee_user_id == Some(me);
                if !hr && current.requested_by != me && !named {
                    return Err(not_found());
                }
                // Who may apply or decline is Cedar's; withdrawal is the
                // requester's own act (check_close). A caller without the
                // permission is refused before the close rules, a holder after
                // them, so self-decision keeps its own 422 code.
                let decides = decision != ChangeRequestDecision::Withdraw;
                let holds = hr || (named && kind.answered_by_assignee());
                let cedar = || {
                    let facts = DecideFacts {
                        actor_is_requester: current.requested_by == me,
                        actor_holds_permission: holds,
                        holders,
                        step_up: false,
                        is_apply: decision == ChangeRequestDecision::Apply,
                    };
                    enforce_change_request_decide(
                        &principal,
                        "change_request",
                        request_id.to_string(),
                        facts,
                    )
                };
                if decides && !holds {
                    cedar()?;
                }
                check_close(
                    &current.status,
                    current.requested_by,
                    current.assignee_user_id,
                    me,
                    decision,
                )
                .map_err(close_refusal)?;
                validate_answer(kind, decision, note.as_deref())?;
                if decides && holds {
                    cedar()?;
                }
                // Kinds with something to carry out apply it in this transaction.
                let mut events = if decision == ChangeRequestDecision::Apply {
                    apply_requested_correction_in_tx(tx, &principal, &current).await?
                } else {
                    Vec::new()
                };
                let decided = decision != ChangeRequestDecision::Withdraw;
                let row = sqlx::query(concat!(
                    "UPDATE change_requests SET status = $3, decided_by = $4, \
                     decision_reason_code = $5, decision_note = $6, decided_at = now() \
                     WHERE org_id = $1 AND id = $2 RETURNING ",
                    change_request_columns!()
                ))
                .bind(org_uuid)
                .bind(request_id)
                .bind(decision.closed_status())
                .bind(decided.then_some(me))
                .bind(decided.then_some(reason.as_str()))
                .bind(note.as_deref())
                .fetch_one(tx.as_mut())
                .await?;
                let closed = change_request_from_row(&row)?;
                let event = AuditEvent::new(
                    Some(principal.user_id),
                    AuditAction::new("change_request.decide").map_err(HrError::from_kernel)?,
                    "change_request",
                    closed.id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    Some(json!({ "status": &current.status })),
                    Some(json!({
                        "status": &closed.status,
                        "kind": &closed.kind,
                        "reason_code": reason,
                        "requested_by": closed.requested_by,
                    })),
                );
                events.push(event);
                Ok((closed, events))
            })
        })
        .await
    }
}

fn not_found() -> HrError {
    HrError::from_kernel(KernelError::not_found(
        "change request was not found in this organization",
    ))
}
