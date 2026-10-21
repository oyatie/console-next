// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    Certificate, CertificateListQuery, CertificatePage, CertificateSummary, access, not_found,
};
use crate::{
    HrError, HrService,
    authz::{hr_reach, push_reach},
    lifecycle::events_page::{LifecycleEventsQuery, encode_events_cursor},
};
use console_platform_authz::Principal;
use console_platform_db::with_audits;
use sqlx::{Postgres, QueryBuilder, Row, Transaction};
use uuid::Uuid;

pub(super) fn from_row(r: &sqlx::postgres::PgRow) -> Result<Certificate, HrError> {
    Ok(Certificate {
        id: r.try_get("id")?,
        employee_id: r.try_get("employee_id")?,
        certificate_no: r.try_get("certificate_no")?,
        kind: r.try_get("kind")?,
        items: r.try_get("items")?,
        purpose: r.try_get("purpose")?,
        snapshot: r.try_get("snapshot")?,
        replaces_id: r.try_get("replaces_id")?,
        issued_by: r.try_get("issued_by")?,
        issued_at: r.try_get("issued_at")?,
        voided_at: r.try_get("voided_at")?,
        void_reason: r.try_get("void_reason")?,
    })
}
pub(super) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    id: Uuid,
    action: &str,
    lock: bool,
) -> Result<Certificate, HrError> {
    let sql = if lock {
        "SELECT * FROM hr_certificates WHERE org_id=$1 AND id=$2 FOR UPDATE"
    } else {
        "SELECT * FROM hr_certificates WHERE org_id=$1 AND id=$2"
    };
    let row = sqlx::query(sql)
        .bind(p.org_id.as_uuid())
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(not_found)?;
    let cert = from_row(&row)?;
    access::person(tx, p, action, cert.employee_id).await?;
    Ok(cert)
}
impl HrService {
    pub async fn certificate(&self, p: Principal, id: Uuid) -> Result<Certificate, HrError> {
        access::capability(&p, "certificate_read")?;
        with_audits::<_, _, HrError>(&self.pool, p.org_id, move |tx| {
            Box::pin(async move {
                let mut cert = load(tx, &p, id, "certificate_read", false).await?;
                let png: Option<String> = sqlx::query_scalar("SELECT s.png FROM hr_certificates c JOIN hr_certificate_seals s ON s.org_id=c.org_id AND s.id=c.seal_id WHERE c.org_id=$1 AND c.id=$2").bind(p.org_id.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?;
                if let Some(png) = png {cert.snapshot["seal_png"]=serde_json::json!(png);}
                let audit = super::commands::audit(
                    &p,
                    "certificate.read",
                    id,
                    serde_json::json!({"employee_id":cert.employee_id}),
                )?;
                Ok((cert, vec![audit]))
            })
        })
        .await
    }
    pub async fn certificates(
        &self,
        p: Principal,
        q: CertificateListQuery,
    ) -> Result<CertificatePage, HrError> {
        access::capability(&p, "certificate_read")?;
        let reach = hr_reach(&p, access::feature("certificate_read"))?;
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move|tx|Box::pin(async move {
            let key=console_settings_domain::SettingKey::DisplayPageSize;
            let resolved=console_platform_db::settings_read::resolve_in_tx(tx.as_mut(),p.org_id,&[key],None,time::OffsetDateTime::now_utc()).await?;
            let size=match resolved.get(&key).and_then(|r|r.as_ref().ok()).map(|r|r.value) {
                Some(console_settings_domain::SettingValue::Int(size))=>size,
                _=>return Err(HrError::internal("display page size is not configured")),
            };
            let page=LifecycleEventsQuery{limit:Some(q.limit.unwrap_or(size).clamp(1,size)),cursor:q.cursor}.page()?;
            let mut sql=QueryBuilder::<Postgres>::new("SELECT c.id,c.employee_id,c.certificate_no,c.snapshot->>'name' AS name,c.kind,c.purpose,c.replaces_id,c.issued_at,c.voided_at FROM hr_certificates c JOIN employees e ON e.org_id=c.org_id AND e.id=c.employee_id");
            sql.push(crate::assignment_lateral!());
            sql.push(" WHERE c.org_id=").push_bind(*p.org_id.as_uuid());
            if let Some(employee)=q.employee_id {sql.push(" AND c.employee_id=").push_bind(employee);}
            if let Some((at,id))=page.before {sql.push(" AND (c.issued_at,c.id)<(").push_bind(at).push(",").push_bind(id).push(")");}
            sql.push(" AND ");push_reach(&mut sql,&reach);
            sql.push(" ORDER BY c.issued_at DESC,c.id DESC LIMIT ").push_bind(page.limit+1);
            let mut items=sql.build_query_as::<CertificateSummary>().fetch_all(tx.as_mut()).await?;
            let has_more=i64::try_from(items.len()).unwrap_or(i64::MAX)>page.limit;
            if has_more {items.pop();}
            let next_cursor=if has_more {items.last().map(|c|encode_events_cursor(c.issued_at,c.id))} else {None};
            let audit=super::commands::audit(&p,"certificate.list_read",*p.org_id.as_uuid(),serde_json::json!({"certificate_ids":items.iter().map(|c|c.id).collect::<Vec<_>>()}))?;
            Ok((CertificatePage{items,next_cursor},vec![audit]))
        })).await
    }
}
