// SPDX-License-Identifier: LicenseRef-Proprietary
//! Exact published documents and session-family consent, shared by enrollment and app writes.
use super::*;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct DocumentRef {
    pub version: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConsentRefs {
    pub privacy: DocumentRef,
    pub terms: DocumentRef,
}

#[derive(Clone, Debug, Serialize)]
pub struct Document {
    pub version: String,
    pub sha256: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PrivacyDocument {
    #[serde(flatten)]
    pub document: Document,
    pub policy_url: String,
    pub review_pending: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConsentDocuments {
    #[serde(flatten)]
    pub terms: Document,
    pub privacy: PrivacyDocument,
}

impl ConsentDocuments {
    #[must_use]
    pub fn references(&self) -> ConsentRefs {
        let reference = |d: &Document| DocumentRef {
            version: d.version.clone(),
            sha256: d.sha256.clone(),
        };
        ConsentRefs {
            privacy: reference(&self.privacy.document),
            terms: reference(&self.terms),
        }
    }
}

/// Missing published text is an error; no caller may substitute a local stub.
pub async fn documents_in_tx(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<ConsentDocuments, sqlx::Error> {
    async fn latest(
        tx: &mut Transaction<'_, Postgres>,
        kind: &str,
    ) -> Result<(Document, Option<String>, bool), sqlx::Error> {
        let (version, sha256, body, url, review): (String, String, String, Option<String>, bool) = sqlx::query_as(
            "SELECT version, sha256, body, policy_url, review_pending FROM terms_documents \
             WHERE kind=$1 AND published_at <= now() ORDER BY published_at DESC, version DESC LIMIT 1")
            .bind(kind).fetch_one(tx.as_mut()).await?;
        Ok((
            Document {
                version,
                sha256,
                body,
            },
            url,
            review,
        ))
    }
    let (terms, _, _) = latest(tx, "service_terms").await?;
    let (document, policy_url, review_pending) = latest(tx, "privacy_notice").await?;
    Ok(ConsentDocuments {
        terms,
        privacy: PrivacyDocument {
            document,
            policy_url: policy_url.ok_or(sqlx::Error::RowNotFound)?,
            review_pending,
        },
    })
}

pub async fn current_references_in_tx(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<ConsentRefs, sqlx::Error> {
    let (pv, ph, tv, th): (String, String, String, String) = sqlx::query_as(
        "SELECT p.version,p.sha256,t.version,t.sha256 \
         FROM (SELECT version,sha256 FROM terms_documents WHERE kind='privacy_notice' AND published_at<=now() ORDER BY published_at DESC,version DESC LIMIT 1) p \
         CROSS JOIN (SELECT version,sha256 FROM terms_documents WHERE kind='service_terms' AND published_at<=now() ORDER BY published_at DESC,version DESC LIMIT 1) t")
        .fetch_one(tx.as_mut()).await?;
    Ok(ConsentRefs {
        privacy: DocumentRef {
            version: pv,
            sha256: ph,
        },
        terms: DocumentRef {
            version: tv,
            sha256: th,
        },
    })
}

pub async fn accepted_at(
    pool: &PgPool,
    org: OrgId,
    user: uuid::Uuid,
) -> Result<Option<time::OffsetDateTime>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    let refs = serde_json::to_value(current_references_in_tx(&mut tx).await?)
        .map_err(|e| sqlx::Error::Decode(Box::new(e)))?;
    let at = sqlx::query_scalar(
        "SELECT (privacy_acceptance->>'accepted_at')::timestamptz FROM auth_refresh_token_families \
         WHERE org_id=$1 AND user_id=$2 AND privacy_acceptance @> $3 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(org.as_uuid())
    .bind(user)
    .bind(refs)
    .fetch_optional(tx.as_mut())
    .await?
    .flatten();
    tx.commit().await?;
    Ok(at)
}

/// A primary-key family lookup replaces a per-write audit-history scan.
pub async fn ensure_write_consent(
    pool: &PgPool,
    verifier: &JwtVerifier,
    headers: &HeaderMap,
    method: &http::Method,
) -> Result<(), RequestContextError> {
    if matches!(
        *method,
        http::Method::GET | http::Method::HEAD | http::Method::OPTIONS
    ) {
        return Ok(());
    }
    let claims = verifier
        .verify_access_token(bearer_token(headers)?)
        .map_err(|_| RequestContextError::InvalidToken)?;
    let org = OrgId::from_str(&claims.org).map_err(|_| RequestContextError::InvalidToken)?;
    let (family, home) = match claims.actor_session {
        Some(actor) => (actor.family_id, actor.home_org),
        None => (
            claims
                .session_family_id
                .ok_or(RequestContextError::InvalidToken)?,
            org,
        ),
    };
    let unavailable = |e: sqlx::Error| RequestContextError::EffectivePolicy(e.to_string());
    let mut tx = pool.begin().await.map_err(unavailable)?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(home.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(unavailable)?;
    let documents = current_references_in_tx(&mut tx).await;
    let accepted = match documents {
        Ok(d) => {
            let refs = serde_json::to_value(d)
                .map_err(|e| RequestContextError::EffectivePolicy(e.to_string()))?;
            sqlx::query_scalar::<_, bool>("SELECT COALESCE(privacy_acceptance @> $2, false) FROM auth_refresh_token_families WHERE id=$1")
                .bind(family).bind(refs).fetch_optional(tx.as_mut()).await.map_err(unavailable)?.unwrap_or(false)
        }
        Err(sqlx::Error::RowNotFound) => false,
        Err(e) => return Err(unavailable(e)),
    };
    tx.commit().await.map_err(unavailable)?;
    if accepted {
        Ok(())
    } else {
        Err(RequestContextError::AccessScope(
            KernelError::forbidden(PRIVACY_CONSENT_REQUIRED_MESSAGE)
                .with_code("privacy_consent_required"),
        ))
    }
}
