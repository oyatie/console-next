//! Wire types of the access face, and their parsing into the typed model.

use console_platform_auth::PasskeyAuthenticationCredential;
use console_platform_authz::access::{
    CatalogError, Domain, Enforcement, Level, NodeKind, normalize_levels,
};
use serde::{Deserialize, Deserializer, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AccessError;

/// `Some(None)` for an explicit `null`, `None` when the field is absent.
pub(crate) fn nullable<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Deserialize)]
pub struct StepUp {
    pub ceremony_id: Uuid,
    pub credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LineIn {
    pub domain: String,
    pub levels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LineOut {
    pub domain: Domain,
    pub levels: Vec<Level>,
}

fn catalog(err: CatalogError) -> AccessError {
    AccessError::invalid(err.code(), format!("role line refused: {}", err.code()))
}

/// Parse, normalize and order role lines; one line per domain.
pub(crate) fn parse_lines(lines: &[LineIn]) -> Result<Vec<LineOut>, AccessError> {
    if lines.is_empty() {
        return Err(AccessError::invalid(
            "lines_empty",
            "a role needs at least one line",
        ));
    }
    let mut out: Vec<LineOut> = Vec::with_capacity(lines.len());
    for line in lines {
        let domain = Domain::parse(&line.domain).map_err(catalog)?;
        let levels = line
            .levels
            .iter()
            .map(|l| Level::parse(l))
            .collect::<Result<Vec<_>, _>>()
            .map_err(catalog)?;
        if out.iter().any(|o| o.domain == domain) {
            return Err(AccessError::invalid(
                "duplicate_domain_line",
                format!("domain {} appears twice", domain.as_str()),
            ));
        }
        out.push(LineOut {
            domain,
            levels: normalize_levels(domain, &levels).map_err(catalog)?,
        });
    }
    out.sort_by_key(|l| l.domain);
    Ok(out)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ScopeIn {
    pub kind: String,
    #[serde(default)]
    pub node_id: Option<Uuid>,
    #[serde(default = "yes")]
    pub include_descendants: bool,
}

const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScopeOut {
    pub kind: NodeKind,
    pub node_id: Option<Uuid>,
    pub include_descendants: bool,
}

/// A scope the pilot can enforce, or the refusal.
pub(crate) fn parse_scope(scope: &ScopeIn) -> Result<(NodeKind, Option<Uuid>), AccessError> {
    let kind = NodeKind::parse(&scope.kind)
        .ok_or_else(|| AccessError::invalid("validation", "unknown scope kind"))?;
    match (kind, scope.node_id) {
        (NodeKind::Tenant, Some(_))
        | (NodeKind::LegalEntity | NodeKind::Workplace | NodeKind::Department, None) => {
            return Err(AccessError::invalid(
                "validation",
                "node_id is required for a 법인, 사업장 or 부서 scope and absent for the tenant",
            ));
        }
        _ => {}
    }
    if !kind.enforceable_in_pilot() || !scope.include_descendants {
        return Err(AccessError::invalid(
            "scope_not_enforceable_in_pilot",
            "「이 조직만」은 아직 적용할 수 없습니다 — 하위 조직까지 포함해 고르세요",
        ));
    }
    Ok((kind, scope.node_id))
}

#[derive(Debug, Serialize)]
pub struct RoleOut {
    pub id: Uuid,
    pub name_ko: String,
    pub name_en: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub version: i32,
    pub lines: Vec<LineOut>,
    pub holder_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holders_affected: Option<Vec<Uuid>>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub struct GrantOut {
    pub id: Uuid,
    pub account_id: Uuid,
    pub account_display_name: Option<String>,
    /// people-self-46: a grant on a deactivated account grants nothing (멈춤).
    pub account_active: bool,
    /// governance-23/-32: whether the holder can sign in with a passkey yet.
    pub account_has_passkey: bool,
    /// The holder's 소속 (their employee record's 부서), when linked.
    pub account_unit: Option<String>,
    pub account_employee_number: Option<String>,
    pub role_id: Uuid,
    pub role_name_ko: String,
    pub scope: ScopeOut,
    #[serde(with = "time::serde::rfc3339")]
    pub valid_from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub valid_to: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub activates_at: Option<OffsetDateTime>,
    pub effective_in_setup: bool,
    pub enforcement: Enforcement,
    pub reason_code: String,
    pub reason_note: Option<String>,
    pub granted_by: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub granted_at: OffsetDateTime,
    pub revoked_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub revoked_at: Option<OffsetDateTime>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(domain: &str, levels: &[&str]) -> LineIn {
        LineIn {
            domain: domain.into(),
            levels: levels.iter().map(|l| (*l).to_owned()).collect(),
        }
    }

    #[test]
    fn lines_normalize_and_refuse_with_wire_codes() {
        let ok = parse_lines(&[line("org", &["view"]), line("hr_basic", &["edit"])]).unwrap();
        assert_eq!(ok[0].domain, Domain::Org);
        assert_eq!(ok[1].levels, vec![Level::View, Level::Edit]);
        let code = |l: &[LineIn]| parse_lines(l).unwrap_err().code;
        assert_eq!(code(&[]), "lines_empty");
        assert_eq!(code(&[line("payroll", &["view"])]), "domain_unknown");
        assert_eq!(
            code(&[line("discipline", &["view"])]),
            "domain_not_grantable"
        );
        assert_eq!(code(&[line("bank", &["approve"])]), "level_not_offered");
        assert_eq!(
            code(&[line("org", &["view"]), line("org", &["edit"])]),
            "duplicate_domain_line"
        );
    }

    #[test]
    fn department_scopes_parse_and_exact_scopes_are_refused_in_the_pilot() {
        let scope = |kind: &str, node: Option<Uuid>, sub: bool| ScopeIn {
            kind: kind.into(),
            node_id: node,
            include_descendants: sub,
        };
        let id = Some(Uuid::new_v4());
        assert!(parse_scope(&scope("TENANT", None, true)).is_ok());
        assert!(parse_scope(&scope("WORKPLACE", id, true)).is_ok());
        let code = |s: ScopeIn| parse_scope(&s).unwrap_err().code;
        // AX-5 (governance-22): a 부서 subtree is a scope now.
        assert!(parse_scope(&scope("DEPARTMENT", id, true)).is_ok());
        assert_eq!(
            code(scope("DEPARTMENT", id, false)),
            "scope_not_enforceable_in_pilot"
        );
        assert_eq!(
            code(scope("LEGAL_ENTITY", id, false)),
            "scope_not_enforceable_in_pilot"
        );
        assert_eq!(code(scope("LEGAL_ENTITY", None, true)), "validation");
        assert_eq!(code(scope("TENANT", id, true)), "validation");
    }
}
