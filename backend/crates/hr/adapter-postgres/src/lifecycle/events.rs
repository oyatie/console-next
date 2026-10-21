//! HrService::{lifecycle_events, record_lifecycle_event}: handler bodies moved
//! verbatim from `app/src/hr.rs` (R2-life). The handlers keep the manage gate
//! and the Idempotency-Key header ahead of the call.

use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::with_audits;
use console_platform_request_context::error_i18n::korean_message;
use serde_json::{Value, json};
use uuid::Uuid;

use super::events_page::{LifecycleEventsQuery, encode_events_cursor};
use super::fixed_term::check_fixed_term_renewal;
use super::group_transfer::{normalize_group_transfer, record_group_transfer_act};
use super::guards::check_record_guards;
use super::normalize::normalize_lifecycle_transition;
use super::prepare::prepare_lifecycle_event;
use super::record::{load_lifecycle_event, record_lifecycle_event_tx};
use super::requests::{CreateEmployeeLifecycleEventRequest, EmployeeLifecycleEventPage};
use super::rows::employee_lifecycle_event_from_row;
use super::title_reason::validate_lifecycle_reason;
use crate::authz::{
    APPOINTMENT_KEYS, authorize_hr_person, authorize_hr_person_any, authorize_hr_place_any,
    hr_may_person, hr_reach, hr_reach_any,
};
use crate::clock::today_kst;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::exits::group_transfer_case::{sending_branch, withdraw_settlement_case};
use crate::idempotency::idempotency_key_reused;
use crate::metrics::record_hr_read;
use crate::{HrError, HrService, lifecycle_event_select};

impl HrService {
    pub async fn lifecycle_events(
        &self,
        principal: Principal,
        employee_id: Uuid,
        query: LifecycleEventsQuery,
        korean: bool,
    ) -> Result<EmployeeLifecycleEventPage, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryRead)?;
        let page = query.page()?;
        record_hr_read("lifecycle_events");
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let reader = principal.clone();

        let (head_version, items, manager) =
            with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    // AX-5: the history of a person inside the reader's grant set.
                    let read = Feature::EmployeeDirectoryRead;
                    authorize_hr_person(tx, &reader, read, employee_id).await?;
                    let manage = Feature::EmployeeDirectoryManage;
                    let manager = hr_may_person(tx, &reader, manage, employee_id).await?;
                    // Keep missing employees distinguishable from an employee with no
                    // lifecycle events, without returning raw employee/import data;
                    // the version pin (BW-11) is the only head field read.
                    let head_version: i32 = sqlx::query_scalar(
                        "SELECT head_version FROM employees WHERE org_id = $1 AND id = $2",
                    )
                    .bind(org_uuid)
                    .bind(employee_id)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| {
                        HrError::from_kernel(KernelError::not_found("employee not found"))
                    })?;
                    let me = actor_employee_id(tx, &reader).await?;
                    let history = DirectoryAccess::LifecycleHistory;
                    let event = access_event(&reader, history, &[employee_id], me, json!({}))?;

                    let items = sqlx::query(lifecycle_event_select!(
                        "WHERE l.org_id = $1 AND l.employee_id = $2 \
                 AND ($3::timestamptz IS NULL OR (l.created_at, l.id) < ($3, $4)) \
                 ORDER BY l.created_at DESC, l.id DESC LIMIT $5"
                    ))
                    .bind(org_uuid)
                    .bind(employee_id)
                    .bind(page.before.map(|(at, _)| at))
                    .bind(page.before.map(|(_, id)| id))
                    // One extra row tells whether an older page exists.
                    .bind(page.limit + 1)
                    .fetch_all(tx.as_mut())
                    .await?
                    .into_iter()
                    .map(employee_lifecycle_event_from_row)
                    .collect::<Result<Vec<_>, HrError>>()?;
                    Ok(((head_version, items, manager), vec![event]))
                })
            })
            .await?;
        let mut items = items;
        let page_rows = usize::try_from(page.limit).unwrap_or(1);
        let next_cursor = if items.len() > page_rows {
            items.truncate(page_rows);
            items
                .last()
                .map(|last| encode_events_cursor(last.created_at, last.id))
        } else {
            None
        };
        let items = items
            .into_iter()
            .map(|mut item| {
                // An APPLY_FAILED reason reads like any error message: Korean
                // when the caller prefers it.
                if korean
                    && let (Some(code), Some(reason)) = (&item.failure_code, &item.failure_reason)
                {
                    item.failure_reason = Some(korean_message(code, reason));
                }
                if manager {
                    item
                } else {
                    item.redact_for_reader()
                }
            })
            .collect();

        Ok(EmployeeLifecycleEventPage {
            items,
            head_version,
            next_cursor,
        })
    }

    pub async fn record_lifecycle_event(
        &self,
        principal: Principal,
        employee_id: Uuid,
        idempotency_key: String,
        mut body: CreateEmployeeLifecycleEventRequest,
    ) -> Result<Value, HrError> {
        hr_reach_any(&principal, &APPOINTMENT_KEYS)?;
        let fingerprint = json!({ "employee_id": employee_id, "body": &body });

        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        let exception_id = body.exception_id;
        let guards = body.guards.clone();
        let facts = normalize_group_transfer(
            body.group_transfer.take(),
            &body.event_type,
            &body.effective_date,
        )?;
        let transition = normalize_lifecycle_transition(body)?;
        if exception_id.is_some() && transition.event_type != "CONTRACT_RENEWAL" {
            return Err(HrError::validation(
                "exception_id is only allowed for CONTRACT_RENEWAL",
            ));
        }
        let today = today_kst();

        let item = with_audits::<_, _, HrError>(&self.pool, org, |tx| {
            Box::pin(async move {
                // AX-5: the person, and any place they move to, inside the
                // grant set of a 발령 key.
                authorize_hr_person_any(tx, &principal, &APPOINTMENT_KEYS, employee_id).await?;
                if transition.to_workplace_id.is_some() || transition.to_org_unit_id.is_some() {
                    let place = (None, transition.to_workplace_id, transition.to_org_unit_id);
                    authorize_hr_place_any(tx, &principal, &APPOINTMENT_KEYS, place).await?;
                }
                const OPERATION: &str = "employee.lifecycle.create";
                match claim_idempotency_key(tx, OPERATION, &idempotency_key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => return Ok((response, vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
                validate_lifecycle_reason(tx, org, &transition).await?;
                let mut prepared =
                    prepare_lifecycle_event(tx, org_uuid, employee_id, transition, today).await?;
                check_record_guards(tx, org, employee_id, &mut prepared, &guards).await?;
                if prepared.transition.event_type == "CONTRACT_RENEWAL" {
                    check_fixed_term_renewal(
                        tx,
                        org_uuid,
                        employee_id,
                        &prepared.transition,
                        exception_id,
                    )
                    .await?;
                }
                let branch = if facts.is_some() {
                    sending_branch(tx, org_uuid, employee_id).await?
                } else {
                    None
                };
                let (mut item, event) =
                    record_lifecycle_event_tx(tx, org, actor, employee_id, &prepared, None).await?;
                let mut events = vec![event];
                if let (Some(facts), Some(to)) = (&facts, prepared.target.workplace) {
                    // A scheduled 전적 replaced on its date takes its settlement case with it.
                    if let Some(replaced) = prepared.replaces {
                        let reason = &prepared.transition.comment;
                        events.extend(
                            withdraw_settlement_case(tx, (org, actor), replaced, reason).await?,
                        );
                    }
                    let who = (org, actor);
                    let (_, audits) = record_group_transfer_act(
                        tx,
                        who,
                        (employee_id, item.id),
                        &item.effective_date,
                        to,
                        facts,
                        branch,
                        &prepared.transition.comment,
                    )
                    .await?;
                    events.extend(audits);
                    item = load_lifecycle_event(tx, org_uuid, item.id).await?;
                }
                let response = serde_json::to_value(&item)
                    .map_err(|_| HrError::internal("response serialization failed"))?;
                complete_idempotency_key(tx, OPERATION, &idempotency_key, &response).await?;
                Ok((response, events))
            })
        })
        .await?;

        Ok(item)
    }
}
