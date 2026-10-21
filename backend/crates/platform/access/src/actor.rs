//! The caller as the access engine sees it, and the checks every handler uses:
//! a Cedar decision over the caller's own grants (ops passes by the platform
//! policy), the passkey step-up, the reason code, and scope-node lookup.

use console_kernel_core::OrgId;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::Principal;
use console_platform_authz::access::{
    AccessSlice, AccessSubject, Domain, Level, NodeKind, NodePath, action_group, dept_path,
    load_access_subject, scope_path,
};
use console_settings_domain::code_lists::{
    ReasonDomain, TenantCode, is_tenant_code, validate_reason as check_reason,
};
use sqlx::Row;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::AccessService;
use crate::dto::StepUp;
use crate::error::{AccessError, AccessResult, Refusal};

pub(crate) struct Actor {
    pub principal: Principal,
    pub subject: AccessSubject,
    slice: Option<AccessSlice>,
}

impl Actor {
    /// Load the caller inside `tx` (the same transaction as the write it guards).
    pub(crate) async fn load(
        tx: &mut Transaction<'_, Postgres>,
        principal: &Principal,
    ) -> AccessResult<Self> {
        let subject = load_access_subject(
            tx,
            principal.org_id,
            *principal.user_id.as_uuid(),
            OffsetDateTime::now_utc(),
        )
        .await?;
        let slice = AccessSlice::compile(&subject)
            .map_err(|e| tracing::warn!(error = %e, "authz_eval_error: caller slice refused"))
            .ok();
        Ok(Self {
            principal: principal.clone(),
            subject,
            slice,
        })
    }

    pub(crate) fn org(&self) -> OrgId {
        self.principal.org_id
    }

    pub(crate) fn id(&self) -> Uuid {
        *self.principal.user_id.as_uuid()
    }

    pub(crate) fn tenant(&self) -> NodePath {
        NodePath::tenant(self.org())
    }

    /// Does the caller hold `domain` × `level` over `at`? Any engine error is no.
    pub(crate) fn may(&self, domain: Domain, level: Level, at: &NodePath) -> bool {
        self.slice.as_ref().is_some_and(|s| {
            s.allows(&action_group(domain, level), at)
                .map_err(|e| tracing::warn!(error = %e, "authz_eval_error: decision denied"))
                .unwrap_or(false)
        })
    }

    /// Grantor ceiling (GR-7): the caller already holds every (domain, level)
    /// of `lines` over `at`, or 403 `grant_exceeds_grantor`.
    pub(crate) fn require_holds(
        &self,
        lines: &[crate::dto::LineOut],
        at: &NodePath,
    ) -> AccessResult<()> {
        for line in lines {
            for level in &line.levels {
                if !self.may(line.domain, *level, at) {
                    return Err(AccessError::forbidden(
                        "grant_exceeds_grantor",
                        format!(
                            "본인이 가진 권한까지만 줄 수 있습니다 ({})",
                            action_group(line.domain, *level)
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    /// 권한 관리 `level` over some node (or ops), or 403 `access_denied`.
    pub(crate) fn require_some_access(&self, level: Level) -> AccessResult<()> {
        let holds = self.subject.is_ops
            || self.subject.grants.iter().any(|g| {
                g.lines
                    .iter()
                    .any(|l| l.domain == Domain::Access && l.levels.contains(&level))
                    && self.may(Domain::Access, level, &g.scope)
            });
        if holds {
            Ok(())
        } else {
            Err(AccessError::access_denied())
        }
    }

    /// 권한 관리 `level` over the whole tenant, or 403 `access_denied`.
    pub(crate) fn require_access(&self, level: Level) -> AccessResult<()> {
        if self.may(Domain::Access, level, &self.tenant()) {
            Ok(())
        } else {
            Err(AccessError::access_denied())
        }
    }
}

/// Load the caller in a read transaction of its own.
pub(crate) async fn read_actor(
    state: &AccessService,
    principal: &Principal,
) -> AccessResult<Actor> {
    let principal = principal.clone();
    console_platform_db::with_org_conn::<_, _, AccessError>(&state.pool, principal.org_id, |tx| {
        Box::pin(async move { Actor::load(tx, &principal).await })
    })
    .await
}

/// 428 without an assertion, 401 when it does not verify for the caller.
pub(crate) async fn verify_step_up(
    state: &AccessService,
    principal: &Principal,
    step_up: Option<StepUp>,
) -> AccessResult<()> {
    let step_up = step_up.ok_or_else(|| {
        AccessError::new(
            Refusal::StepUpRequired,
            "passkey_step_up_required",
            "권한 부여에는 패스키 재인증이 필요합니다 (a fresh passkey step-up is required)",
        )
    })?;
    let verifier = state.step_up.as_ref().ok_or_else(|| {
        AccessError::new(
            Refusal::Unavailable,
            "unavailable",
            "passkey step-up is not configured",
        )
    })?;
    verifier
        .verify_step_up_for_user(
            &state.pool,
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|_| {
            AccessError::new(
                Refusal::StepUpFailed,
                "unauthorized",
                "passkey step-up failed",
            )
        })
}

/// A `role_change` reason (system or tenant code; `OTHER` needs a note): the
/// settings domain's own rule over the tenant's code row, read here.
pub(crate) async fn validate_reason(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    code: &str,
    note: Option<&str>,
) -> AccessResult<()> {
    let domain = ReasonDomain::RoleChange;
    let mut tenant = Vec::new();
    if is_tenant_code(code) {
        let row = sqlx::query(
            "SELECT requires_note, active FROM reason_codes WHERE org_id = $1 AND domain = $2 AND code = $3",
        )
        .bind(org.as_uuid())
        .bind(domain.as_str())
        .bind(code)
        .fetch_optional(tx.as_mut())
        .await?;
        if let Some(row) = row {
            tenant.push(TenantCode {
                code: code.to_owned(),
                requires_note: row.try_get("requires_note")?,
                active: row.try_get("active")?,
            });
        }
    }
    check_reason(domain, code, note, &tenant).map_err(KernelError::from)?;
    Ok(())
}

/// The audit row of an access write, carrying the request's trace and client.
pub(crate) fn audit(
    principal: &Principal,
    action: &'static str,
    target_type: &str,
    target: Uuid,
) -> AccessResult<AuditEvent> {
    let ctx = console_platform_request_context::current_audit_context();
    let trace = ctx
        .as_ref()
        .map_or_else(TraceContext::generate, |c| c.trace.clone());
    let event = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new(action)?,
        target_type,
        target.to_string(),
        trace,
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id);
    Ok(match ctx {
        Some(c) => event.with_request_context(c.request),
        None => event,
    })
}

/// The scope chain of a live 법인, 사업장 or 부서 (404 `scope_node_not_found`;
/// a 부서 that is dissolved or sits under no 사업장 has no chain).
pub(crate) async fn node_path(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    kind: NodeKind,
    node: Option<Uuid>,
) -> AccessResult<NodePath> {
    let missing =
        || AccessError::not_found("scope_node_not_found", "no such live 법인, 사업장 or 부서");
    let le: Option<Uuid> = match (kind, node) {
        (NodeKind::Tenant, _) => return Ok(NodePath::tenant(org)),
        (NodeKind::Department, Some(id)) => {
            let path = dept_path(tx, org, id).await?;
            let reaches = path.0.last().is_some_and(|n| n.kind == NodeKind::Tenant);
            return if reaches { Ok(path) } else { Err(missing()) };
        }
        (NodeKind::LegalEntity, Some(id)) => sqlx::query_scalar(
            "SELECT id FROM legal_entities WHERE org_id = $1 AND id = $2 AND voided_at IS NULL",
        )
        .bind(org.as_uuid())
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?,
        (NodeKind::Workplace, Some(id)) => sqlx::query_scalar(
            "SELECT legal_entity_id FROM workplaces WHERE org_id = $1 AND id = $2 AND voided_at IS NULL",
        )
        .bind(org.as_uuid())
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?,
        _ => None,
    };
    let le = le.ok_or_else(missing)?;
    Ok(scope_path(org, kind, node, Some(le)))
}

/// company-21: a new grant never names a closed 법인 or 사업장 (or a 부서
/// inside one): 409 `scope_node_closed`.
pub(crate) async fn refuse_closed(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    path: &NodePath,
) -> AccessResult<()> {
    let ids = |kind: NodeKind| -> Vec<Uuid> {
        path.0
            .iter()
            .filter(|n| n.kind == kind)
            .map(|n| n.id)
            .collect()
    };
    let closed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM legal_entities WHERE org_id = $1 AND id = ANY($2) AND closed_on IS NOT NULL)
             OR EXISTS (SELECT 1 FROM workplaces WHERE org_id = $1 AND id = ANY($3) AND closed_on IS NOT NULL)",
    )
    .bind(org.as_uuid())
    .bind(ids(NodeKind::LegalEntity))
    .bind(ids(NodeKind::Workplace))
    .fetch_one(tx.as_mut())
    .await?;
    if closed {
        return Err(AccessError::conflict(
            "scope_node_closed",
            "종료된 법인이나 사업장에는 권한을 줄 수 없습니다 (the scope is closed)",
        ));
    }
    Ok(())
}
