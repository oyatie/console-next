// SPDX-License-Identifier: LicenseRef-Proprietary
//! Legal-entity numbering and immutable seal versions, changed with an optimistic version.
use super::{access, state_conflict, validation};
use crate::{HrError, HrService};
use console_platform_authz::Principal;
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CertificateSettings {
    pub legal_entity_id: Uuid,
    pub prefix: String,
    pub width: i32,
    pub seal_text: String,
    pub seal_png: Option<String>,
    #[serde(skip)]
    pub seal_id: Option<Uuid>,
    pub version: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CertificateSettingsRequest {
    pub legal_entity_id: Uuid,
    pub prefix: String,
    pub width: i32,
    pub seal_text: String,
    #[serde(default)]
    pub seal_png: Option<String>,
    pub expected_version: i64,
}
#[derive(Debug, Serialize)]
pub struct CertificateSettingsView {
    pub settings: Vec<CertificateSettings>,
    pub seal_max_bytes: usize,
}

pub(super) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    entity: Uuid,
) -> Result<CertificateSettings, HrError> {
    sqlx::query_as("SELECT legal_entity_id,prefix,width,seal_text,seal_id,NULL::text AS seal_png,version FROM hr_certificate_entity_settings WHERE org_id=$1 AND legal_entity_id=$2 FOR SHARE")
    .bind(org).bind(entity).fetch_optional(tx.as_mut()).await?.ok_or_else(||super::refused(http::StatusCode::CONFLICT,"certificate_settings_required","configure certificate numbering and issuer seal before issuing"))
}
impl HrService {
    pub async fn certificate_settings(
        &self,
        p: Principal,
    ) -> Result<CertificateSettingsView, HrError> {
        access::capability(&p, "certificate_settings_read")?;
        crate::authz::authorize_hr_org_wide(&p, access::feature("certificate_settings_read"))?;
        with_org_conn::<_,_,HrError>(&self.pool,p.org_id,move|tx|Box::pin(async move {
            let settings=sqlx::query_as("SELECT c.legal_entity_id,c.prefix,c.width,c.seal_text,c.seal_id,s.png AS seal_png,c.version FROM hr_certificate_entity_settings c LEFT JOIN hr_certificate_seals s ON s.org_id=c.org_id AND s.id=c.seal_id WHERE c.org_id=$1 ORDER BY c.legal_entity_id").bind(p.org_id.as_uuid()).fetch_all(tx.as_mut()).await?;
            Ok(CertificateSettingsView{settings,seal_max_bytes:super::seal::MAX_BYTES})
        })).await
    }
    pub async fn set_certificate_settings(
        &self,
        p: Principal,
        b: CertificateSettingsRequest,
    ) -> Result<CertificateSettings, HrError> {
        access::capability(&p, "certificate_settings_manage")?;
        crate::authz::authorize_hr_org_wide(&p, access::feature("certificate_settings_manage"))?;
        super::seal::validate(b.seal_png.as_deref())?;
        let prefix = validation::text(&b.prefix, 40)?;
        let seal = validation::text(&b.seal_text, 200)?;
        if !(1..=12).contains(&b.width) || b.expected_version < 0 {
            return Err(super::invalid(
                "width must be 1..12 and version nonnegative",
            ));
        }
        with_audits::<_,_,HrError>(&self.pool,p.org_id,move|tx|Box::pin(async move {
            let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM legal_entities WHERE org_id=$1 AND id=$2)").bind(p.org_id.as_uuid()).bind(b.legal_entity_id).fetch_one(tx.as_mut()).await?;
            if !exists {return Err(super::not_found());}
            let seal_id=super::seal::store(tx,*p.org_id.as_uuid(),b.seal_png.as_deref()).await?;
            let query=if b.expected_version==0 {
                "INSERT INTO hr_certificate_entity_settings(org_id,prefix,width,seal_text,updated_by,seal_id,legal_entity_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,legal_entity_id) DO NOTHING RETURNING legal_entity_id,prefix,width,seal_text,seal_id,NULL::text AS seal_png,version"
            } else {
                "UPDATE hr_certificate_entity_settings SET prefix=$2,width=$3,seal_text=$4,updated_by=$5,seal_id=$6,version=version+1 WHERE org_id=$1 AND legal_entity_id=$7 AND version=$8 RETURNING legal_entity_id,prefix,width,seal_text,seal_id,NULL::text AS seal_png,version"
            };
            let mut query=sqlx::query_as::<_,CertificateSettings>(query).bind(p.org_id.as_uuid()).bind(&prefix).bind(b.width).bind(&seal).bind(p.user_id.as_uuid()).bind(seal_id).bind(b.legal_entity_id);
            if b.expected_version>0 {query=query.bind(b.expected_version);}
            let mut row=query.fetch_optional(tx.as_mut()).await?.ok_or_else(state_conflict)?;
            row.seal_png=b.seal_png;
            let event=super::commands::audit(&p,"certificate.settings",*p.org_id.as_uuid(),serde_json::json!({"legal_entity_id":row.legal_entity_id,"version":row.version}))?;
            Ok((row,vec![event]))
        })).await
    }
}
