// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{CompleteItem, LifecycleCase, refused};
use crate::{HrError, HrService};
use console_governance_adapter_postgres::{
    PgGovernanceError,
    exception::{GovernedWrite, consume_exception_conn, get_exception_conn},
};
use console_governance_domain::exception::{
    Attestation, AttestationDetails, RuleCode, RuleKind, SubjectType, validate_attestation,
};
use console_platform_authz::{
    Feature, Principal, access,
    cedar_pbac::actions::lifecycle_item::{self, ItemCompleteFacts},
};
use console_platform_db::with_audits;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(super) async fn holds_owner(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    case: Uuid,
    line: Option<&str>,
) -> Result<bool, HrError> {
    let Some((domain, level)) = line.and_then(|s| s.split_once('.')) else {
        return Ok(false);
    };
    for feature in Feature::ALL {
        if access::tag(feature).is_some_and(|(d, l)| d.as_str() == domain && l.as_str() == level)
            && super::access::may(tx, p, feature, case).await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObservedRef {
    table: ObservedTable,
    id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ObservedTable {
    EmployeeLifecycleEvents,
    InsuranceFilingRecords,
}

async fn evidence(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    c: &LifecycleCase,
    item: &super::CaseItem,
    body: &CompleteItem,
) -> Result<(), HrError> {
    if let Some(value) = body.observed_ref.clone() {
        let reference: ObservedRef = serde_json::from_value(value)
            .map_err(|_| refused("lifecycle.refuse.evidence_required"))?;
        let valid=match reference.table {
            ObservedTable::EmployeeLifecycleEvents if item.kind=="REC" && matches!(item.item_key.as_str(),"R1"|"X1"|"X2") => sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM employee_lifecycle_events l JOIN lifecycle_cases c ON c.org_id=l.org_id AND c.id=$4 LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id WHERE l.org_id=$1 AND l.id=$2 AND l.employee_id=$3 AND l.state='APPLIED' AND l.id=COALESCE(x.exit_lifecycle_event_id,c.trigger_id))")
                .bind(p.org_id.as_uuid()).bind(reference.id).bind(c.employee_id).bind(c.id).fetch_one(tx.as_mut()).await?,
            ObservedTable::InsuranceFilingRecords if item.kind=="FIL" => sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM filing_obligations f JOIN LATERAL (SELECT r.id,r.action FROM insurance_filing_records r WHERE r.org_id=f.org_id AND COALESCE(r.event_id,r.request_id)=f.event_id AND r.filing_kind=f.filing_kind AND r.insurer=f.insurer ORDER BY r.version DESC LIMIT 1) r ON true WHERE f.org_id=$1 AND r.id=$2 AND f.id=$3 AND r.action='COMPLETE')")
                .bind(p.org_id.as_uuid()).bind(reference.id).bind(item.filing_obligation_id).fetch_one(tx.as_mut()).await?,
            _ => false,
        };
        if !valid || body.waive || body.exception_id.is_some() || body.reason.is_some() {
            return Err(refused("lifecycle.refuse.evidence_required"));
        }
    } else if let Some(exception) = body.exception_id {
        let expected = if body.waive {
            item.waiver_rule_ref.as_deref()
        } else {
            item.completion_rule_ref.as_deref()
        }
        .and_then(|code| RuleCode::parse(code).ok())
        .ok_or_else(|| refused("lifecycle.refuse.evidence_required"))?;
        let stored = get_exception_conn(tx.as_mut(), exception)
            .await
            .map_err(governance)?
            .ok_or_else(|| refused("lifecycle.refuse.evidence_required"))?;
        let expected_kind = if body.waive {
            RuleKind::SoftRule
        } else {
            RuleKind::Fact
        };
        if stored.org_id != p.org_id
            || stored.subject_type != SubjectType::LifecycleCaseItem
            || stored.subject_id != item.id
            || stored.rule != expected
            || expected.kind() != expected_kind
        {
            return Err(refused("lifecycle.refuse.evidence_required"));
        }
        let payload = if body.waive {
            let reason = body
                .reason
                .as_deref()
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .ok_or_else(|| refused("lifecycle.refuse.evidence_required"))?;
            if stored.note.as_deref().map(str::trim) != Some(reason) {
                return Err(refused("lifecycle.refuse.evidence_required"));
            }
            json!({"item_id":item.id,"reason":reason})
        } else {
            attestation_payload(tx, p, exception, expected).await?
        };
        consume_exception_conn(
            tx.as_mut(),
            exception,
            &GovernedWrite {
                rule: expected,
                subject_type: SubjectType::LifecycleCaseItem,
                subject_id: item.id,
                payload: &payload,
                affected_periods: &[],
            },
        )
        .await
        .map_err(governance)?;
    } else {
        return Err(refused("lifecycle.refuse.evidence_required"));
    }
    Ok(())
}

async fn attestation_payload(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    exception: Uuid,
    fact: RuleCode,
) -> Result<Value, HrError> {
    let row = sqlx::query(
        "SELECT fact_date,evidence_ref,method_code,detail_code,new_due_date,amount_krw,reference,receipt_numbers,filer \
         FROM governed_exception_attestations WHERE org_id=$1 AND exception_id=$2",
    )
    .bind(p.org_id.as_uuid())
    .bind(exception)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| refused("lifecycle.refuse.evidence_required"))?;
    let attestation = Attestation {
        fact,
        fact_date: row.try_get("fact_date")?,
        details: AttestationDetails {
            evidence_ref: row.try_get("evidence_ref")?,
            method_code: row.try_get("method_code")?,
            detail_code: row.try_get("detail_code")?,
            new_due_date: row.try_get("new_due_date")?,
            amount_krw: row.try_get("amount_krw")?,
            reference: row.try_get("reference")?,
            receipt_numbers: row.try_get("receipt_numbers")?,
            filer: row.try_get("filer")?,
        },
    };
    validate_attestation(&attestation)
        .map_err(|_| refused("lifecycle.refuse.evidence_required"))?;
    serde_json::to_value(attestation).map_err(|error| HrError::internal(error.to_string()))
}

pub(super) fn governance(error: PgGovernanceError) -> HrError {
    match error {
        PgGovernanceError::Domain(_) => refused("lifecycle.refuse.evidence_required"),
        PgGovernanceError::Db(error) => HrError::from(error),
    }
}

impl HrService {
    pub async fn complete_lifecycle_item(
        &self,
        p: Principal,
        id: Uuid,
        item_id: Uuid,
        body: CompleteItem,
    ) -> Result<LifecycleCase, HrError> {
        self.complete_lifecycle_item_with_passkeys(p, id, item_id, body, None)
            .await
    }
    pub async fn complete_lifecycle_item_with_passkeys(
        &self,
        p: Principal,
        id: Uuid,
        item_id: Uuid,
        mut body: CompleteItem,
        passkeys: Option<&console_platform_auth::PasskeyService>,
    ) -> Result<LifecycleCase, HrError> {
        let passkeys = passkeys.cloned();
        if body.due_date.is_some() {
            return Err(refused("lifecycle.refuse.deadline_unknown"));
        }
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move |tx|Box::pin(async move {
            let case=super::read::load(tx,&p,id).await?;
            let item=case.items.iter().find(|i|i.id==item_id).ok_or_else(||HrError::validation("lifecycle item missing"))?;
            let own = crate::own_record::own_record_decision(tx,p.org_id,p.user_id,case.employee_id,Feature::EmployeeDirectoryManage).await?;
            let subject_is_self = own != crate::own_record::OwnRecord::NotOwn;
            let has_subject_user:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE org_id=$1 AND employee_id=$2)")
                .bind(p.org_id.as_uuid()).bind(case.employee_id).fetch_one(tx.as_mut()).await?;
            let owner=holds_owner(tx,&p,case.id,item.owner_line.as_deref()).await?;
            let facts=ItemCompleteFacts {item_kind:item.kind.clone(),actor_holds_owner_line:owner,
              actor_scope_covers:owner,has_subject_user:has_subject_user || subject_is_self,subject_is_self};
            if !lifecycle_item::decide(&item.kind,&p.user_id.to_string(),&p.org_id.to_string(),&p.org_id.to_string(),&facts).map_err(HrError::internal)? {
                return Err(refused(if facts.subject_is_self {"lifecycle.refuse.self_completion"} else {"lifecycle.refuse.owner_line"}));
            }
            if case.state!="OPEN" || !matches!(item.status.as_str(),"OPEN"|"PENDING_TRIGGER"|"BLOCKED") || item.version!=body.expected_version {
                return Err(HrError::validation("lifecycle item changed; reload the case"));
            }
            if item.opens_in_days.is_some_and(|days|days>0) || item.status=="PENDING_TRIGGER" {
                return Err(refused("lifecycle.refuse.window_not_open"));
            }
            let attested=super::attest::mint(tx,&p,item,&mut body,passkeys.as_ref()).await?;
            evidence(tx,&p,&case,item,&body).await?;
            let observed=attested.map(|id|json!({"table":"governed_exception_attestations","id":id,"document":body.attestation.as_ref().map(|given| &given.document)})).or(body.observed_ref);
            let status=if body.waive {"WAIVED"} else if body.exception_id.is_some() {"DONE_ATTESTED"} else {"DONE_OBSERVED"};
            sqlx::query("UPDATE lifecycle_case_items SET status=$3,status_code=NULL,observed_ref=$4,exception_id=$5,done_by=$6,completion_reason=$7,done_at=now(),version=version+1 \
              WHERE org_id=$1 AND id=$2")
                .bind(p.org_id.as_uuid()).bind(item_id).bind(status).bind(observed).bind(body.exception_id)
                .bind(p.user_id.as_uuid()).bind(body.reason.as_deref().map(str::trim)).execute(tx.as_mut()).await?;
            sqlx::query("UPDATE lifecycle_cases SET version=version+1 WHERE org_id=$1 AND id=$2")
                .bind(p.org_id.as_uuid()).bind(id).execute(tx.as_mut()).await?;
            Ok((super::read::load(tx,&p,id).await?,vec![super::read::audit(&p,id)?]))
        })).await
    }
    pub async fn close_lifecycle_case(
        &self,
        p: Principal,
        id: Uuid,
    ) -> Result<LifecycleCase, HrError> {
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move |tx|Box::pin(async move {
            let case=super::read::load(tx,&p,id).await?;
            if !super::access::may(tx,&p,Feature::EmployeeDirectoryManage,case.id).await? {
                return Err(refused("lifecycle.refuse.owner_line"));
            }
            sqlx::query("UPDATE lifecycle_cases SET state='CLOSED',closed_at=now(),close_basis='ALL_TERMINAL',version=version+1 WHERE org_id=$1 AND id=$2 AND state='OPEN'")
                .bind(p.org_id.as_uuid()).bind(id).execute(tx.as_mut()).await.map_err(|e| {
                    if e.as_database_error().is_some_and(|d|d.message().contains("case_has_open_items")) {refused("lifecycle.refuse.close_blocked")} else {HrError::from(e)}
                })?;
            Ok((super::read::load(tx,&p,id).await?,vec![super::read::audit(&p,id)?]))
        })).await
    }
}
