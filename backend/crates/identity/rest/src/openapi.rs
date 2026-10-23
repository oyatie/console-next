//! This face's slice of the published OpenAPI contract.
//!
//! Bodies live as YAML under `openapi/` and are pulled in via `include_str!`.
//! `console_contracts` re-indents them; composition rejects duplicate keys.

use console_contracts::{Fragment, NamedYaml, Operation, PathItem};

/// This face's contribution to the composed OpenAPI document.
pub const OPENAPI_FRAGMENT: Fragment = Fragment {
    source: "console-identity-rest",
    paths: PATHS,
    schemas: SCHEMAS,
    parameters: &[],
    responses: &[],
    security_schemes: &[],
    external_schemas: EXTERNAL_SCHEMAS,
};

const EXTERNAL_SCHEMAS: &[&str] = &[
    "ActorKind",
    "AuditLastChange",
    "Date",
    "ErrorBody",
    "FieldError",
    "MobilePasskeyStepUpBinding",
    "MobilePasskeyStepUpEnvelope",
    "MobileStepUpActionKind",
    "OrgChangeApprovalRoleKey",
    "OrgChangeApprovalStep",
    "OrgChangeDetail",
    "OrgChangeEvent",
    "OrgChangeKind",
    "OrgChangePreflightBlocker",
    "OrgChangePreflightReport",
    "OrgChangePreflightWarning",
    "OrgChangeSettlementItem",
    "OrgChangeSettlementKey",
    "OrgChangeStatus",
    "OrgChangeStepDecision",
    "OrgChangeSummary",
    "OrgChangeTarget",
    "OrgChangeTargetKind",
    "OrgProposalOp",
    "OrgProposalOpCreateBranch",
    "OrgProposalOpCreateOrgUnit",
    "OrgProposalOpCreateRegion",
    "OrgProposalOpCreateSite",
    "OrgProposalOpDeactivateBranch",
    "OrgProposalOpDeactivateRegion",
    "OrgProposalOpDissolveOrgUnit",
    "OrgProposalOpMoveOrgUnit",
    "OrgProposalOpReassignOrgUnit",
    "OrgProposalOpRenameBranch",
    "OrgProposalOpRenameOrgUnit",
    "OrgProposalOpRenameRegion",
    "OrgProposalOpUpdateSite",
    "OrgProposalReassignScope",
    "OrgUnitKind",
    "PasskeyStepUpAssertion",
    "Timestamp",
    "Uuid",
];

const PATHS: &[PathItem] = &[
    PathItem {
        path: "/.well-known/apple-app-site-association",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/.well-known__apple-app-site-association.get.yaml"),
        }],
    },
    PathItem {
        path: "/.well-known/assetlinks.json",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/.well-known__assetlinks.json.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/platform/company-domain",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__platform__company-domain.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/platform/groups",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__platform__groups.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__platform__groups.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/platform/groups/{id}",
        operations: &[Operation {
            method: "patch",
            body: include_str!("../openapi/paths/api__platform__groups__id.patch.yaml"),
        }],
    },
    PathItem {
        path: "/api/platform/groups/{id}/accounts",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__platform__groups__id__accounts.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__platform__groups__id__accounts.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}",
        operations: &[Operation {
            method: "delete",
            body: include_str!(
                "../openapi/paths/api__platform__groups__id__accounts__user_id__roles__group_role.delete.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/platform/groups/{id}/organizations/{org_id}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!(
                    "../openapi/paths/api__platform__groups__id__organizations__org_id.delete.yaml"
                ),
            },
            Operation {
                method: "put",
                body: include_str!(
                    "../openapi/paths/api__platform__groups__id__organizations__org_id.put.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/platform/ops",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__platform__ops.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/platform/orgs",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__platform__orgs.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__platform__orgs.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/platform/orgs/{id}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__platform__orgs__id.delete.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__platform__orgs__id.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/platform/orgs/{id}/admin-otp",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__platform__orgs__id__admin-otp.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/platform/orgs/{id}/ops-recovery",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__platform__orgs__id__ops-recovery.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__platform__orgs__id__ops-recovery.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/platform/orgs/{id}/ops-recovery/{rid}/approve",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__platform__orgs__id__ops-recovery__rid__approve.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/platform/orgs/{id}/ops-recovery/{rid}/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__platform__orgs__id__ops-recovery__rid__cancel.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/platform/orgs/{id}/ops-recovery/{rid}/issue",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__platform__orgs__id__ops-recovery__rid__issue.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/platform/support-references/{reference}",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__platform__support-references__reference.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/platform/support-sessions",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__platform__support-sessions.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__platform__support-sessions.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/platform/support-sessions/{id}/approve",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__platform__support-sessions__id__approve.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/platform/support-sessions/{id}/end",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__platform__support-sessions__id__end.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/platform/support-sessions/{id}/start",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__platform__support-sessions__id__start.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/access/accounts/{accountId}/effective",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__access__accounts__accountId__effective.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/access/catalog",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__access__catalog.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/granters",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__access__granters.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/grants",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__access__grants.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/grants/apply",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__access__grants__apply.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/grants/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__access__grants__preview.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/grants/{grantId}/notice",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__access__grants__grantId__notice.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/access/me",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__access__me.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/ops",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__access__ops.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/ops-usage",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__access__ops-usage.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/requests",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__access__requests.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__access__requests.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/access/requests/{requestId}/close",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__access__requests__requestId__close.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/access/roles",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__access__roles.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__access__roles.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/access/roles/{roleId}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__v1__access__roles__roleId.delete.yaml"),
            },
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__access__roles__roleId.get.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__access__roles__roleId.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/access/roles/{roleId}/status",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__access__roles__roleId__status.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/access/roles/{roleId}/versions",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__access__roles__roleId__versions.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/auth/admin/credential-reset",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__admin__credential-reset.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/admin/otp/issue",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__admin__otp__issue.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/device-login/approve",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__device-login__approve.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/device-login/approve-session",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__auth__device-login__approve-session.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/auth/device-login/poll",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__device-login__poll.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/device-login/start",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__device-login__start.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/logout",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__logout.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/otp/redeem",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__otp__redeem.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkey/enroll-handoff",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__passkey__enroll-handoff.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkey/login/finish",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__passkey__login__finish.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkey/login/start",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__passkey__login__start.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkey/register/finish",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__auth__passkey__register__finish.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkey/register/start",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__auth__passkey__register__start.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkey/step-up/start",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__passkey__step-up__start.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkeys",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__auth__passkeys.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/passkeys/{id}",
        operations: &[Operation {
            method: "delete",
            body: include_str!("../openapi/paths/api__v1__auth__passkeys__id.delete.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/privacy-consent/accept",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__privacy-consent__accept.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/privacy-consent/status",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__privacy-consent__status.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/signup",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__signup.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/auth/token/refresh",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__auth__token__refresh.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/branches",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__branches.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__branches.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/branches/{id}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__v1__branches__id.delete.yaml"),
            },
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__branches__id.get.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__branches__id.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/client-errors",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__client-errors.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/console/kill-switch",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__console__kill-switch.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/console/rollout",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__console__rollout.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/console/rollout/opt-in",
        operations: &[Operation {
            method: "put",
            body: include_str!("../openapi/paths/api__v1__console__rollout__opt-in.put.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/console/rollout/org-flag",
        operations: &[Operation {
            method: "put",
            body: include_str!("../openapi/paths/api__v1__console__rollout__org-flag.put.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/console/telemetry/route",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__console__telemetry__route.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/directory/people",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__directory__people.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/group-admin/groups",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__group-admin__groups.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/group-admin/tenant-context",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__group-admin__tenant-context.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/group-admin/tenant-context/exit",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__group-admin__tenant-context__exit.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/me/action-inbox",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__me__action-inbox.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/me/authz",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__me__authz.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/me/workbench",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__me__workbench.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/me/workspace",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__me__workspace.get.yaml"),
            },
            Operation {
                method: "put",
                body: include_str!("../openapi/paths/api__v1__me__workspace.put.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/policy/assignments",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__policy__assignments.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/audit-events",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__policy__audit-events.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/authorize",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__policy__authorize.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/authorize/bulk",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__policy__authorize__bulk.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/catalog",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__policy__catalog.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/decisions",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__policy__decisions.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/drafts",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__policy__drafts.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__policy__drafts.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/policy/drafts/{draft_id}",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__policy__drafts__draft_id.get.yaml"),
            },
            Operation {
                method: "put",
                body: include_str!("../openapi/paths/api__v1__policy__drafts__draft_id.put.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/policy/drafts/{draft_id}/review",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__policy__drafts__draft_id__review.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/policy/drafts/{draft_id}/submit",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__policy__drafts__draft_id__submit.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/policy/drafts/{draft_id}/validate",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__policy__drafts__draft_id__validate.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/policy/features",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__policy__features.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/role-templates",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__policy__role-templates.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/roles",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__policy__roles.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__policy__roles.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/policy/roles/{id}",
        operations: &[Operation {
            method: "patch",
            body: include_str!("../openapi/paths/api__v1__policy__roles__id.patch.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/roles/{id}/status",
        operations: &[Operation {
            method: "patch",
            body: include_str!("../openapi/paths/api__v1__policy__roles__id__status.patch.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/roles/{id}/status-preview",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__policy__roles__id__status-preview.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/policy/simulate",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__policy__simulate.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/policy/users/{id}/assignment-preview",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__policy__users__id__assignment-preview.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/policy/users/{id}/assignments",
        operations: &[Operation {
            method: "put",
            body: include_str!("../openapi/paths/api__v1__policy__users__id__assignments.put.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/regions",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__regions.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__regions.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/regions/{id}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__v1__regions__id.delete.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__regions__id.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/release-toggles",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__release-toggles.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/status/events",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__status__events.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/status/evidence",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__status__evidence.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/support-references/{reference}",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__support-references__reference.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/support-sessions",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__support-sessions.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/support-sessions/active",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__support-sessions__active.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/support-sessions/{id}/decision",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__support-sessions__id__decision.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/support-sessions/{id}/end",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__support-sessions__id__end.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/tenant/company-domain/request",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__tenant__company-domain__request.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__tenant__company-domain__request.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/tenant/ops-recovery",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__tenant__ops-recovery.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/tenant/ops-recovery/{rid}/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__tenant__ops-recovery__rid__cancel.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/users",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__users.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__users.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/users/me",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__users__me.get.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__users__me.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/users/{id}",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__users__id.get.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__users__id.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/users/{id}/activate",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__users__id__activate.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/users/{id}/deactivate",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__users__id__deactivate.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/users/{id}/sign-in-id",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__users__id__sign-in-id.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/users/{id}/sign-in-ids",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__users__id__sign-in-ids.get.yaml"),
        }],
    },
    PathItem {
        path: "/healthz",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/healthz.get.yaml"),
        }],
    },
    PathItem {
        path: "/readyz",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/readyz.get.yaml"),
        }],
    },
];

const SCHEMAS: &[NamedYaml] = &[
    NamedYaml {
        name: "AccessCatalog",
        body: include_str!("../openapi/schemas/AccessCatalog.yaml"),
    },
    NamedYaml {
        name: "AccessCatalogDomain",
        body: include_str!("../openapi/schemas/AccessCatalogDomain.yaml"),
    },
    NamedYaml {
        name: "AccessCatalogScopeKind",
        body: include_str!("../openapi/schemas/AccessCatalogScopeKind.yaml"),
    },
    NamedYaml {
        name: "AccessDomain",
        body: include_str!("../openapi/schemas/AccessDomain.yaml"),
    },
    NamedYaml {
        name: "AccessEffectLine",
        body: include_str!("../openapi/schemas/AccessEffectLine.yaml"),
    },
    NamedYaml {
        name: "AccessEffective",
        body: include_str!("../openapi/schemas/AccessEffective.yaml"),
    },
    NamedYaml {
        name: "AccessEffectiveEntry",
        body: include_str!("../openapi/schemas/AccessEffectiveEntry.yaml"),
    },
    NamedYaml {
        name: "AccessEnforcement",
        body: include_str!("../openapi/schemas/AccessEnforcement.yaml"),
    },
    NamedYaml {
        name: "AccessGrant",
        body: include_str!("../openapi/schemas/AccessGrant.yaml"),
    },
    NamedYaml {
        name: "AccessGrantBatchRequest",
        body: include_str!("../openapi/schemas/AccessGrantBatchRequest.yaml"),
    },
    NamedYaml {
        name: "AccessGrantNotice",
        body: include_str!("../openapi/schemas/AccessGrantNotice.yaml"),
    },
    NamedYaml {
        name: "AccessGrantOpGrant",
        body: include_str!("../openapi/schemas/AccessGrantOpGrant.yaml"),
    },
    NamedYaml {
        name: "AccessGrantOpRevoke",
        body: include_str!("../openapi/schemas/AccessGrantOpRevoke.yaml"),
    },
    NamedYaml {
        name: "AccessGrantOpSetEnd",
        body: include_str!("../openapi/schemas/AccessGrantOpSetEnd.yaml"),
    },
    NamedYaml {
        name: "AccessGrantOperation",
        body: include_str!("../openapi/schemas/AccessGrantOperation.yaml"),
    },
    NamedYaml {
        name: "AccessGrantPreview",
        body: include_str!("../openapi/schemas/AccessGrantPreview.yaml"),
    },
    NamedYaml {
        name: "AccessGrantPreviewItem",
        body: include_str!("../openapi/schemas/AccessGrantPreviewItem.yaml"),
    },
    NamedYaml {
        name: "AccessGranters",
        body: include_str!("../openapi/schemas/AccessGranters.yaml"),
    },
    NamedYaml {
        name: "AccessLevel",
        body: include_str!("../openapi/schemas/AccessLevel.yaml"),
    },
    NamedYaml {
        name: "AccessRequest",
        body: include_str!("../openapi/schemas/AccessRequest.yaml"),
    },
    NamedYaml {
        name: "AccessRequestReason",
        body: include_str!("../openapi/schemas/AccessRequestReason.yaml"),
    },
    NamedYaml {
        name: "AccessRole",
        body: include_str!("../openapi/schemas/AccessRole.yaml"),
    },
    NamedYaml {
        name: "AccessRoleLine",
        body: include_str!("../openapi/schemas/AccessRoleLine.yaml"),
    },
    NamedYaml {
        name: "AccessRoleStatus",
        body: include_str!("../openapi/schemas/AccessRoleStatus.yaml"),
    },
    NamedYaml {
        name: "AccessRoleVersion",
        body: include_str!("../openapi/schemas/AccessRoleVersion.yaml"),
    },
    NamedYaml {
        name: "AccessScope",
        body: include_str!("../openapi/schemas/AccessScope.yaml"),
    },
    NamedYaml {
        name: "AccessScopeKind",
        body: include_str!("../openapi/schemas/AccessScopeKind.yaml"),
    },
    NamedYaml {
        name: "AccountStatus",
        body: include_str!("../openapi/schemas/AccountStatus.yaml"),
    },
    NamedYaml {
        name: "ActionInboxItem",
        body: include_str!("../openapi/schemas/ActionInboxItem.yaml"),
    },
    NamedYaml {
        name: "ActionInboxLink",
        body: include_str!("../openapi/schemas/ActionInboxLink.yaml"),
    },
    NamedYaml {
        name: "ActionInboxResponse",
        body: include_str!("../openapi/schemas/ActionInboxResponse.yaml"),
    },
    NamedYaml {
        name: "ActiveSupportSessions",
        body: include_str!("../openapi/schemas/ActiveSupportSessions.yaml"),
    },
    NamedYaml {
        name: "AdminCredentialResetRequest",
        body: include_str!("../openapi/schemas/AdminCredentialResetRequest.yaml"),
    },
    NamedYaml {
        name: "AdminCredentialResetResponse",
        body: include_str!("../openapi/schemas/AdminCredentialResetResponse.yaml"),
    },
    NamedYaml {
        name: "AdminIssueOtpRequest",
        body: include_str!("../openapi/schemas/AdminIssueOtpRequest.yaml"),
    },
    NamedYaml {
        name: "AdminIssueOtpResponse",
        body: include_str!("../openapi/schemas/AdminIssueOtpResponse.yaml"),
    },
    NamedYaml {
        name: "AndroidAssetLinkStatement",
        body: include_str!("../openapi/schemas/AndroidAssetLinkStatement.yaml"),
    },
    NamedYaml {
        name: "AppleAppSiteAssociation",
        body: include_str!("../openapi/schemas/AppleAppSiteAssociation.yaml"),
    },
    NamedYaml {
        name: "ApplyAccessGrantsRequest",
        body: include_str!("../openapi/schemas/ApplyAccessGrantsRequest.yaml"),
    },
    NamedYaml {
        name: "ApplyGrantsOutcome",
        body: include_str!("../openapi/schemas/ApplyGrantsOutcome.yaml"),
    },
    NamedYaml {
        name: "BranchScope",
        body: include_str!("../openapi/schemas/BranchScope.yaml"),
    },
    NamedYaml {
        name: "BranchSummary",
        body: include_str!("../openapi/schemas/BranchSummary.yaml"),
    },
    NamedYaml {
        name: "BulkAuthorizeBody",
        body: include_str!("../openapi/schemas/BulkAuthorizeBody.yaml"),
    },
    NamedYaml {
        name: "BulkDecisionResponse",
        body: include_str!("../openapi/schemas/BulkDecisionResponse.yaml"),
    },
    NamedYaml {
        name: "ChangeSignInIdRequest",
        body: include_str!("../openapi/schemas/ChangeSignInIdRequest.yaml"),
    },
    NamedYaml {
        name: "CloseAccessRequest",
        body: include_str!("../openapi/schemas/CloseAccessRequest.yaml"),
    },
    NamedYaml {
        name: "CompanyDomainRequestState",
        body: include_str!("../openapi/schemas/CompanyDomainRequestState.yaml"),
    },
    NamedYaml {
        name: "ConsoleRouteSurface",
        body: include_str!("../openapi/schemas/ConsoleRouteSurface.yaml"),
    },
    NamedYaml {
        name: "ConsoleRouteTelemetryAccepted",
        body: include_str!("../openapi/schemas/ConsoleRouteTelemetryAccepted.yaml"),
    },
    NamedYaml {
        name: "ConsoleRouteTelemetryEventKind",
        body: include_str!("../openapi/schemas/ConsoleRouteTelemetryEventKind.yaml"),
    },
    NamedYaml {
        name: "ConsoleRouteTelemetryRequest",
        body: include_str!("../openapi/schemas/ConsoleRouteTelemetryRequest.yaml"),
    },
    NamedYaml {
        name: "CreateAccessRequest",
        body: include_str!("../openapi/schemas/CreateAccessRequest.yaml"),
    },
    NamedYaml {
        name: "CreateAccessRoleRequest",
        body: include_str!("../openapi/schemas/CreateAccessRoleRequest.yaml"),
    },
    NamedYaml {
        name: "CreateBranchRequest",
        body: include_str!("../openapi/schemas/CreateBranchRequest.yaml"),
    },
    NamedYaml {
        name: "CreatePlatformGroupAccountRequest",
        body: include_str!("../openapi/schemas/CreatePlatformGroupAccountRequest.yaml"),
    },
    NamedYaml {
        name: "CreatePlatformGroupAccountResponse",
        body: include_str!("../openapi/schemas/CreatePlatformGroupAccountResponse.yaml"),
    },
    NamedYaml {
        name: "CreatePlatformGroupRequest",
        body: include_str!("../openapi/schemas/CreatePlatformGroupRequest.yaml"),
    },
    NamedYaml {
        name: "CreatePlatformOrgRequest",
        body: include_str!("../openapi/schemas/CreatePlatformOrgRequest.yaml"),
    },
    NamedYaml {
        name: "CreatePolicyRoleRequest",
        body: include_str!("../openapi/schemas/CreatePolicyRoleRequest.yaml"),
    },
    NamedYaml {
        name: "CreateRegionRequest",
        body: include_str!("../openapi/schemas/CreateRegionRequest.yaml"),
    },
    NamedYaml {
        name: "CreateUserRequest",
        body: include_str!("../openapi/schemas/CreateUserRequest.yaml"),
    },
    NamedYaml {
        name: "DecisionLogRow",
        body: include_str!("../openapi/schemas/DecisionLogRow.yaml"),
    },
    NamedYaml {
        name: "DeletePasskeyRequest",
        body: include_str!("../openapi/schemas/DeletePasskeyRequest.yaml"),
    },
    NamedYaml {
        name: "DeviceLoginApproveRequest",
        body: include_str!("../openapi/schemas/DeviceLoginApproveRequest.yaml"),
    },
    NamedYaml {
        name: "DeviceLoginApproveSessionRequest",
        body: include_str!("../openapi/schemas/DeviceLoginApproveSessionRequest.yaml"),
    },
    NamedYaml {
        name: "DeviceLoginPollRequest",
        body: include_str!("../openapi/schemas/DeviceLoginPollRequest.yaml"),
    },
    NamedYaml {
        name: "DeviceLoginPollResponse",
        body: include_str!("../openapi/schemas/DeviceLoginPollResponse.yaml"),
    },
    NamedYaml {
        name: "DeviceLoginStartResponse",
        body: include_str!("../openapi/schemas/DeviceLoginStartResponse.yaml"),
    },
    NamedYaml {
        name: "DirectoryPage",
        body: include_str!("../openapi/schemas/DirectoryPage.yaml"),
    },
    NamedYaml {
        name: "DirectoryPerson",
        body: include_str!("../openapi/schemas/DirectoryPerson.yaml"),
    },
    NamedYaml {
        name: "EnrollHandoffRequest",
        body: include_str!("../openapi/schemas/EnrollHandoffRequest.yaml"),
    },
    NamedYaml {
        name: "EnrollHandoffResponse",
        body: include_str!("../openapi/schemas/EnrollHandoffResponse.yaml"),
    },
    NamedYaml {
        name: "LogoutRequest",
        body: include_str!("../openapi/schemas/LogoutRequest.yaml"),
    },
    NamedYaml {
        name: "MeAuthzCapability",
        body: include_str!("../openapi/schemas/MeAuthzCapability.yaml"),
    },
    NamedYaml {
        name: "MeAuthzResponse",
        body: include_str!("../openapi/schemas/MeAuthzResponse.yaml"),
    },
    NamedYaml {
        name: "MobilePasskeyStepUpStartRequest",
        body: include_str!("../openapi/schemas/MobilePasskeyStepUpStartRequest.yaml"),
    },
    NamedYaml {
        name: "MobilePasskeyStepUpStartResponse",
        body: include_str!("../openapi/schemas/MobilePasskeyStepUpStartResponse.yaml"),
    },
    NamedYaml {
        name: "MyWorkbenchResponse",
        body: include_str!("../openapi/schemas/MyWorkbenchResponse.yaml"),
    },
    NamedYaml {
        name: "OpsAccount",
        body: include_str!("../openapi/schemas/OpsAccount.yaml"),
    },
    NamedYaml {
        name: "OpsRecoveryCancelRequest",
        body: include_str!("../openapi/schemas/OpsRecoveryCancelRequest.yaml"),
    },
    NamedYaml {
        name: "OpsRecoveryOpenRequest",
        body: include_str!("../openapi/schemas/OpsRecoveryOpenRequest.yaml"),
    },
    NamedYaml {
        name: "OpsRecoveryRequest",
        body: include_str!("../openapi/schemas/OpsRecoveryRequest.yaml"),
    },
    NamedYaml {
        name: "OpsRecoveryState",
        body: include_str!("../openapi/schemas/OpsRecoveryState.yaml"),
    },
    NamedYaml {
        name: "OpsUsageEntry",
        body: include_str!("../openapi/schemas/OpsUsageEntry.yaml"),
    },
    NamedYaml {
        name: "OtpRedeemRequest",
        body: include_str!("../openapi/schemas/OtpRedeemRequest.yaml"),
    },
    NamedYaml {
        name: "OtpRedeemResponse",
        body: include_str!("../openapi/schemas/OtpRedeemResponse.yaml"),
    },
    NamedYaml {
        name: "PasskeyLoginFinishRequest",
        body: include_str!("../openapi/schemas/PasskeyLoginFinishRequest.yaml"),
    },
    NamedYaml {
        name: "PasskeyLoginStartRequest",
        body: include_str!("../openapi/schemas/PasskeyLoginStartRequest.yaml"),
    },
    NamedYaml {
        name: "PasskeyLoginStartResponse",
        body: include_str!("../openapi/schemas/PasskeyLoginStartResponse.yaml"),
    },
    NamedYaml {
        name: "PasskeyRegisterFinishRequest",
        body: include_str!("../openapi/schemas/PasskeyRegisterFinishRequest.yaml"),
    },
    NamedYaml {
        name: "PasskeyRegisterFinishResponse",
        body: include_str!("../openapi/schemas/PasskeyRegisterFinishResponse.yaml"),
    },
    NamedYaml {
        name: "PasskeyRegisterStartRequest",
        body: include_str!("../openapi/schemas/PasskeyRegisterStartRequest.yaml"),
    },
    NamedYaml {
        name: "PasskeyRegisterStartResponse",
        body: include_str!("../openapi/schemas/PasskeyRegisterStartResponse.yaml"),
    },
    NamedYaml {
        name: "PasskeySummary",
        body: include_str!("../openapi/schemas/PasskeySummary.yaml"),
    },
    NamedYaml {
        name: "PlatformAccountStatus",
        body: include_str!("../openapi/schemas/PlatformAccountStatus.yaml"),
    },
    NamedYaml {
        name: "PlatformGroup",
        body: include_str!("../openapi/schemas/PlatformGroup.yaml"),
    },
    NamedYaml {
        name: "PlatformGroupAccount",
        body: include_str!("../openapi/schemas/PlatformGroupAccount.yaml"),
    },
    NamedYaml {
        name: "PlatformGroupMember",
        body: include_str!("../openapi/schemas/PlatformGroupMember.yaml"),
    },
    NamedYaml {
        name: "PlatformGroupRole",
        body: include_str!("../openapi/schemas/PlatformGroupRole.yaml"),
    },
    NamedYaml {
        name: "PlatformOpsResponse",
        body: include_str!("../openapi/schemas/PlatformOpsResponse.yaml"),
    },
    NamedYaml {
        name: "PlatformOrg",
        body: include_str!("../openapi/schemas/PlatformOrg.yaml"),
    },
    NamedYaml {
        name: "PlatformOrgAdminOtpReissueRequest",
        body: include_str!("../openapi/schemas/PlatformOrgAdminOtpReissueRequest.yaml"),
    },
    NamedYaml {
        name: "PlatformOrgAdminOtpReissueResponse",
        body: include_str!("../openapi/schemas/PlatformOrgAdminOtpReissueResponse.yaml"),
    },
    NamedYaml {
        name: "PlatformOrgOnboardingResponse",
        body: include_str!("../openapi/schemas/PlatformOrgOnboardingResponse.yaml"),
    },
    NamedYaml {
        name: "PlatformOrgStatus",
        body: include_str!("../openapi/schemas/PlatformOrgStatus.yaml"),
    },
    NamedYaml {
        name: "PlatformTenantHealth",
        body: include_str!("../openapi/schemas/PlatformTenantHealth.yaml"),
    },
    NamedYaml {
        name: "PlatformTenantRole",
        body: include_str!("../openapi/schemas/PlatformTenantRole.yaml"),
    },
    NamedYaml {
        name: "PolicyAssignmentPreviewResponse",
        body: include_str!("../openapi/schemas/PolicyAssignmentPreviewResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyAuditEventResponse",
        body: include_str!("../openapi/schemas/PolicyAuditEventResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyAuthorizeRequest",
        body: include_str!("../openapi/schemas/PolicyAuthorizeRequest.yaml"),
    },
    NamedYaml {
        name: "PolicyConditionResponse",
        body: include_str!("../openapi/schemas/PolicyConditionResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyCreateDraftRequest",
        body: include_str!("../openapi/schemas/PolicyCreateDraftRequest.yaml"),
    },
    NamedYaml {
        name: "PolicyDefaultPermissionResponse",
        body: include_str!("../openapi/schemas/PolicyDefaultPermissionResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyFeatureGrantPreviewResponse",
        body: include_str!("../openapi/schemas/PolicyFeatureGrantPreviewResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyFeatureResponse",
        body: include_str!("../openapi/schemas/PolicyFeatureResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyNoCodeBlocks",
        body: include_str!("../openapi/schemas/PolicyNoCodeBlocks.yaml"),
    },
    NamedYaml {
        name: "PolicyNoCodeCondition",
        body: include_str!("../openapi/schemas/PolicyNoCodeCondition.yaml"),
    },
    NamedYaml {
        name: "PolicyPermissionResponse",
        body: include_str!("../openapi/schemas/PolicyPermissionResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyReviewRequest",
        body: include_str!("../openapi/schemas/PolicyReviewRequest.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleAssignmentDeltaResponse",
        body: include_str!("../openapi/schemas/PolicyRoleAssignmentDeltaResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleAssignmentResponse",
        body: include_str!("../openapi/schemas/PolicyRoleAssignmentResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleCatalogResponse",
        body: include_str!("../openapi/schemas/PolicyRoleCatalogResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleImpactResponse",
        body: include_str!("../openapi/schemas/PolicyRoleImpactResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleResponse",
        body: include_str!("../openapi/schemas/PolicyRoleResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleStatusPreviewRequest",
        body: include_str!("../openapi/schemas/PolicyRoleStatusPreviewRequest.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleStatusPreviewResponse",
        body: include_str!("../openapi/schemas/PolicyRoleStatusPreviewResponse.yaml"),
    },
    NamedYaml {
        name: "PolicyRoleTemplateResponse",
        body: include_str!("../openapi/schemas/PolicyRoleTemplateResponse.yaml"),
    },
    NamedYaml {
        name: "PolicySimRequest",
        body: include_str!("../openapi/schemas/PolicySimRequest.yaml"),
    },
    NamedYaml {
        name: "PolicySimResource",
        body: include_str!("../openapi/schemas/PolicySimResource.yaml"),
    },
    NamedYaml {
        name: "PolicySimSubject",
        body: include_str!("../openapi/schemas/PolicySimSubject.yaml"),
    },
    NamedYaml {
        name: "PolicySimulateRequest",
        body: include_str!("../openapi/schemas/PolicySimulateRequest.yaml"),
    },
    NamedYaml {
        name: "PolicyUpdateDraftRequest",
        body: include_str!("../openapi/schemas/PolicyUpdateDraftRequest.yaml"),
    },
    NamedYaml {
        name: "PolicyVersionResponse",
        body: include_str!("../openapi/schemas/PolicyVersionResponse.yaml"),
    },
    NamedYaml {
        name: "PrivacyConsentAcceptRequest",
        body: include_str!("../openapi/schemas/PrivacyConsentAcceptRequest.yaml"),
    },
    NamedYaml {
        name: "PrivacyConsentStatusResponse",
        body: include_str!("../openapi/schemas/PrivacyConsentStatusResponse.yaml"),
    },
    NamedYaml {
        name: "RefreshTokenRequest",
        body: include_str!("../openapi/schemas/RefreshTokenRequest.yaml"),
    },
    NamedYaml {
        name: "RegionSummary",
        body: include_str!("../openapi/schemas/RegionSummary.yaml"),
    },
    NamedYaml {
        name: "ReplacePolicyRoleAssignmentsRequest",
        body: include_str!("../openapi/schemas/ReplacePolicyRoleAssignmentsRequest.yaml"),
    },
    NamedYaml {
        name: "RouteAdoptionMetric",
        body: include_str!("../openapi/schemas/RouteAdoptionMetric.yaml"),
    },
    NamedYaml {
        name: "SetAccessRoleStatusRequest",
        body: include_str!("../openapi/schemas/SetAccessRoleStatusRequest.yaml"),
    },
    NamedYaml {
        name: "SignInIdHistory",
        body: include_str!("../openapi/schemas/SignInIdHistory.yaml"),
    },
    NamedYaml {
        name: "SignInIdRecord",
        body: include_str!("../openapi/schemas/SignInIdRecord.yaml"),
    },
    NamedYaml {
        name: "SignupRequest",
        body: include_str!("../openapi/schemas/SignupRequest.yaml"),
    },
    NamedYaml {
        name: "SignupResponse",
        body: include_str!("../openapi/schemas/SignupResponse.yaml"),
    },
    NamedYaml {
        name: "SimulationOutcome",
        body: include_str!("../openapi/schemas/SimulationOutcome.yaml"),
    },
    NamedYaml {
        name: "StepUpRequest",
        body: include_str!("../openapi/schemas/StepUpRequest.yaml"),
    },
    NamedYaml {
        name: "SupportAccessRecord",
        body: include_str!("../openapi/schemas/SupportAccessRecord.yaml"),
    },
    NamedYaml {
        name: "SupportOperatorDecision",
        body: include_str!("../openapi/schemas/SupportOperatorDecision.yaml"),
    },
    NamedYaml {
        name: "SupportRefusal",
        body: include_str!("../openapi/schemas/SupportRefusal.yaml"),
    },
    NamedYaml {
        name: "SupportRequest",
        body: include_str!("../openapi/schemas/SupportRequest.yaml"),
    },
    NamedYaml {
        name: "SupportSession",
        body: include_str!("../openapi/schemas/SupportSession.yaml"),
    },
    NamedYaml {
        name: "SupportSessionDecision",
        body: include_str!("../openapi/schemas/SupportSessionDecision.yaml"),
    },
    NamedYaml {
        name: "SupportSessionMetadata",
        body: include_str!("../openapi/schemas/SupportSessionMetadata.yaml"),
    },
    NamedYaml {
        name: "SupportSessions",
        body: include_str!("../openapi/schemas/SupportSessions.yaml"),
    },
    NamedYaml {
        name: "SupportTenantDecision",
        body: include_str!("../openapi/schemas/SupportTenantDecision.yaml"),
    },
    NamedYaml {
        name: "SystemPolicyRoleResponse",
        body: include_str!("../openapi/schemas/SystemPolicyRoleResponse.yaml"),
    },
    NamedYaml {
        name: "Team",
        body: include_str!("../openapi/schemas/Team.yaml"),
    },
    NamedYaml {
        name: "TokenPairResponse",
        body: include_str!("../openapi/schemas/TokenPairResponse.yaml"),
    },
    NamedYaml {
        name: "UpdateAccessRoleRequest",
        body: include_str!("../openapi/schemas/UpdateAccessRoleRequest.yaml"),
    },
    NamedYaml {
        name: "UpdateBranchRequest",
        body: include_str!("../openapi/schemas/UpdateBranchRequest.yaml"),
    },
    NamedYaml {
        name: "UpdatePlatformGroupRequest",
        body: include_str!("../openapi/schemas/UpdatePlatformGroupRequest.yaml"),
    },
    NamedYaml {
        name: "UpdatePlatformOrgRequest",
        body: include_str!("../openapi/schemas/UpdatePlatformOrgRequest.yaml"),
    },
    NamedYaml {
        name: "UpdatePolicyRoleRequest",
        body: include_str!("../openapi/schemas/UpdatePolicyRoleRequest.yaml"),
    },
    NamedYaml {
        name: "UpdatePolicyRoleStatusRequest",
        body: include_str!("../openapi/schemas/UpdatePolicyRoleStatusRequest.yaml"),
    },
    NamedYaml {
        name: "UpdateRegionRequest",
        body: include_str!("../openapi/schemas/UpdateRegionRequest.yaml"),
    },
    NamedYaml {
        name: "UpdateSelfProfileRequest",
        body: include_str!("../openapi/schemas/UpdateSelfProfileRequest.yaml"),
    },
    NamedYaml {
        name: "UpdateUserRequest",
        body: include_str!("../openapi/schemas/UpdateUserRequest.yaml"),
    },
    NamedYaml {
        name: "UserPage",
        body: include_str!("../openapi/schemas/UserPage.yaml"),
    },
    NamedYaml {
        name: "UserSummary",
        body: include_str!("../openapi/schemas/UserSummary.yaml"),
    },
    NamedYaml {
        name: "WorkbenchActionInboxItem",
        body: include_str!("../openapi/schemas/WorkbenchActionInboxItem.yaml"),
    },
    NamedYaml {
        name: "WorkbenchActionSourceEnvelope",
        body: include_str!("../openapi/schemas/WorkbenchActionSourceEnvelope.yaml"),
    },
    NamedYaml {
        name: "WorkbenchActionSourceOk",
        body: include_str!("../openapi/schemas/WorkbenchActionSourceOk.yaml"),
    },
    NamedYaml {
        name: "WorkbenchCalendarItem",
        body: include_str!("../openapi/schemas/WorkbenchCalendarItem.yaml"),
    },
    NamedYaml {
        name: "WorkbenchCalendarSourceEnvelope",
        body: include_str!("../openapi/schemas/WorkbenchCalendarSourceEnvelope.yaml"),
    },
    NamedYaml {
        name: "WorkbenchCalendarSourceOk",
        body: include_str!("../openapi/schemas/WorkbenchCalendarSourceOk.yaml"),
    },
    NamedYaml {
        name: "WorkbenchDeniedSourceEnvelope",
        body: include_str!("../openapi/schemas/WorkbenchDeniedSourceEnvelope.yaml"),
    },
    NamedYaml {
        name: "WorkbenchEffectiveScope",
        body: include_str!("../openapi/schemas/WorkbenchEffectiveScope.yaml"),
    },
    NamedYaml {
        name: "WorkbenchRange",
        body: include_str!("../openapi/schemas/WorkbenchRange.yaml"),
    },
    NamedYaml {
        name: "WorkbenchScopeAll",
        body: include_str!("../openapi/schemas/WorkbenchScopeAll.yaml"),
    },
    NamedYaml {
        name: "WorkbenchScopeBranches",
        body: include_str!("../openapi/schemas/WorkbenchScopeBranches.yaml"),
    },
    NamedYaml {
        name: "WorkbenchSourceRef",
        body: include_str!("../openapi/schemas/WorkbenchSourceRef.yaml"),
    },
    NamedYaml {
        name: "WorkbenchTarget",
        body: include_str!("../openapi/schemas/WorkbenchTarget.yaml"),
    },
    NamedYaml {
        name: "WorkbenchTodoItem",
        body: include_str!("../openapi/schemas/WorkbenchTodoItem.yaml"),
    },
    NamedYaml {
        name: "WorkbenchTodoSourceEnvelope",
        body: include_str!("../openapi/schemas/WorkbenchTodoSourceEnvelope.yaml"),
    },
    NamedYaml {
        name: "WorkbenchTodoSourceOk",
        body: include_str!("../openapi/schemas/WorkbenchTodoSourceOk.yaml"),
    },
    NamedYaml {
        name: "WorkbenchUnavailableSourceEnvelope",
        body: include_str!("../openapi/schemas/WorkbenchUnavailableSourceEnvelope.yaml"),
    },
    NamedYaml {
        name: "WorkbenchUrgency",
        body: include_str!("../openapi/schemas/WorkbenchUrgency.yaml"),
    },
    NamedYaml {
        name: "WorkspaceResponse",
        body: include_str!("../openapi/schemas/WorkspaceResponse.yaml"),
    },
    NamedYaml {
        name: "WorkspaceUpsertRequest",
        body: include_str!("../openapi/schemas/WorkspaceUpsertRequest.yaml"),
    },
];
