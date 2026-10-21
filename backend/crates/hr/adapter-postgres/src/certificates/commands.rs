// SPDX-License-Identifier: LicenseRef-Proprietary
//! One transaction owns authorization, command replay, numbering, register and audit.
use super::{
    Certificate, CertificateActionRequest, IssueCertificateRequest, access, facts, read, settings,
    state_conflict, validation,
};
use crate::{HrError, HrService};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::Principal;
use console_platform_db::{
    idempotency::{
        IdempotencyClaim, claim_idempotency_key, complete_idempotency_key, validate_idempotency_key,
    },
    with_audits,
};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

pub(super) fn audit(
    p: &Principal,
    action: &str,
    id: Uuid,
    metadata: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(p.user_id),
        AuditAction::new(action)?,
        if action == "certificate.settings" {
            "hr_certificate_settings"
        } else {
            "hr_certificate"
        },
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(p.org_id)
    .with_snapshots(None, Some(metadata)))
}
async fn insert(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    body: &IssueCertificateRequest,
    replaces: Option<Uuid>,
) -> Result<Certificate, HrError> {
    let (entity, mut snapshot) = facts::snapshot(tx, p, body).await?;
    let settings = settings::load(tx, *p.org_id.as_uuid(), entity).await?;
    snapshot["seal_text"] = json!(settings.seal_text);
    let year: i32 =
        sqlx::query_scalar("SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Seoul')::integer")
            .fetch_one(tx.as_mut())
            .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1::text || ':certificate:' || $2::text || ':' || $3::text))")
        .bind(p.org_id.as_uuid())
        .bind(entity)
        .bind(year)
        .execute(tx.as_mut())
        .await?;
    let seq:i64=sqlx::query_scalar("SELECT COALESCE(max(seq),0)+1 FROM hr_certificates WHERE org_id=$1 AND (legal_entity_id=$3 OR legal_entity_id IS NULL) AND certificate_year=$2").bind(p.org_id.as_uuid()).bind(year).bind(entity).fetch_one(tx.as_mut()).await?;
    let width = usize::try_from(settings.width)
        .map_err(|_| HrError::internal("invalid stored certificate width"))?;
    if seq.to_string().len() > width {
        return Err(super::refused(
            http::StatusCode::CONFLICT,
            "certificate_numbers_exhausted",
            "configured certificate number width is exhausted; increase it in settings",
        ));
    }
    let number = format!("{}-{year}-{seq:0width$}", settings.prefix);
    let row=sqlx::query("INSERT INTO hr_certificates(org_id,employee_id,certificate_year,seq,certificate_no,kind,items,purpose,snapshot,replaces_id,issued_by,seal_id,legal_entity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *")
        .bind(p.org_id.as_uuid()).bind(body.employee_id).bind(year).bind(seq).bind(number).bind(&body.kind).bind(&body.items).bind(body.purpose.trim()).bind(snapshot).bind(replaces).bind(p.user_id.as_uuid()).bind(settings.seal_id).bind(entity).fetch_one(tx.as_mut()).await?;
    read::from_row(&row)
}
async fn mark_void(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    id: Uuid,
    reason: &str,
) -> Result<(), HrError> {
    sqlx::query("UPDATE hr_certificates SET voided_at=now(),voided_by=$3,void_reason=$4 WHERE org_id=$1 AND id=$2 AND voided_at IS NULL")
        .bind(p.org_id.as_uuid()).bind(id).bind(p.user_id.as_uuid()).bind(reason).execute(tx.as_mut()).await?;
    Ok(())
}
impl HrService {
    pub async fn issue_certificate(
        &self,
        p: Principal,
        key: Option<String>,
        body: IssueCertificateRequest,
    ) -> Result<Value, HrError> {
        access::capability(&p, "certificate_issue")?;
        validation::issue(&body)?;
        let key = validate_idempotency_key(key.as_deref()).map_err(HrError::validation)?;
        with_audits::<_, _, HrError>(&self.pool, p.org_id, move |tx| {
            Box::pin(async move {
                access::person(tx, &p, "certificate_issue", body.employee_id).await?;
                // Resolve absence before reserving an intent or revealing any stored response.
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM employees WHERE org_id=$1 AND id=$2)",
                )
                .bind(p.org_id.as_uuid())
                .bind(body.employee_id)
                .fetch_one(tx.as_mut())
                .await?;
                if !exists {
                    return Err(super::not_found());
                }
                let fingerprint = json!({"actor":p.user_id,"body":body});
                match claim_idempotency_key(tx, "certificate.issue", &key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => return Ok((response, vec![])),
                    IdempotencyClaim::Mismatch => {
                        return Err(crate::idempotency::idempotency_key_reused());
                    }
                    IdempotencyClaim::Fresh => {}
                }
                let cert = insert(tx, &p, &body, None).await?;
                let audit = audit(
                    &p,
                    "certificate.issue",
                    cert.id,
                    json!({"employee_id":cert.employee_id,"certificate_no":cert.certificate_no}),
                )?;
                let response = json!(cert);
                complete_idempotency_key(tx, "certificate.issue", &key, &response).await?;
                Ok((response, vec![audit]))
            })
        })
        .await
    }
    pub async fn void_certificate(
        &self,
        p: Principal,
        id: Uuid,
        key: Option<String>,
        body: CertificateActionRequest,
    ) -> Result<Value, HrError> {
        self.certificate_action(p, id, key, body, false).await
    }
    pub async fn reissue_certificate(
        &self,
        p: Principal,
        id: Uuid,
        key: Option<String>,
        body: CertificateActionRequest,
    ) -> Result<Value, HrError> {
        self.certificate_action(p, id, key, body, true).await
    }
    async fn certificate_action(
        &self,
        p: Principal,
        id: Uuid,
        key: Option<String>,
        body: CertificateActionRequest,
        reissue: bool,
    ) -> Result<Value, HrError> {
        let (action, operation) = if reissue {
            ("certificate_reissue", "certificate.reissue")
        } else {
            ("certificate_void", "certificate.void")
        };
        access::capability(&p, action)?;
        let reason = validation::text(&body.reason, 1000)?;
        let key = validate_idempotency_key(key.as_deref()).map_err(HrError::validation)?;
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move|tx|Box::pin(async move {
            let original=read::load(tx,&p,id,action,true).await?;
            let fingerprint=json!({"actor":p.user_id,"id":id,"body":body});
            match claim_idempotency_key(tx,operation,&key,&fingerprint).await? {
                IdempotencyClaim::Replay(response)=>return Ok((response,vec![])),
                IdempotencyClaim::Mismatch=>return Err(crate::idempotency::idempotency_key_reused()),
                IdempotencyClaim::Fresh=>{}
            }
            let replaced:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hr_certificates WHERE org_id=$1 AND replaces_id=$2)").bind(p.org_id.as_uuid()).bind(id).fetch_one(tx.as_mut()).await?;
            if replaced || (!reissue && original.voided_at.is_some()) {return Err(state_conflict());}
            let out=if reissue {
                let request=IssueCertificateRequest{employee_id:original.employee_id,kind:original.kind.clone(),items:original.items.clone(),purpose:original.purpose.clone()};
                let next=insert(tx,&p,&request,Some(id)).await?;
                mark_void(tx,&p,id,&reason).await?;
                next
            } else {
                mark_void(tx,&p,id,&reason).await?;
                read::load(tx,&p,id,action,false).await?
            };
            let audit=audit(&p,operation,out.id,json!({"employee_id":original.employee_id,"original_id":id,"certificate_no":out.certificate_no}))?;
            let response=json!(out);
            complete_idempotency_key(tx,operation,&key,&response).await?;
            Ok((response,vec![audit]))
        })).await
    }
}
