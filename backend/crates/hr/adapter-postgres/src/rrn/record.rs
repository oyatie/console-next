// SPDX-License-Identifier: LicenseRef-Proprietary
//! Form entry: an employee-id-only proof, Cedar, and a durable access record before sealing.
use super::{RrnStatus, govern, require_employee, unavailable};
use crate::{
    HrError, HrService,
    digest::sha256_hex,
    directory::access_log::{DirectoryAccess, access_event, actor_employee_id},
};
use console_hr_domain::{
    import::rrn_value::{Rrn, RrnVault},
    profile::enums::IdType,
    profile::identity::validate_id_pair,
    profile::mask,
};
use console_kernel_core::{TraceContext, UserId};
use console_ontology_canonical_adapter_postgres::id_registered::{
    IdRegisteredWrite, set_employee_id_type_in_tx,
};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind, PasskeyService,
};
use console_platform_authz::{
    Feature, Principal,
    access::{NodeKind, NodeRef},
    cedar_pbac::{
        actions::employee_pii::{self, PiiFacts},
        visible::load_facts,
    },
};
use console_platform_db::{with_audits, with_org_conn};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RrnRecordRequest {
    pub rrn: String,
    #[serde(default)]
    pub id_type: Option<String>,
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}
impl std::fmt::Debug for RrnRecordRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RrnRecordRequest([redacted])")
    }
}

pub fn record_binding(employee: Uuid) -> MobilePasskeyStepUpBinding {
    MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::PiiRecord,
        employee,
        sha256_hex(employee.to_string().as_bytes()),
    )
}

// Keep the existing tenant-wide RRN boundary; the one loader supplies the directory fact.
pub(crate) async fn directory(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    p: &Principal,
) -> Result<bool, HrError> {
    load_facts(tx, p.org_id, *p.user_id.as_uuid())
        .await
        .map_err(HrError::from_kernel)?
        .authorize(
            Feature::EmployeeDirectoryManage.as_str(),
            NodeRef {
                kind: NodeKind::Tenant,
                id: *p.org_id.as_uuid(),
            },
        )
        .map_err(|error| HrError::internal(error.to_string()))
}

impl HrService {
    pub async fn record_rrn(
        &self,
        principal: Principal,
        employee: Uuid,
        request: RrnRecordRequest,
        vault: Option<&dyn RrnVault>,
        passkeys: Option<&PasskeyService>,
    ) -> Result<RrnStatus, HrError> {
        let org = principal.org_id;
        let actor = *principal.user_id.as_uuid();
        let authorized = principal.clone();
        let passkeys = passkeys.cloned();
        let vault_available = vault.is_some();
        let (rrn, effective_id_type) = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let within_rate = govern::within_rate(tx, &authorized, &["employee.rrn_record"]).await?;
                let manages = directory(tx, &authorized).await?;
                let step_up = match (request.step_up, passkeys.as_ref()) {
                    (Some(proof), Some(service)) => {
                        govern::verify_binding(
                            tx,
                            &authorized,
                            record_binding(employee),
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
                            metrics::counter!("hr_employee_pii_total", "operation" => "record", "outcome" => "rrn_record_rate_limited").increment(1);
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
                require_employee(tx, *org.as_uuid(), employee).await?;
                let rrn = Rrn::parse(&request.rrn).map_err(|_| {
                    govern::refused(
                        http::StatusCode::UNPROCESSABLE_ENTITY,
                        "rrn_invalid",
                        "resident registration number is invalid",
                    )
                })?;
                let explicit_id_type = match request.id_type.as_deref() {
                    Some(raw) if !raw.trim().is_empty() => Some(
                        IdType::parse(&raw.trim().to_ascii_uppercase()).map_err(|_| {
                            govern::refused(
                                http::StatusCode::UNPROCESSABLE_ENTITY,
                                "id_type_invalid",
                                "identity type is invalid",
                            )
                        })?,
                    ),
                    _ => None,
                };
                if explicit_id_type == Some(IdType::NotIssued) {
                    return Err(govern::refused(
                        http::StatusCode::UNPROCESSABLE_ENTITY,
                        "id_type_rrn_mismatch",
                        "NOT_ISSUED cannot be paired with a registration number",
                    ));
                }
                let effective_id_type = match validate_id_pair(
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
                    &[employee],
                    me,
                    json!({"operation":"record", "field":"RRN"}),
                )?;
                Ok(((rrn, effective_id_type), vec![event]))
            })
        })
        .await?;
        // No number enters the vault or storage before the access record commits.
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
        let v2_candidates = vault.blind_index_v2_candidates(*org.as_uuid(), &rrn);
        let result = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                if !directory(tx, &principal).await? {
                    return Err(govern::refused(
                        http::StatusCode::FORBIDDEN,
                        "forbidden",
                        "personal-field recording denied",
                    ));
                }
                let recorded_at = crate::import::identities::record_form(
                    tx,
                    *org.as_uuid(),
                    actor,
                    employee,
                    sealed,
                    &v2_candidates,
                )
                .await?;
                set_employee_id_type_in_tx(
                    tx,
                    IdRegisteredWrite {
                        org_id: *org.as_uuid(),
                        employee_id: employee,
                        actor: Some(UserId::from_uuid(actor)),
                        new_id_type: effective_id_type.as_str(),
                        source: "FORM",
                        trace: TraceContext::generate(),
                    },
                )
                .await
                .map_err(|e| HrError::internal(e.to_string()))?;
                Ok(RrnStatus {
                    employee_id: employee,
                    recorded: true,
                    can_record: false,
                    masked: Some(mask::rrn()),
                    source: Some("FORM".into()),
                    recorded_at: Some(recorded_at),
                })
            })
        })
        .await;
        metrics::counter!("hr_employee_pii_total", "operation"=>"record", "outcome"=>if result.is_ok() { "allowed" } else { "refused" }).increment(1);
        result
    }
}
