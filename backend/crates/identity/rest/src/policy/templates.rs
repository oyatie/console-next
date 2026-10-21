use crate::policy::dto::PolicyDefaultPermissionResponse;
use crate::policy::dto::PolicyFeatureResponse;
use crate::policy::dto::PolicyPermissionResponse;
use crate::policy::dto::PolicyRoleTemplateResponse;
use crate::policy::dto::SystemPolicyRoleResponse;
use crate::policy::runtime::is_elevated_policy_feature;
use crate::policy::runtime::policy_studio_feature_visible;
use console_platform_authz::Feature;
use console_platform_authz::PermissionLevel;
use console_platform_authz::Role;
use console_platform_authz::permission_for;

pub(crate) fn policy_feature_catalog() -> Vec<PolicyFeatureResponse> {
    Feature::ALL
        .into_iter()
        .filter(|feature| policy_studio_feature_visible(*feature))
        .map(|feature| PolicyFeatureResponse {
            feature_key: feature.as_str().to_owned(),
            elevated: is_elevated_policy_feature(feature),
            default_permissions: Role::ALL
                .into_iter()
                .map(|role| PolicyDefaultPermissionResponse {
                    role_key: role.as_str().to_owned(),
                    permission_level: permission_for(role, feature).as_str().to_owned(),
                })
                .collect(),
        })
        .collect()
}

pub(crate) fn system_policy_roles() -> Vec<SystemPolicyRoleResponse> {
    Role::ALL
        .into_iter()
        .map(|role| SystemPolicyRoleResponse {
            role_key: role.as_str().to_owned(),
            display_name: role.as_str().to_owned(),
            status: "ACTIVE".to_owned(),
            is_system: true,
            permissions: Feature::ALL
                .into_iter()
                .filter(|feature| policy_studio_feature_visible(*feature))
                .map(|feature| PolicyPermissionResponse {
                    feature_key: feature.as_str().to_owned(),
                    permission_level: permission_for(role, feature).as_str().to_owned(),
                })
                .collect(),
        })
        .collect()
}

pub(crate) fn policy_role_templates() -> Vec<PolicyRoleTemplateResponse> {
    use Feature::{
        AssigneeManage, CompletionReview, DailyPlanRequest, DailyPlanReview,
        EmployeeDirectoryManage, EmployeeDirectoryRead, EquipmentCostLedgerRead, EquipmentManage,
        EvidenceAttach, ExcelDownload, KpiRead, MailUse, OpsDashboardRead, PurchaseRequestApprove,
        PurchaseRequestCreate, PurchaseRequestRead, RentalQuoteManage, SalesManage, TargetManage,
        WorkOrderCreate, WorkOrderEditIntake, WorkOrderReadAll, WorkOrderStart, WorkReportSubmit,
    };
    use PermissionLevel::{Allow, Limited, RequestOnly};

    vec![
        role_template(
            "branch_operations_manager",
            "branch_operations_manager",
            "지점 운영 관리자",
            "operations",
            "지점 단위 작업 흐름, 일일 계획 검토, 배정 조율을 담당합니다.",
            &[
                (WorkOrderReadAll, Allow),
                (DailyPlanReview, Allow),
                (CompletionReview, Allow),
                (AssigneeManage, Limited),
                (TargetManage, RequestOnly),
                (OpsDashboardRead, Limited),
            ],
        ),
        role_template(
            "dispatch_reception",
            "dispatch_reception",
            "접수·배차 코디네이터",
            "operations",
            "접수, 작업 생성, 고객/현장 연락, 기본 배차 보조를 담당합니다.",
            &[
                (WorkOrderCreate, Allow),
                (WorkOrderEditIntake, Allow),
                (WorkOrderReadAll, Allow),
                (TargetManage, RequestOnly),
                (MailUse, Allow),
            ],
        ),
        role_template(
            "site_operations",
            "site_operations",
            "현장 운영 담당자",
            "field_operations",
            "현장 작업 진행, 작업 보고, 증빙 첨부, 일일 계획 요청을 담당합니다.",
            &[
                (WorkOrderReadAll, Allow),
                (WorkOrderStart, Allow),
                (WorkReportSubmit, Allow),
                (EvidenceAttach, Allow),
                (DailyPlanRequest, RequestOnly),
            ],
        ),
        role_template(
            "security_guard",
            "security_guard",
            "경비 담당자",
            "security_operations",
            "현장 출입·안전 이슈를 접수하고 제한된 작업 현황과 증빙을 기록합니다.",
            &[
                (WorkOrderReadAll, Limited),
                (WorkOrderCreate, RequestOnly),
                (WorkReportSubmit, Limited),
                (EvidenceAttach, Limited),
            ],
        ),
        role_template(
            "cleaning_staff",
            "cleaning_staff",
            "미화 담당자",
            "cleaning_operations",
            "미화 작업 배정을 확인하고 완료 보고와 현장 증빙을 남깁니다.",
            &[
                (WorkOrderReadAll, Limited),
                (WorkOrderStart, Limited),
                (WorkReportSubmit, Allow),
                (EvidenceAttach, Limited),
                (DailyPlanRequest, RequestOnly),
            ],
        ),
        role_template(
            "dispatch_office_staff",
            "dispatch_office_staff",
            "파견사무 담당자",
            "dispatch_office",
            "파견사무 접수, 작업 생성·수정, 현장 연락과 기본 대상 변경 요청을 담당합니다.",
            &[
                (WorkOrderCreate, Allow),
                (WorkOrderEditIntake, Allow),
                (WorkOrderReadAll, Allow),
                (TargetManage, RequestOnly),
                (MailUse, Allow),
            ],
        ),
        role_template(
            "asset_cost_analyst",
            "asset_cost_analyst",
            "자산 비용 분석가",
            "finance",
            "장비 원가, KPI, 구매 조회를 분석하되 승인 권한은 별도로 요청합니다.",
            &[
                (EquipmentCostLedgerRead, Allow),
                (KpiRead, Allow),
                (PurchaseRequestRead, Allow),
                (ExcelDownload, Limited),
            ],
        ),
        role_template(
            "purchasing_requester",
            "purchasing_requester",
            "구매 요청 담당자",
            "finance",
            "구매 요청을 작성하고 진행 상태를 추적합니다.",
            &[(PurchaseRequestCreate, Allow), (PurchaseRequestRead, Allow)],
        ),
        role_template(
            "purchase_reviewer",
            "purchase_reviewer",
            "구매 검토자",
            "finance",
            "구매 요청을 조회하고 제한된 승인 검토를 수행합니다.",
            &[
                (PurchaseRequestRead, Allow),
                (PurchaseRequestApprove, Limited),
            ],
        ),
        role_template(
            "people_ops_manager",
            "people_ops_manager",
            "HR 운영 관리자",
            "people",
            "직원 디렉터리와 조직 기본 정보를 관리합니다. 로그인 사용자 권한 관리는 포함하지 않습니다.",
            &[
                (EmployeeDirectoryRead, Allow),
                (EmployeeDirectoryManage, Allow),
                (ExcelDownload, Limited),
            ],
        ),
        role_template(
            "inspection_coordinator",
            "inspection_coordinator",
            "검사 일정 코디네이터",
            "assets",
            "검사 일정과 라운드 완료를 조율하고 장비 정보 변경은 제한적으로 요청합니다.",
            &[
                (EquipmentManage, Limited),
                (Feature::InspectionScheduleManage, Allow),
                (Feature::InspectionRoundComplete, Limited),
                (WorkOrderReadAll, Allow),
            ],
        ),
        role_template(
            "sales_service_coordinator",
            "sales_service_coordinator",
            "영업·서비스 코디네이터",
            "customer",
            "렌탈 견적, 판매 문의, 회사 메일 기반 고객 응대를 담당합니다.",
            &[
                (RentalQuoteManage, Limited),
                (SalesManage, Limited),
                (MailUse, Allow),
                (WorkOrderReadAll, Limited),
            ],
        ),
    ]
}

pub(crate) fn role_template(
    template_key: &str,
    role_key: &str,
    display_name: &str,
    category: &str,
    description: &str,
    permissions: &[(Feature, PermissionLevel)],
) -> PolicyRoleTemplateResponse {
    PolicyRoleTemplateResponse {
        template_key: template_key.to_owned(),
        role_key: role_key.to_owned(),
        display_name: display_name.to_owned(),
        category: category.to_owned(),
        description: description.to_owned(),
        permissions: permissions
            .iter()
            .map(|(feature, level)| PolicyPermissionResponse {
                feature_key: feature.as_str().to_owned(),
                permission_level: level.as_str().to_owned(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod policy_role_template_tests {
    use super::*;
    use crate::policy::convert::build_policy_role_status_preview;
    use crate::policy::delegation::ensure_policy_roles_inside_actor_permission_ceiling;
    use crate::policy::dto::PolicyConditionResponse;
    use crate::policy::dto::PolicyPermissionResponse;
    use crate::policy::dto::PolicyRoleResponse;
    use crate::policy::dto::PolicyRoleTemplateResponse;
    use crate::policy::runtime::is_elevated_policy_feature;
    use crate::policy::validate::validate_policy_conditions;
    use crate::policy::validate::validate_policy_permissions;
    use axum::http::StatusCode;
    use console_identity_application::PolicyRoleCondition;
    use console_identity_application::PolicyRolePermission;
    use console_identity_application::PolicyRoleSummary;
    use console_kernel_core::BranchId;
    use console_kernel_core::BranchScope;
    use console_kernel_core::UserId;
    use console_platform_authz::Feature;
    use console_platform_authz::PermissionLevel;
    use console_platform_authz::Principal;
    use console_platform_authz::Role;
    use console_platform_authz::custom_role_runtime_feature_allowed;
    use std::collections::BTreeSet;
    use std::str::FromStr;
    use time::OffsetDateTime;
    use uuid::Uuid;

    fn policy_role_for_test(
        role_key: &str,
        permissions: &[(&str, &str)],
        conditions: Vec<PolicyRoleCondition>,
    ) -> PolicyRoleSummary {
        PolicyRoleSummary {
            id: Uuid::new_v4(),
            role_key: role_key.to_owned(),
            display_name: role_key.to_owned(),
            description: None,
            status: "ACTIVE".to_owned(),
            is_system: false,
            permissions: permissions
                .iter()
                .map(|(feature_key, permission_level)| PolicyRolePermission {
                    feature_key: (*feature_key).to_owned(),
                    permission_level: (*permission_level).to_owned(),
                })
                .collect(),
            conditions,
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
        }
    }

    fn branch_condition(branch: BranchId) -> PolicyRoleCondition {
        PolicyRoleCondition {
            condition_key: "branch_scope".to_owned(),
            attribute: "branch".to_owned(),
            operator: "equals".to_owned(),
            values: vec![branch.to_string()],
        }
    }

    #[test]
    fn assignment_ceiling_rejects_capability_actor_does_not_hold() {
        let branch = BranchId::new();
        let principal = Principal::new(
            UserId::new(),
            console_kernel_core::OrgId::one(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(branch),
        );
        let final_approval_role = policy_role_for_test(
            "final_approval_delegate",
            &[("purchase_final_approve", "allow")],
            vec![branch_condition(branch)],
        );

        let error =
            ensure_policy_roles_inside_actor_permission_ceiling(&principal, &[final_approval_role])
                .unwrap_err();

        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.code, "forbidden");
        assert_eq!(
            error.message,
            "policy role permission exceeds delegated authority"
        );
    }

    #[test]
    fn assignment_ceiling_requires_custom_grant_scope_to_cover_role_scope() {
        let allowed_branch = BranchId::new();
        let blocked_branch = BranchId::new();
        let principal = Principal::new(
            UserId::new(),
            console_kernel_core::OrgId::one(),
            BTreeSet::from([Role::Member]),
            BranchScope::Branches(BTreeSet::from([allowed_branch, blocked_branch])),
        )
        .with_effective_feature_grants(vec![
            console_platform_authz::EffectiveFeatureGrant::new(
                Feature::WorkOrderCreate,
                PermissionLevel::Allow,
                BranchScope::single(allowed_branch),
            ),
        ]);
        let allowed_role = policy_role_for_test(
            "allowed_branch_creator",
            &[("work_order_create", "allow")],
            vec![branch_condition(allowed_branch)],
        );
        let blocked_role = policy_role_for_test(
            "blocked_branch_creator",
            &[("work_order_create", "allow")],
            vec![branch_condition(blocked_branch)],
        );

        ensure_policy_roles_inside_actor_permission_ceiling(&principal, &[allowed_role]).unwrap();
        let error =
            ensure_policy_roles_inside_actor_permission_ceiling(&principal, &[blocked_role])
                .unwrap_err();

        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(
            error.message,
            "policy role permission exceeds delegated authority"
        );
    }

    #[test]
    fn assignment_ceiling_requires_elevated_grant_for_user_management_roles() {
        let branch = BranchId::new();
        let admin = Principal::new(
            UserId::new(),
            console_kernel_core::OrgId::one(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(branch),
        );
        let super_admin = Principal::new(
            UserId::new(),
            console_kernel_core::OrgId::one(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::single(branch),
        );
        let user_manager = policy_role_for_test(
            "user_manager_delegate",
            &[("user_manage", "allow")],
            vec![branch_condition(branch)],
        );

        let error = ensure_policy_roles_inside_actor_permission_ceiling(
            &admin,
            std::slice::from_ref(&user_manager),
        )
        .unwrap_err();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(
            error.message,
            "elevated policy role assignments require elevated role grant"
        );
        ensure_policy_roles_inside_actor_permission_ceiling(&super_admin, &[user_manager]).unwrap();
    }

    #[test]
    fn role_templates_are_unique_non_empty_and_never_grant_elevated_policy_features() {
        let templates = policy_role_templates();
        assert!(
            templates.len() >= 12,
            "expected enterprise starter coverage"
        );

        let mut template_keys = BTreeSet::new();
        let mut role_keys = BTreeSet::new();
        for template in templates {
            assert!(template_keys.insert(template.template_key.clone()));
            assert!(role_keys.insert(template.role_key.clone()));
            assert!(!template.display_name.trim().is_empty());
            assert!(!template.category.trim().is_empty());
            assert!(!template.permissions.is_empty());
            for permission in template.permissions {
                let feature = Feature::from_str(&permission.feature_key).unwrap();
                assert!(
                    !is_elevated_policy_feature(feature),
                    "template {} grants elevated feature {}",
                    template.template_key,
                    permission.feature_key
                );
                assert!(
                    !matches!(feature, Feature::UserManage),
                    "template {} grants admin user-management feature {}",
                    template.template_key,
                    permission.feature_key
                );
                let level = PermissionLevel::from_str(&permission.permission_level).unwrap();
                assert!(!matches!(level, PermissionLevel::Deny));
            }
        }
    }

    #[test]
    fn operational_persona_templates_cover_approved_role_set() {
        let templates = policy_role_templates();

        let find_template = |key: &str| {
            templates
                .iter()
                .find(|template| template.template_key == key)
                .unwrap_or_else(|| panic!("missing role template {key}"))
        };
        let assert_permissions = |template: &PolicyRoleTemplateResponse,
                                  expected: &[(&str, &str)]| {
            let actual: BTreeSet<(&str, &str)> = template
                .permissions
                .iter()
                .map(|permission| {
                    (
                        permission.feature_key.as_str(),
                        permission.permission_level.as_str(),
                    )
                })
                .collect();
            let expected: BTreeSet<(&str, &str)> = expected.iter().copied().collect();
            assert_eq!(actual, expected, "template {}", template.template_key);
        };

        let site = find_template("site_operations");
        assert_eq!(site.role_key, "site_operations");
        assert_eq!(site.display_name, "현장 운영 담당자");
        assert_eq!(site.category, "field_operations");
        assert_permissions(
            site,
            &[
                ("work_order_read_all", "allow"),
                ("work_order_start", "allow"),
                ("work_report_submit", "allow"),
                ("evidence_attach", "allow"),
                ("daily_plan_request", "request_only"),
            ],
        );

        let security = find_template("security_guard");
        assert_eq!(security.role_key, "security_guard");
        assert_eq!(security.display_name, "경비 담당자");
        assert_eq!(security.category, "security_operations");
        assert_permissions(
            security,
            &[
                ("work_order_read_all", "limited"),
                ("work_order_create", "request_only"),
                ("work_report_submit", "limited"),
                ("evidence_attach", "limited"),
            ],
        );

        let cleaning = find_template("cleaning_staff");
        assert_eq!(cleaning.role_key, "cleaning_staff");
        assert_eq!(cleaning.display_name, "미화 담당자");
        assert_eq!(cleaning.category, "cleaning_operations");
        assert_permissions(
            cleaning,
            &[
                ("work_order_read_all", "limited"),
                ("work_order_start", "limited"),
                ("work_report_submit", "allow"),
                ("evidence_attach", "limited"),
                ("daily_plan_request", "request_only"),
            ],
        );

        let dispatch_office = find_template("dispatch_office_staff");
        assert_eq!(dispatch_office.role_key, "dispatch_office_staff");
        assert_eq!(dispatch_office.display_name, "파견사무 담당자");
        assert_eq!(dispatch_office.category, "dispatch_office");
        assert_permissions(
            dispatch_office,
            &[
                ("work_order_create", "allow"),
                ("work_order_edit_intake", "allow"),
                ("work_order_read_all", "allow"),
                ("target_manage", "request_only"),
                ("mail_use", "allow"),
            ],
        );
    }

    #[test]
    fn policy_studio_quarantines_deferred_ai_assist_until_adapter_exists() {
        let feature_catalog = policy_feature_catalog();
        assert!(
            feature_catalog
                .iter()
                .all(|feature| feature.feature_key != "ai_assist"),
            "deferred AI assistant permission must not appear in the Policy Studio feature catalog"
        );

        for role in system_policy_roles() {
            assert!(
                role.permissions
                    .iter()
                    .all(|permission| permission.feature_key != "ai_assist"),
                "deferred AI assistant permission must not appear in system role metadata for {}",
                role.role_key
            );
        }

        let legacy_role = PolicyRoleResponse::from(policy_role_for_test(
            "legacy_ai_assist",
            &[("ai_assist", "allow"), ("work_order_create", "allow")],
            vec![],
        ));
        assert!(
            legacy_role
                .permissions
                .iter()
                .all(|permission| permission.feature_key != "ai_assist"),
            "deferred AI assistant permission must be hidden from existing custom role responses"
        );
        assert!(
            legacy_role
                .permissions
                .iter()
                .any(|permission| permission.feature_key == "work_order_create"),
            "visible custom-role permissions should remain intact"
        );

        assert!(
            !custom_role_runtime_feature_allowed(Feature::AiAssist),
            "retired AI permission must not become a runtime custom-role grant"
        );
        assert!(
            validate_policy_permissions(
                &[PolicyPermissionResponse {
                    feature_key: "ai_assist".to_owned(),
                    permission_level: "allow".to_owned(),
                }],
                false
            )
            .is_err()
        );

        let mut ai_only = policy_role_for_test("legacy_ai_only", &[("ai_assist", "allow")], vec![]);
        ai_only.status = "DRAFT".to_owned();
        let preview = build_policy_role_status_preview(&ai_only, "ACTIVE".to_owned(), 1);
        assert_eq!(preview.permission_count, 0);
        assert!(!preview.effective_runtime_change);
        assert!(
            !preview
                .warnings
                .iter()
                .any(|warning| warning == "publish_enables_assigned_custom_role_runtime_grants")
        );
        assert!(
            !preview
                .warnings
                .iter()
                .any(|warning| warning == "assigned_users_may_gain_or_lose_runtime_permissions")
        );
    }

    #[test]
    fn policy_condition_validation_accepts_scoped_abac_pbac_metadata_only() {
        let conditions = validate_policy_conditions(&[
            PolicyConditionResponse {
                condition_key: "dept_scope".to_owned(),
                attribute: "department".to_owned(),
                operator: "in".to_owned(),
                values: vec!["정비팀".to_owned(), "야간조".to_owned()],
            },
            PolicyConditionResponse {
                condition_key: "purpose_scope".to_owned(),
                attribute: "purpose".to_owned(),
                operator: "equals".to_owned(),
                values: vec!["work_order_approval".to_owned()],
            },
        ])
        .unwrap();
        assert_eq!(conditions.len(), 2);
        assert_eq!(conditions[0].attribute, "department");
        assert_eq!(conditions[0].values, vec!["정비팀", "야간조"]);

        assert!(
            validate_policy_conditions(&[PolicyConditionResponse {
                condition_key: "dept_scope".to_owned(),
                attribute: "machinery".to_owned(),
                operator: "equals".to_owned(),
                values: vec!["굴삭기".to_owned()],
            },])
            .is_err()
        );

        assert!(
            validate_policy_conditions(&[
                PolicyConditionResponse {
                    condition_key: "dept_scope".to_owned(),
                    attribute: "department".to_owned(),
                    operator: "equals".to_owned(),
                    values: vec!["정비팀".to_owned()],
                },
                PolicyConditionResponse {
                    condition_key: "dept_scope".to_owned(),
                    attribute: "team".to_owned(),
                    operator: "equals".to_owned(),
                    values: vec!["A".to_owned()],
                },
            ])
            .is_err()
        );
    }
}
