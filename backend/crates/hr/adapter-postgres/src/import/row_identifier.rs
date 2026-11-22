// SPDX-License-Identifier: LicenseRef-Proprietary
//! Step-up draft RRN entry for staged employee import rows (`PUT .../identifier`).

use console_hr_domain::{
    import::rrn_value::{Rrn, RrnVault},
    import::sex::sex_of_rrn,
    profile::enums::IdType,
    profile::identity::validate_id_pair,
};
use console_kernel_core::KernelError;
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind, PasskeyService,
};
use console_platform_authz::{
    Principal,
    cedar_pbac::actions::employee_pii::{self, PiiFacts},
};
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    HrError, HrService,
    digest::sha256_hex,
    directory::access_log::{DirectoryAccess, access_event, actor_employee_id},
    import::store::import_run_for_update,
    rrn::{govern, record::directory, unavailable},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DraftIdentifierType {
    Rrn,
    Arc,
    DomesticResidence,
}

impl From<DraftIdentifierType> for IdType {
    fn from(value: DraftIdentifierType) -> Self {
        match value {
            DraftIdentifierType::Rrn => Self::Rrn,
            DraftIdentifierType::Arc => Self::Arc,
            DraftIdentifierType::DomesticResidence => Self::DomesticResidence,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRowIdentifierRequest {
    pub rrn: String,
    #[serde(default)]
    pub id_type: Option<DraftIdentifierType>,
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

impl std::fmt::Debug for ImportRowIdentifierRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ImportRowIdentifierRequest([redacted])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportRowIdentifierResponse {
    pub run_id: Uuid,
    pub source_key: String,
    pub id_type: String,
    pub recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sex_derived: Option<String>,
}

/// Passkey step-up binding for recording an identifier onto a staged import draft row.
#[must_use]
pub fn import_row_identifier_binding(run_id: Uuid, source_key: &str) -> MobilePasskeyStepUpBinding {
    MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::PiiRecord,
        run_id,
        sha256_hex(format!("{run_id}:{source_key}").as_bytes()),
    )
}

impl HrService {
    /// Validate, authorize with passkey step-up, seal via `RrnVault`, and stage a registration
    /// number onto a draft employee import row in `data_import_row_identities`.
    pub async fn record_import_row_identifier(
        &self,
        principal: Principal,
        run_id: Uuid,
        source_key: String,
        request: ImportRowIdentifierRequest,
        vault: Option<&dyn RrnVault>,
        passkeys: Option<&PasskeyService>,
    ) -> Result<ImportRowIdentifierResponse, HrError> {
        let org = principal.org_id;
        let actor = *principal.user_id.as_uuid();
        let authorized = principal.clone();
        let passkeys = passkeys.cloned();
        let vault_available = vault.is_some();
        let row_key = source_key.clone();

        let (rrn, effective_id_type) = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let within_rate =
                    govern::within_rate(tx, &authorized, &["employee.rrn_record"]).await?;
                let manages = directory(tx, &authorized).await?;
                let step_up = match (request.step_up, passkeys.as_ref()) {
                    (Some(proof), Some(service)) => {
                        govern::verify_binding(
                            tx,
                            &authorized,
                            import_row_identifier_binding(run_id, &row_key),
                            proof,
                            service,
                        )
                        .await
                    }
                    _ => Err(govern::required()),
                };
                let step_up = match step_up {
                    Err(e) if e.status.is_server_error() => return Err(e),
                    other => other,
                };
                let allowed = employee_pii::decide(
                    &actor.to_string(),
                    &org.to_string(),
                    PiiFacts {
                        operation: "record",
                        field: "RRN",
                        actor_manages_directory: manages,
                        subject_in_scope: manages,
                        purpose_given: false,
                        step_up_verified: step_up.is_ok(),
                        within_rate,
                    },
                )
                .map_err(HrError::internal)?;
                if !allowed {
                    if manages {
                        step_up?;
                        if !within_rate {
                            return Err(govern::refused(
                                http::StatusCode::TOO_MANY_REQUESTS,
                                "rrn_record_rate_limited",
                                "retry after the oldest record leaves the rolling one-hour window",
                            ));
                        }
                    }
                    return Err(govern::refused(
                        http::StatusCode::FORBIDDEN,
                        "forbidden",
                        "personal-field recording denied",
                    ));
                }
                let run = import_run_for_update(tx, *org.as_uuid(), run_id).await?;
                if run.entity_type != "employee_hr"
                    || (run.status != "PREVIEWED" && run.status != "DRY_RUN")
                {
                    return Err(HrError::from_kernel(KernelError::invalid_transition(
                        format!(
                            "cannot record draft identifier for import run in {} status",
                            run.status
                        ),
                    )));
                }
                let row_exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM data_import_rows \
                       WHERE org_id = $1 AND run_id = $2 AND source_key = $3 \
                         AND row_status = 'CANDIDATE')",
                )
                .bind(*org.as_uuid())
                .bind(run_id)
                .bind(&row_key)
                .fetch_one(tx.as_mut())
                .await?;
                if !row_exists {
                    return Err(HrError::from_kernel(KernelError::not_found(
                        "import draft row was not found",
                    )));
                }
                let rrn = Rrn::parse(&request.rrn).map_err(|_| {
                    govern::refused(
                        http::StatusCode::UNPROCESSABLE_ENTITY,
                        "rrn_invalid",
                        "resident registration number is invalid",
                    )
                })?;
                let explicit_id_type = request.id_type.map(IdType::from);
                let effective = match validate_id_pair(
                    explicit_id_type,
                    Some(rrn.seventh_digit()),
                    rrn.passes_mod11(),
                    None,
                ) {
                    Ok(Some(t)) => t,
                    Ok(None) => IdType::Rrn,
                    Err("rrn_mod11_invalid" | "rrn_invalid") => {
                        return Err(govern::refused(
                            http::StatusCode::UNPROCESSABLE_ENTITY,
                            "rrn_invalid",
                            "resident registration number check digit is invalid",
                        ));
                    }
                    Err(_) => {
                        return Err(govern::refused(
                            http::StatusCode::UNPROCESSABLE_ENTITY,
                            "id_type_rrn_mismatch",
                            "identity type does not match registration number",
                        ));
                    }
                };
                if !vault_available {
                    return Err(unavailable());
                }
                let me = actor_employee_id(tx, &authorized).await?;
                let event = access_event(
                    &authorized,
                    DirectoryAccess::RrnRecord,
                    &[run_id],
                    me,
                    json!({ "operation": "record", "field": "RRN", "run_id": run_id, "source_key": row_key }),
                )?;
                Ok(((rrn, effective), vec![event]))
            })
        })
        .await?;

        let scoped = match vault {
            Some(v) => v
                .scoped_for_org(*org.as_uuid())
                .await
                .map_err(|_| unavailable())?,
            None => None,
        };
        let vault = scoped.as_deref().or(vault).ok_or_else(unavailable)?;
        let sealed = vault
            .seal(*org.as_uuid(), &rrn)
            .map_err(|_| unavailable())?;
        let sex_derived = sex_of_rrn(rrn.digits()).map(str::to_owned);
        let id_type_str = effective_id_type.as_str().to_owned();
        let stored_id_type = id_type_str.clone();
        let key_copy = source_key.clone();

        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                if !directory(tx, &principal).await? {
                    return Err(govern::refused(
                        http::StatusCode::FORBIDDEN,
                        "forbidden",
                        "personal-field recording denied",
                    ));
                }
                sqlx::query(
                    "DELETE FROM data_import_row_identities \
                     WHERE org_id = $1 AND run_id = $2 AND source_key = $3",
                )
                .bind(*org.as_uuid())
                .bind(run_id)
                .bind(&key_copy)
                .execute(tx.as_mut())
                .await?;
                sqlx::query(
                    "INSERT INTO data_import_row_identities (org_id, run_id, source_key, rrn_hmac, \
                       hmac_key_version, rrn_hmac_v2, blind_index_version, ciphertext, nonce, \
                       dek_wrapped, dek_nonce, key_version, masked, alg_id, kek_id, msg_id, commitment_tag, id_type) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
                )
                .bind(*org.as_uuid())
                .bind(run_id)
                .bind(&key_copy)
                .bind(&sealed.hmac)
                .bind(sealed.hmac_key_version)
                .bind(sealed.hmac_v2.as_deref())
                .bind(sealed.blind_index_version)
                .bind(&sealed.ciphertext)
                .bind(&sealed.nonce)
                .bind(&sealed.dek_wrapped)
                .bind(&sealed.dek_nonce)
                .bind(sealed.key_version)
                .bind(&sealed.masked)
                .bind(sealed.alg_id.as_deref())
                .bind(sealed.kek_id.as_deref())
                .bind(sealed.msg_id.as_deref())
                .bind(sealed.commitment_tag.as_deref())
                .bind(&stored_id_type)
                .execute(tx.as_mut())
                .await?;
                Ok(())
            })
        })
        .await?;

        Ok(ImportRowIdentifierResponse {
            run_id,
            source_key,
            id_type: id_type_str,
            recorded: true,
            sex_derived,
        })
    }
}
