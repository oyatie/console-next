use crate::error::RestError;
use crate::users::authz::parse_roles;
use crate::users::authz::role_db_strings;
use console_identity_application::AccountStatus;
use console_identity_application::DirectoryListQuery;
use console_identity_application::EmployeeLinkStatus;
use console_identity_application::MAX_DIRECTORY_PAGE_LIMIT;
use console_identity_application::UserPage;
use console_identity_application::UserSummary;
use console_identity_domain::Team;
use console_identity_domain::normalize_directory_search;
use console_kernel_core::BranchId;
use console_kernel_core::Timestamp;
use console_kernel_core::UserId;
use serde::Deserialize;
use serde::Serialize;
use uuid::Uuid;

/// Directory person already authorized for SSR. Required `DirectoryPerson`
/// keys only; never phone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisibleDirectoryPerson {
    pub id: String,
    pub display_name: String,
    pub employee_id: String,
    pub employee_name: String,
    pub employee_number: String,
    pub employee_company: String,
    pub employee_org_unit: String,
    pub employee_position: String,
    pub employee_identity_review_required: String,
    pub employee_identity_resolution_confidence: String,
    pub employee_link_status: String,
    pub team: String,
    pub roles: String,
    pub branch_ids: String,
    pub is_active: String,
    pub has_passkey: String,
    pub account_status: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DirectoryListRequest {
    #[serde(default)]
    pub(crate) search: Option<String>,
    #[serde(default)]
    pub(crate) team: Option<String>,
    #[serde(default)]
    pub(crate) branch_id: Option<String>,
    /// Comma-separated system role keys; a person matches when they hold any.
    #[serde(default)]
    pub(crate) role: Option<String>,
    #[serde(default)]
    pub(crate) include_inactive: bool,
    pub(crate) limit: Option<i64>,
    pub(crate) offset: Option<i64>,
}

impl DirectoryListRequest {
    pub(crate) fn into_query(self) -> Result<DirectoryListQuery, RestError> {
        let team = self.team.as_deref().map(parse_directory_team).transpose()?;
        let branch_id = self
            .branch_id
            .as_deref()
            .map(|value| {
                Uuid::parse_str(value)
                    .map(BranchId::from_uuid)
                    .map_err(|_| RestError::validation("branch_id must be a UUID"))
            })
            .transpose()?;
        if self
            .limit
            .is_some_and(|limit| !(1..=MAX_DIRECTORY_PAGE_LIMIT).contains(&limit))
        {
            return Err(RestError::validation("limit must be between 1 and 200"));
        }
        if self.offset.is_some_and(|offset| offset < 0) {
            return Err(RestError::validation("offset must be non-negative"));
        }
        let roles = self
            .role
            .as_deref()
            .map(|raw| {
                let keys: Vec<String> = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned)
                    .collect();
                parse_roles(&keys).map(|roles| role_db_strings(&roles))
            })
            .transpose()?
            .unwrap_or_default();
        Ok(DirectoryListQuery {
            search: normalize_directory_search(self.search.as_deref())
                .map_err(RestError::from_kernel)?,
            team,
            branch_id,
            roles,
            include_inactive: self.include_inactive,
            limit: self.limit,
            offset: self.offset,
        })
    }
}

/// Directory-only person row: `UserSummary` fields except `phone`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct DirectoryPerson {
    pub(crate) id: UserId,
    pub(crate) person_id: Option<uuid::Uuid>,
    pub(crate) principal_kind: String,
    pub(crate) display_name: String,
    /// The current sign-in ID `<아이디>@<회사 도메인>` (decisions #33).
    pub(crate) sign_in_id: Option<String>,
    pub(crate) employee_id: Option<uuid::Uuid>,
    pub(crate) employee_name: Option<String>,
    pub(crate) employee_number: Option<String>,
    pub(crate) employee_company: Option<String>,
    pub(crate) employee_org_unit: Option<String>,
    pub(crate) employee_position: Option<String>,
    pub(crate) employee_identity_review_required: Option<bool>,
    pub(crate) employee_identity_resolution_confidence: Option<String>,
    pub(crate) employee_link_status: EmployeeLinkStatus,
    pub(crate) team: Option<Team>,
    pub(crate) roles: Vec<String>,
    pub(crate) branch_ids: Vec<BranchId>,
    pub(crate) is_active: bool,
    pub(crate) is_tenant_ops: bool,
    pub(crate) has_passkey: bool,
    pub(crate) account_status: AccountStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) created_at: Timestamp,
}

impl From<UserSummary> for VisibleDirectoryPerson {
    fn from(user: UserSummary) -> Self {
        use time::format_description::well_known::Rfc3339;
        let UserSummary {
            id,
            person_id: _,
            principal_kind: _,
            name_unset: _,
            display_name,
            sign_in_id: _,
            employee_id,
            employee_name,
            employee_number,
            employee_company,
            employee_org_unit,
            employee_position,
            employee_identity_review_required,
            employee_identity_resolution_confidence,
            employee_link_status,
            phone: _,
            team,
            roles,
            branch_ids,
            is_active,
            is_tenant_ops: _,
            has_passkey,
            account_status,
            created_at,
        } = user;
        Self {
            id: id.to_string(),
            display_name,
            employee_id: employee_id
                .map(|value| value.to_string())
                .unwrap_or_default(),
            employee_name: employee_name.unwrap_or_default(),
            employee_number: employee_number.unwrap_or_default(),
            employee_company: employee_company.unwrap_or_default(),
            employee_org_unit: employee_org_unit.unwrap_or_default(),
            employee_position: employee_position.unwrap_or_default(),
            employee_identity_review_required: employee_identity_review_required
                .map(|value| value.to_string())
                .unwrap_or_default(),
            employee_identity_resolution_confidence: employee_identity_resolution_confidence
                .unwrap_or_default(),
            employee_link_status: match employee_link_status {
                EmployeeLinkStatus::Linked => "LINKED".to_owned(),
                EmployeeLinkStatus::Unlinked => "UNLINKED".to_owned(),
            },
            team: team.map(|value| value.to_string()).unwrap_or_default(),
            roles: roles.join(","),
            branch_ids: branch_ids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(","),
            is_active: is_active.to_string(),
            has_passkey: has_passkey.to_string(),
            account_status: match account_status {
                AccountStatus::Active => "ACTIVE".to_owned(),
                AccountStatus::PendingSetup => "PENDING_SETUP".to_owned(),
                AccountStatus::Archived => "ARCHIVED".to_owned(),
            },
            created_at: created_at.format(&Rfc3339).unwrap_or_default(),
        }
    }
}

impl From<UserSummary> for DirectoryPerson {
    fn from(user: UserSummary) -> Self {
        let UserSummary {
            id,
            person_id,
            principal_kind,
            name_unset: _,
            display_name,
            sign_in_id,
            employee_id,
            employee_name,
            employee_number,
            employee_company,
            employee_org_unit,
            employee_position,
            employee_identity_review_required,
            employee_identity_resolution_confidence,
            employee_link_status,
            phone: _,
            team,
            roles,
            branch_ids,
            is_active,
            is_tenant_ops,
            has_passkey,
            account_status,
            created_at,
        } = user;
        Self {
            id,
            person_id,
            principal_kind,
            display_name,
            sign_in_id,
            employee_id,
            employee_name,
            employee_number,
            employee_company,
            employee_org_unit,
            employee_position,
            employee_identity_review_required,
            employee_identity_resolution_confidence,
            employee_link_status,
            team,
            roles,
            branch_ids,
            is_active,
            is_tenant_ops,
            has_passkey,
            account_status,
            created_at,
        }
    }
}

/// Directory-only page. Items never include a `phone` key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct DirectoryPage {
    pub(crate) items: Vec<DirectoryPerson>,
    pub(crate) limit: i64,
    pub(crate) offset: i64,
    pub(crate) total: i64,
}

impl From<UserPage> for DirectoryPage {
    fn from(page: UserPage) -> Self {
        let UserPage {
            items,
            limit,
            offset,
            total,
        } = page;
        Self {
            items: items.into_iter().map(DirectoryPerson::from).collect(),
            limit,
            offset,
            total,
        }
    }
}

pub(crate) fn parse_directory_team(value: &str) -> Result<Team, RestError> {
    match value {
        "MAINTENANCE" => Ok(Team::Maintenance),
        "PREVENTION" => Ok(Team::Prevention),
        "MANAGEMENT" => Ok(Team::Management),
        "RECEPTION" => Ok(Team::Reception),
        _ => Err(RestError::validation("team is invalid")),
    }
}

#[cfg(test)]
mod directory_query_tests {
    use super::*;
    use crate::OPENAPI_FRAGMENT;
    use crate::authz::directory_read_scope;
    use axum::http::StatusCode;
    use console_identity_application::AccountStatus;
    use console_identity_application::EmployeeLinkStatus;
    use console_identity_application::MAX_DIRECTORY_PAGE_LIMIT;
    use console_identity_application::UserPage;
    use console_identity_application::UserSummary;
    use console_identity_domain::Team;
    use console_kernel_core::BranchId;
    use console_kernel_core::BranchScope;
    use console_kernel_core::OrgId;
    use console_kernel_core::UserId;
    use console_platform_authz::Feature;
    use console_platform_authz::PermissionLevel;
    use console_platform_authz::Principal;
    use console_platform_authz::Role;
    use std::collections::BTreeSet;
    use time::OffsetDateTime;

    #[test]
    fn directory_scope_intersects_custom_grants_with_live_membership() {
        let member_branch = BranchId::new();
        let granted_branch = BranchId::new();
        let outside_branch = BranchId::new();
        let principal = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::new(),
            BranchScope::Branches(BTreeSet::from([member_branch, granted_branch])),
        )
        .with_effective_feature_grants(vec![
            console_platform_authz::EffectiveFeatureGrant::new(
                Feature::EmployeeDirectoryRead,
                PermissionLevel::Allow,
                BranchScope::Branches(BTreeSet::from([granted_branch, outside_branch])),
            ),
        ]);

        assert_eq!(
            directory_read_scope(&principal).unwrap(),
            BranchScope::Branches(BTreeSet::from([granted_branch]))
        );
    }

    #[test]
    fn directory_scope_denies_principal_without_role_or_runtime_grant() {
        let principal = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::Member]),
            BranchScope::single(BranchId::new()),
        );

        let error = directory_read_scope(&principal).expect_err("no grant must fail closed");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn directory_scope_unions_only_live_membership_intersections() {
        let member_a = BranchId::new();
        let member_b = BranchId::new();
        let outside = BranchId::new();
        let principal = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::Member]),
            BranchScope::Branches(BTreeSet::from([member_a, member_b])),
        )
        .with_effective_feature_grants(vec![
            console_platform_authz::EffectiveFeatureGrant::new(
                Feature::EmployeeDirectoryRead,
                PermissionLevel::Allow,
                BranchScope::Branches(BTreeSet::from([member_a, outside])),
            ),
            console_platform_authz::EffectiveFeatureGrant::new(
                Feature::EmployeeDirectoryRead,
                PermissionLevel::Allow,
                BranchScope::Branches(BTreeSet::from([member_b, outside])),
            ),
        ]);

        assert_eq!(
            directory_read_scope(&principal).unwrap(),
            BranchScope::Branches(BTreeSet::from([member_a, member_b]))
        );
    }

    #[test]
    fn directory_request_rejects_malformed_filters() {
        let invalid_team = DirectoryListRequest {
            search: None,
            team: Some("unknown".to_owned()),
            branch_id: None,
            role: None,
            include_inactive: false,
            limit: None,
            offset: None,
        };
        assert_eq!(
            invalid_team.into_query().unwrap_err().status,
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let invalid_offset = DirectoryListRequest {
            search: None,
            team: None,
            branch_id: None,
            role: None,
            include_inactive: false,
            limit: Some(10),
            offset: Some(-1),
        };
        assert_eq!(
            invalid_offset.into_query().unwrap_err().status,
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let oversized_limit = DirectoryListRequest {
            search: None,
            team: None,
            branch_id: None,
            role: None,
            include_inactive: false,
            limit: Some(MAX_DIRECTORY_PAGE_LIMIT + 1),
            offset: None,
        };
        assert_eq!(
            oversized_limit.into_query().unwrap_err().status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn directory_person_json_omits_phone_while_user_summary_keeps_it() {
        let stored_phone = "010-1234-5678";
        let user = UserSummary {
            person_id: None,
            principal_kind: "TENANT_PERSON".into(),
            id: UserId::new(),
            display_name: "directory subject".to_owned(),
            name_unset: None,
            sign_in_id: Some("e-000001@acme".to_owned()),
            employee_id: None,
            employee_name: None,
            employee_number: None,
            employee_company: None,
            employee_org_unit: None,
            employee_position: None,
            employee_identity_review_required: None,
            employee_identity_resolution_confidence: None,
            employee_link_status: EmployeeLinkStatus::Unlinked,
            phone: Some(stored_phone.to_owned()),
            team: Some(Team::Maintenance),
            roles: vec!["MECHANIC".to_owned()],
            branch_ids: vec![BranchId::new()],
            is_active: true,
            is_tenant_ops: false,
            has_passkey: true,
            account_status: AccountStatus::Active,
            created_at: OffsetDateTime::now_utc(),
        };
        let user_json = serde_json::to_value(&user).expect("user summary json");
        assert_eq!(user_json["phone"], stored_phone);
        assert!(
            user_json["created_at"].is_string(),
            "created_at must be RFC 3339"
        );

        let directory_json = serde_json::to_value(DirectoryPage::from(UserPage {
            items: vec![user],
            limit: 50,
            offset: 0,
            total: 1,
        }))
        .expect("directory page json");
        let item = &directory_json["items"][0];
        assert!(
            item["created_at"].is_string(),
            "created_at must be RFC 3339"
        );
        let keys = item
            .as_object()
            .expect("directory item must be an object")
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        let allowed = [
            "person_id",
            "principal_kind",
            "id",
            "display_name",
            "sign_in_id",
            "employee_id",
            "employee_name",
            "employee_number",
            "employee_company",
            "employee_org_unit",
            "employee_position",
            "employee_identity_review_required",
            "employee_identity_resolution_confidence",
            "employee_link_status",
            "team",
            "roles",
            "branch_ids",
            "is_active",
            "is_tenant_ops",
            "has_passkey",
            "account_status",
            "created_at",
        ]
        .into_iter()
        .collect::<BTreeSet<_>>();
        assert_eq!(
            keys, allowed,
            "directory item JSON keys must match the DirectoryPerson allowlist"
        );
        for forbidden in ["phone", "salary", "bank_account", "rrn", "won"] {
            assert!(
                item.get(forbidden).is_none(),
                "directory item must omit {forbidden}; keys={keys:?}"
            );
        }
        assert_eq!(item["display_name"], "directory subject");
    }

    #[test]
    fn identity_face_composes_directory_schemas() {
        let composed = console_contracts::compose(&[&OPENAPI_FRAGMENT]).expect("identity fragment");
        assert!(
            composed.contains("    DirectoryPerson:\n"),
            "composed fragment missing DirectoryPerson"
        );
        assert!(
            composed.contains("    DirectoryPage:\n"),
            "composed fragment missing DirectoryPage"
        );

        let directory_person = include_str!("../../openapi/schemas/DirectoryPerson.yaml");
        let property_names = yaml_map_keys(directory_person, "properties:");
        assert!(
            !property_names.contains(&"phone"),
            "DirectoryPerson OpenAPI must not include phone; properties={property_names:?}"
        );
    }

    fn yaml_map_keys<'a>(schema: &'a str, header: &str) -> Vec<&'a str> {
        let Some((_, body)) = schema.split_once(header) else {
            return Vec::new();
        };
        body.lines()
            .filter_map(|line| {
                let name = line.strip_prefix("  ")?;
                if name.starts_with(' ') || name.starts_with('#') {
                    return None;
                }
                name.strip_suffix(':')
            })
            .collect()
    }
}
