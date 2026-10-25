use super::filing_validation::{RecordFiling, from_rule, invalid, validate};
use super::filings::load;
use super::refusal;
use super::{FilingQuery, FilingTask};
use crate::digest::sha256_hex;
use crate::idempotency::{idempotency_key_reused, normalize_idempotency_key};
use crate::{HrError, HrService};
use console_compliance_domain::statutory::{
    StatutoryRegister,
    filing::{FilingAnchors, resolution},
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

impl HrService {
    pub async fn record_insurance_filing(
        &self,
        principal: Principal,
        target: (Uuid, String, String),
        key: String,
        mut body: RecordFiling,
        register: StatutoryRegister,
    ) -> Result<FilingTask, HrError> {
        let (event, kind, insurer) = target;
        let key = normalize_idempotency_key(key)?;
        let org = principal.org_id;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| Box::pin(async move {
            let result = write(tx, &principal, (event, &kind, &insurer), &key, &mut body, &register).await;
            let (action, snapshot) = match &result {
                Ok(task) => ("insurance_filing.recorded", json!({"insurer": insurer, "kind": kind, "action": body.action, "version": task.version})),
                Err(error) if error.status != StatusCode::INTERNAL_SERVER_ERROR => ("insurance_filing.refused", json!({"code": error.code, "insurer": insurer, "kind": kind})),
                Err(_) => return result.map(|t| (Ok(t), Vec::new())),
            };
            let audit = AuditEvent::new(Some(principal.user_id), AuditAction::new(action)?, "insurance_filing", event.to_string(), TraceContext::generate(), OffsetDateTime::now_utc())
                .with_org(org).with_snapshots(None, Some(snapshot));
            Ok((result, vec![audit]))
        })).await?
    }
}

async fn write(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    target: (Uuid, &str, &str),
    key: &str,
    body: &mut RecordFiling,
    register: &StatutoryRegister,
) -> Result<FilingTask, HrError> {
    let (event, kind, insurer) = target;
    let today =
        super::filing_read::source_today(tx.as_mut(), *p.org_id.as_uuid(), event, kind).await?;
    validate(body, insurer, today)?;
    // Serialize retries across tabs, even when the reused key targets another task.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("filing:{}:{}:{key}", p.org_id, p.user_id))
        .execute(tx.as_mut())
        .await?;
    let hash = sha256_hex(
        &serde_json::to_vec(
            &json!({"event": event, "kind": kind, "insurer": insurer, "body": body}),
        )
        .map_err(|_| HrError::internal("filing fingerprint failed"))?,
    );
    let replay = sqlx::query("SELECT request_hash, version, action, completed_on::text AS completed_on, receipt_number, loss_code, detail,not_applicable_reason,applicability_facts,total_remuneration_won \
        FROM insurance_filing_records WHERE org_id = $1 AND actor = $2 AND idempotency_key = $3")
        .bind(p.org_id.as_uuid()).bind(p.user_id.as_uuid()).bind(key).fetch_optional(tx.as_mut()).await?;
    if replay
        .as_ref()
        .is_some_and(|r| r.get::<String, _>("request_hash") != hash)
    {
        return Err(idempotency_key_reused());
    }
    // The event row is the common lock for all receipts and lifecycle withdrawal.
    sqlx::query(
        "SELECT id FROM employee_lifecycle_events WHERE org_id=$1 AND (id=$2 OR id=(SELECT source_event_id FROM insurance_filing_requests WHERE org_id=$1 AND id=$2)) FOR UPDATE",
    )
    .bind(p.org_id.as_uuid())
    .bind(event)
    .fetch_optional(tx.as_mut())
    .await?;
    let query = || FilingQuery {
        event_id: Some(event),
        kind: Some(kind.to_owned()),
        insurer: Some(insurer.to_owned()),
        ..FilingQuery::default()
    };
    let mut task = load(tx, p, query(), register)
        .await?
        .items
        .into_iter()
        .next()
        .ok_or_else(|| {
            refusal(
                StatusCode::CONFLICT,
                "filing_event_inactive",
                "The lifecycle event is no longer active or in scope; reload the filing list.",
            )
        })?;
    crate::own_record::own_record_guard(
        tx,
        p.org_id,
        p.user_id,
        task.employee_id,
        Feature::EmployeeDirectoryManage,
    )
    .await?;
    if let Some(replay) = replay {
        task.version = replay.try_get("version")?;
        task.completed_on = replay.try_get("completed_on")?;
        task.receipt_number = replay.try_get("receipt_number")?;
        task.loss_code = replay.try_get("loss_code")?;
        task.detail = replay.try_get("detail")?;
        task.total_remuneration_won = replay.try_get("total_remuneration_won")?;
        task.not_applicable_reason = replay
            .try_get::<Option<String>, _>("not_applicable_reason")?
            .map(|s| serde_json::from_value(json!(s)))
            .transpose()
            .map_err(|_| HrError::internal("invalid stored filing reason"))?;
        let action: String = replay.try_get("action")?;
        task.state =
            resolution::state(Some(&action), &task.applicability, task.state == "COVERED").into();
        task.record_action = Some(action);
        return Ok(task);
    }
    if body.expected_version != task.version {
        return Err(refusal(
            StatusCode::CONFLICT,
            "filing_stale",
            "This filing record changed; reload it and compare the completion evidence before retrying.",
        ));
    }
    if task.state == "LEGAL_REVIEW" {
        return Err(refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "filing_rule_unverified",
            "The filing rule awaits legal review; no processing record can be made yet.",
        ));
    }
    if body
        .applicability_facts
        .as_ref()
        .is_some_and(|f| f.birth_date.is_some() || f.monthly_income_won.is_some())
    {
        crate::authz::authorize_hr_org_wide(p, Feature::EmployeeDirectoryManage)?;
    }
    if body
        .applicability_facts
        .as_ref()
        .and_then(|f| f.birth_date.as_deref())
        .is_some_and(|b| {
            task.birth_date_for_assessment
                .as_deref()
                .is_some_and(|known| known != b)
        })
    {
        return Err(refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "filing_applicability_unverified",
            "Correct the employee birth date before changing its filing assessment.",
        ));
    }
    let complete = body.action == "COMPLETE";
    if body.action == "UNDO" && task.version == 0
        || body.action != "UNDO"
            && task
                .record_action
                .as_deref()
                .is_some_and(|a| ["COMPLETE", "NOT_APPLICABLE"].contains(&a))
    {
        return Err(invalid(
            "This filing already has that state; reload the filing list.",
        ));
    }
    let on = parse_yyyy_mm_dd(&task.effective_date)?;
    let mut facts = body
        .applicability_facts
        .clone()
        .unwrap_or_else(|| task.applicability_facts.clone());
    facts.birth_date = task.birth_date_for_assessment.clone().or(facts.birth_date);
    let anchors = FilingAnchors {
        effective_date: Some(on),
        acquire_date: if kind == "ACQUIRE" {
            Some(on)
        } else {
            task.acquired_on
                .as_deref()
                .map(parse_yyyy_mm_dd)
                .transpose()?
                .or(Some(on))
        },
        loss_date: task.basis.as_ref().map(|r| r.loss_on(on)).transpose()?,
        exit_date: Some(on),
        request_date: Some(on),
        work_month: Some(on),
    };
    if body.action == "NOT_APPLICABLE" {
        let rule = task.basis.as_ref().ok_or_else(|| {
            refusal(
                StatusCode::UNPROCESSABLE_ENTITY,
                "filing_not_applicable_invalid",
                "Choose a not-applicable ground cited for this insurer and date.",
            )
        })?;
        let reason = body.not_applicable_reason.ok_or_else(|| {
            refusal(
                StatusCode::UNPROCESSABLE_ENTITY,
                "filing_not_applicable_invalid",
                "Choose a not-applicable ground cited for this insurer and date.",
            )
        })?;
        resolution::validate_not_applicable(rule, &anchors, &facts, reason).map_err(from_rule)?;
    }
    if complete {
        let completed = parse_yyyy_mm_dd(body.completed_on.as_deref().unwrap_or_default())?;
        let opens = task
            .opens_on
            .as_deref()
            .map(parse_yyyy_mm_dd)
            .transpose()?
            .ok_or_else(|| {
                invalid("The filing opening is unverified; confirm the statutory rule.")
            })?;
        if let Some(rule) = &task.basis {
            resolution::validate_completion(
                rule,
                &anchors,
                &facts,
                completed,
                opens,
                body.total_remuneration_won,
            )
            .map_err(from_rule)?;
        }
        if let Some(code) = &body.loss_code {
            let option = task
                .loss_options
                .iter()
                .find(|o| &o.code == code)
                .ok_or_else(|| {
                    invalid(
                        "Choose a loss code from the statutory register for this insurer and date.",
                    )
                })?;
            if option.requires_detail && body.detail.is_none() {
                return Err(invalid(
                    "This loss code requires a specific reason; enter the loss reason detail.",
                ));
            }
        } else if ["LOSE", "AGE60"].contains(&task.kind.as_str()) && !task.loss_options.is_empty() {
            return Err(invalid(
                "Choose the filed loss code from the statutory register.",
            ));
        }
    }
    let reason = body
        .not_applicable_reason
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| HrError::internal("filing reason encoding failed"))?
        .and_then(|v| v.as_str().map(str::to_owned));
    let facts = body
        .applicability_facts
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| HrError::internal("filing facts encoding failed"))?;
    let version = task
        .version
        .checked_add(1)
        .ok_or_else(|| HrError::internal("filing version exhausted"))?;
    let receipt: Uuid = sqlx::query_scalar("INSERT INTO insurance_filing_records (org_id,event_id,request_id,filing_kind,insurer,version,action,completed_on,receipt_number,loss_code,detail,actor,idempotency_key,request_hash,not_applicable_reason,applicability_facts,total_remuneration_won) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id")
        .bind(p.org_id.as_uuid()).bind(if task.is_request {None}else{Some(event)}).bind(if task.is_request {Some(event)}else{None})
        .bind(kind).bind(insurer).bind(version).bind(&body.action).bind(&body.completed_on).bind(&body.receipt_number).bind(&body.loss_code).bind(&body.detail)
        .bind(p.user_id.as_uuid()).bind(key).bind(hash).bind(&reason).bind(facts).bind(body.total_remuneration_won).fetch_one(tx.as_mut()).await?;
    crate::cases::observe::filing(
        tx,
        *p.org_id.as_uuid(),
        (event, kind, insurer),
        receipt,
        &body.action,
        reason.as_deref(),
    )
    .await?;
    task = load(tx, p, query(), register)
        .await?
        .items
        .into_iter()
        .next()
        .ok_or_else(|| HrError::internal("recorded filing disappeared"))?;
    Ok(task)
}
