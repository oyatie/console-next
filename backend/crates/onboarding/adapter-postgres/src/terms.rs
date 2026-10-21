//! Exact published text; accepting a version never proves acceptance of another text.
use super::*;
use console_onboarding_domain::TermsVersion;
use sqlx::Row;

const LATEST: &str = "SELECT version, sha256, body FROM terms_documents WHERE published_at <= now() ORDER BY published_at DESC, version DESC LIMIT 1";

#[derive(Debug, Clone, Serialize)]
pub struct TermsDocument {
    pub version: String,
    pub sha256: String,
    pub body: String,
}

async fn latest(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Option<TermsDocument>, PgOnboardingError> {
    sqlx::query(LATEST)
        .fetch_optional(tx.as_mut())
        .await?
        .map(|r| {
            Ok(TermsDocument {
                version: r.try_get("version")?,
                sha256: r.try_get("sha256")?,
                body: r.try_get("body")?,
            })
        })
        .transpose()
}

pub(crate) async fn acceptance(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(bool, Option<TermsVersion>), PgOnboardingError> {
    let Some(d) = latest(tx).await? else {
        return Ok((false, None));
    };
    let accepted = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM tenant_terms_acceptances WHERE version = $1 AND sha256 = $2)",
    )
    .bind(&d.version)
    .bind(&d.sha256)
    .fetch_one(tx.as_mut())
    .await?;
    Ok((
        accepted,
        Some(TermsVersion {
            version: d.version,
            sha256: d.sha256,
        }),
    ))
}

impl PgOnboardingStore {
    /// Read published terms for the contracting administrator.
    /// # Errors
    /// `terms_not_published`, Cedar refusal, or database faults.
    pub async fn terms(&self, actor: &OnboardingActor) -> Result<TermsDocument, PgOnboardingError> {
        let a = actor.clone();
        let result = with_org_conn(&self.pool, a.org, move |tx| {
            Box::pin(async move {
                viewer::require_ops(tx, &a).await?;
                latest(tx).await?.ok_or_else(|| {
                    refused(
                        ErrorKind::Conflict,
                        "terms_not_published",
                        Some("contact_service_operator"),
                    )
                })
            })
        })
        .await;
        self.audit_refusal(actor, result).await
    }

    /// Accept the exact latest document, once per version, preserving earlier acceptances.
    /// # Errors
    /// `validation_failed`, `terms_text_changed`, `terms_version_already_accepted`, Cedar refusal, or database faults.
    pub async fn accept_terms(
        &self,
        actor: &OnboardingActor,
        version: String,
        sha256: String,
    ) -> Result<(), PgOnboardingError> {
        self.accept_terms_document(actor, version, Some(sha256))
            .await
    }

    /// N-1 compatibility: resolve the legacy version to the current immutable document.
    /// # Errors
    /// The same validation, version, authorization and replay refusals as `accept_terms`.
    pub async fn accept_terms_version(
        &self,
        actor: &OnboardingActor,
        version: String,
    ) -> Result<(), PgOnboardingError> {
        self.accept_terms_document(actor, version, None).await
    }

    async fn accept_terms_document(
        &self,
        actor: &OnboardingActor,
        version: String,
        sha256: Option<String>,
    ) -> Result<(), PgOnboardingError> {
        let a = actor.clone();
        let result = with_phase_audits(&self.pool, a.org, move |tx| Box::pin(async move {
            viewer::require_ops(tx, &a).await?;
            // Serialize tenant acceptances with skips and go-live; published documents are immutable.
            let p = phase(tx, true).await?;
            if version.is_empty() || version.chars().count() > 40 || sha256.as_ref().is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
                return Err(refused(ErrorKind::Validation, "validation_failed", Some("review_terms")));
            }
            let Some(d) = latest(tx).await?.filter(|d| d.version == version && sha256.as_ref().is_none_or(|hash| d.sha256 == *hash)) else {
                return Err(refused(ErrorKind::Conflict, "terms_text_changed", Some("review_terms")));
            };
            let sha256 = d.sha256;
            let accepted = sqlx::query("INSERT INTO tenant_terms_acceptances (org_id, version, sha256, accepted_by) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, version) DO NOTHING")
                .bind(a.org.as_uuid()).bind(&version).bind(&sha256).bind(a.user.as_uuid()).execute(tx.as_mut()).await?.rows_affected();
            if accepted == 0 { return Err(refused(ErrorKind::Conflict, "terms_version_already_accepted", Some("return_to_preview"))); }
            let payload = json!({ "terms_version": version, "sha256": sha256 });
            sqlx::query("INSERT INTO tenant_phase_events (org_id, kind, actor_id, payload) VALUES ($1, 'TERMS_ACCEPTED', $2, $3)")
                .bind(a.org.as_uuid()).bind(a.user.as_uuid()).bind(&payload).execute(tx.as_mut()).await?;
            let audit = event(&a, "tenant.terms_accept", payload, p == TenantPhase::Setup)?;
            Ok(((), vec![audit]))
        })).await;
        self.audit_refusal(actor, result).await
    }
}
