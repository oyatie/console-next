use super::filings::load;
use super::{FilingPage, FilingQuery, FilingTask, refusal};
use crate::{
    HrError, HrService,
    clock::today_kst,
    digest::sha256_hex,
    idempotency::{idempotency_key_reused, normalize_idempotency_key},
};
use console_compliance_domain::statutory::StatutoryRegister;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

/// The supplementary filings a lifecycle event can request: the one source of the wire values
/// (RequestInsuranceFiling.filing_kind in OpenAPI, held equal by the request-body gate). An unknown
/// value is refused at the JSON boundary (422) before any read or write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RequestKind {
    WorkConfirmation,
    SeparationCertificate,
    AcquireRequested,
    MonthlyRemuneration,
}

impl RequestKind {
    /// The register's and the ledger's code for this kind (`insurance_filing_requests.filing_kind`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WorkConfirmation => "WORK_CONFIRMATION",
            Self::SeparationCertificate => "SEPARATION_CERTIFICATE",
            Self::AcquireRequested => "ACQUIRE_REQUESTED",
            Self::MonthlyRemuneration => "MONTHLY_REMUNERATION",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestFiling {
    pub source_event_id: Uuid,
    pub filing_kind: RequestKind,
    pub anchor_on: String,
}
impl HrService {
    pub async fn request_insurance_filing(
        &self,
        p: Principal,
        key: String,
        body: RequestFiling,
        register: StatutoryRegister,
    ) -> Result<FilingPage, HrError> {
        let key = normalize_idempotency_key(key)?;
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move|tx|Box::pin(async move {
            let result=async {
                let hash=sha256_hex(&serde_json::to_vec(&body).map_err(|_|HrError::internal("filing request fingerprint failed"))?);
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))").bind(format!("filing-request:{}:{}:{key}",p.org_id,p.user_id)).execute(tx.as_mut()).await?;
                sqlx::query("SELECT id FROM employee_lifecycle_events WHERE org_id=$1 AND id=$2 FOR UPDATE").bind(p.org_id.as_uuid()).bind(body.source_event_id).fetch_optional(tx.as_mut()).await?;
                let tasks=load(tx,&p,FilingQuery{event_id:Some(body.source_event_id),..FilingQuery::default()},&register).await?;
                let source: &FilingTask=tasks.items.iter().find(|t| match body.filing_kind {RequestKind::SeparationCertificate=>t.kind=="LOSE",_=>t.kind=="ACQUIRE"}).ok_or_else(||refusal(StatusCode::CONFLICT,"filing_event_inactive","The lifecycle event is no longer active or in scope; reload the filing list."))?;
                crate::own_record::own_record_guard(tx,p.org_id,p.user_id,source.employee_id,Feature::EmployeeDirectoryManage).await?;
                let exists=sqlx::query("SELECT id,request_hash FROM insurance_filing_requests WHERE org_id=$1 AND actor=$2 AND idempotency_key=$3").bind(p.org_id.as_uuid()).bind(p.user_id.as_uuid()).bind(&key).fetch_optional(tx.as_mut()).await?;
                if let Some(r)=&exists {
                    if r.try_get::<String,_>("request_hash")?!=hash {return Err(idempotency_key_reused());}
                    return load(tx,&p,FilingQuery{event_id:Some(if body.filing_kind==RequestKind::AcquireRequested {body.source_event_id}else{r.try_get("id")?}),..FilingQuery::default()},&register).await;
                }
                let on=parse_yyyy_mm_dd(&body.anchor_on).map_err(|_|refusal(StatusCode::UNPROCESSABLE_ENTITY,"filing_request_invalid","Choose a valid request date or work-month end."))?;
                console_hr_application::statutory::validate_request(body.filing_kind.as_str(),&source.kind,on,parse_yyyy_mm_dd(source.opens_on.as_deref().ok_or_else(||refusal(StatusCode::UNPROCESSABLE_ENTITY,"filing_request_invalid","The filing opening is unverified; confirm the statutory rule."))?)?,today_kst()).map_err(|e|refusal(StatusCode::UNPROCESSABLE_ENTITY,"filing_request_invalid",&e.message))?;
                if body.filing_kind==RequestKind::AcquireRequested && (source.completed_on.is_some() || source.due_on.as_deref().map(parse_yyyy_mm_dd).transpose()?.is_some_and(|due|on>due)) {
                    return Err(refusal(StatusCode::UNPROCESSABLE_ENTITY,"filing_request_invalid","A worker request must precede the acquisition deadline and an actual filing."));
                }
                if register.filing_rule("EI",body.filing_kind.as_str(),on)?.is_none() {return Err(refusal(StatusCode::UNPROCESSABLE_ENTITY,"filing_request_invalid","This filing kind is not in force for the requested date."));}
                let id=if let Some(r)=exists {
                    if r.try_get::<String,_>("request_hash")?!=hash {return Err(idempotency_key_reused());}r.try_get::<Uuid,_>("id")?
                }else{
                    let duplicate:Option<Uuid>=sqlx::query_scalar("SELECT id FROM insurance_filing_requests WHERE org_id=$1 AND source_event_id=$2 AND filing_kind=$3 AND anchor_on=$4").bind(p.org_id.as_uuid()).bind(body.source_event_id).bind(body.filing_kind.as_str()).bind(on).fetch_optional(tx.as_mut()).await?;
                    if duplicate.is_some(){return Err(refusal(StatusCode::UNPROCESSABLE_ENTITY,"filing_request_invalid","This filing request is already recorded; reload the list."));}
                    sqlx::query_scalar("INSERT INTO insurance_filing_requests(org_id,employee_id,source_event_id,filing_kind,anchor_on,actor,idempotency_key,request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id")
                        .bind(p.org_id.as_uuid()).bind(source.employee_id).bind(body.source_event_id).bind(body.filing_kind.as_str()).bind(on).bind(p.user_id.as_uuid()).bind(&key).bind(hash).fetch_one(tx.as_mut()).await?
                };
                load(tx,&p,FilingQuery{event_id:Some(if body.filing_kind==RequestKind::AcquireRequested {body.source_event_id}else{id}),..FilingQuery::default()},&register).await
            }.await;
            let (action,snapshot)=match &result {Ok(page)=>("insurance_filing.requested",json!({"kind":body.filing_kind,"count":page.total})),Err(e) if e.status!=StatusCode::INTERNAL_SERVER_ERROR=>("insurance_filing.refused",json!({"code":e.code,"kind":body.filing_kind})),Err(_)=>return result.map(|t|(Ok(t),Vec::new()))};
            let audit=AuditEvent::new(Some(p.user_id),AuditAction::new(action)?,"insurance_filing",body.source_event_id.to_string(),TraceContext::generate(),OffsetDateTime::now_utc()).with_org(p.org_id).with_snapshots(None,Some(snapshot));
            Ok((result,vec![audit]))
        })).await?
    }
}
