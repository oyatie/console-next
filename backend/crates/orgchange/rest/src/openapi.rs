//! This face's slice of the published OpenAPI contract.
//!
//! Bodies live as YAML under `openapi/` and are pulled in via `include_str!`.
//! `console_contracts` re-indents them; composition rejects duplicate keys.

use console_contracts::{Fragment, NamedYaml, Operation, PathItem};

/// This face's contribution to the composed OpenAPI document.
pub const OPENAPI_FRAGMENT: Fragment = Fragment {
    source: "console-orgchange-rest",
    paths: PATHS,
    schemas: SCHEMAS,
    parameters: &[],
    responses: &[],
    security_schemes: &[],
    external_schemas: EXTERNAL_SCHEMAS,
};

const EXTERNAL_SCHEMAS: &[&str] = &[
    "ActorKind",
    "AddressSource",
    "AuditLastChange",
    "Date",
    "EndOffer",
    "ErrorBody",
    "FieldError",
    "GroupTransferFacts",
    "KrAddress",
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
        path: "/api/v1/appointment-notices",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__appointment-notices.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__appointment-notices.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/appointment-notices/{id}",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__appointment-notices__id.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/change-requests",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__change-requests.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__change-requests.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/change-requests/{id}/decide",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__change-requests__id__decide.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/change-sets",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__change-sets.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__change-sets.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/change-sets/{id}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__v1__change-sets__id.delete.yaml"),
            },
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__change-sets__id.get.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/change-sets/{id}/commit",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__change-sets__id__commit.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/change-sets/{id}/lines",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__change-sets__id__lines.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/change-sets/{id}/lines/{line_id}",
        operations: &[Operation {
            method: "delete",
            body: include_str!(
                "../openapi/paths/api__v1__change-sets__id__lines__line_id.delete.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employee-number-rules",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__v1__employee-number-rules.delete.yaml"),
            },
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__employee-number-rules.get.yaml"),
            },
            Operation {
                method: "put",
                body: include_str!("../openapi/paths/api__v1__employee-number-rules.put.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employee-records/{section}",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employee-records__section.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employee-records/{section}/import/apply",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employee-records__section__import__apply.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employee-records/{section}/import/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employee-records__section__import__preview.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__employees.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__employees.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employees/by-number/{number}",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__by-number__number.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/corrections/bulk",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__corrections__bulk.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/corrections/bulk/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__corrections__bulk__preview.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/corrections/bulk/{id}",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employees__corrections__bulk__id.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/export.csv",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__export.csv.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/facets",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__facets.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__import.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__import__preview.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import/unplaced",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__import__unplaced.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import/{run_id}/apply",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__employees__import__run_id__apply.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__employees__import__run_id__apply.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employees/import/{run_id}/dry-run",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__import__run_id__dry-run.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import/{run_id}/reconcile",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employees__import__run_id__reconcile.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import/{run_id}/reconcile/rows",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employees__import__run_id__reconcile__rows.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import/{run_id}/reconcile/rows/{source_key}",
        operations: &[Operation {
            method: "put",
            body: include_str!(
                "../openapi/paths/api__v1__employees__import__run_id__reconcile__rows__source_key.put.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/import/{run_id}/signoff",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__import__run_id__signoff.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/lifecycle-events/bulk",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__lifecycle-events__bulk.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/lifecycle-events/bulk/jobs/{job_id}",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employees__lifecycle-events__bulk__jobs__job_id.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/lifecycle-events/bulk/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__lifecycle-events__bulk__preview.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/lifecycle-events/bulk/{batch_id}/rescind",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__lifecycle-events__bulk__batch_id__rescind.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/register-facts/bulk",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__register-facts__bulk.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/renumber/apply",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__renumber__apply.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/renumber/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__renumber__preview.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/renumber/{batch_id}/undo",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__renumber__batch_id__undo.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/voided",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__voided.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__v1__employees__id.delete.yaml"),
            },
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__employees__id.get.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__employees__id.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employees/{id}/contracts",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__employees__id__contracts.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__employees__id__contracts.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employees/{id}/employee-number",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__employee-number.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/employee-number/history",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__employee-number__history.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/employment-facts",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__employees__id__employment-facts.get.yaml"
                ),
            },
            Operation {
                method: "patch",
                body: include_str!(
                    "../openapi/paths/api__v1__employees__id__employment-facts.patch.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employees/{id}/end-options",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__id__end-options.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/fixed-term",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__id__fixed-term.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/home-branch",
        operations: &[Operation {
            method: "put",
            body: include_str!("../openapi/paths/api__v1__employees__id__home-branch.put.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/identity-resolution",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__identity-resolution.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/lifecycle-events",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__employees__id__lifecycle-events.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__employees__id__lifecycle-events.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employees/{id}/lifecycle-events/{event_id}/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__lifecycle-events__event_id__cancel.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/lifecycle-events/{event_id}/correct",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__lifecycle-events__event_id__correct.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/lifecycle-events/{event_id}/rescind",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__lifecycle-events__event_id__rescind.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/onboarding-checklist",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__onboarding-checklist.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/personal-facts",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__id__personal-facts.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/photo-uploads",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__id__photo-uploads.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/photo-uploads/{upload_id}/confirm",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__photo-uploads__upload_id__confirm.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/probation/confirm",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__probation__confirm.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/records",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__id__records.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/records/{section}",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__records__section.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/records/{section}/{entry_id}",
        operations: &[Operation {
            method: "put",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__records__section__entry_id.put.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/records/{section}/{entry_id}/history",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__records__section__entry_id__history.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/records/{section}/{entry_id}/void",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employees__id__records__section__entry_id__void.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/register-facts",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__id__register-facts.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/rehire",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__id__rehire.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/rrn",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__employees__id__rrn.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/rrn/reveal",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__id__rrn__reveal.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/employees/{id}/void",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__employees__id__void.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/absence-exit-dashboard",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__absence-exit-dashboard.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/attendance-import/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__hr__attendance-import__preview.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/hr/attendance-import/summary",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__attendance-import__summary.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/attendance-import/{run_id}/apply",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__hr__attendance-import__run_id__apply.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/hr/attendance-import/{run_id}/dry-run",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__hr__attendance-import__run_id__dry-run.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/hr/attendance-records",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__attendance-records.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/attendance-records/me",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__hr__attendance-records__me.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__hr__attendance-records__me.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/hr/attendance-summary",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__attendance-summary.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/exit-cases",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__hr__exit-cases.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__hr__exit-cases.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/hr/exit-cases/{id}",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__exit-cases__id.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/exit-cases/{id}/approval-draft",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__hr__exit-cases__id__approval-draft.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/hr/exit-cases/{id}/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__hr__exit-cases__id__cancel.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/exit-cases/{id}/confirm",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__hr__exit-cases__id__confirm.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/exit-cases/{id}/reject",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__hr__exit-cases__id__reject.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/leave-balances",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__leave-balances.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/minimum-wage",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__minimum-wage.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/org-chart",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__org-chart.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/hr/readiness-summary",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__hr__readiness-summary.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/job-titles",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__job-titles.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__job-titles.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/job-titles/{id}",
        operations: &[Operation {
            method: "patch",
            body: include_str!("../openapi/paths/api__v1__job-titles__id.patch.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-changes",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__org-changes.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__org-changes.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__org-changes__id.get.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__org-changes__id.patch.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__org-changes__id__approval-steps__stepId__decision.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}/archive",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__org-changes__id__archive.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__org-changes__id__cancel.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}/effectuate",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__org-changes__id__effectuate.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}/preflight",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__org-changes__id__preflight.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}/settlement-items/{itemId}/complete",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__org-changes__id__settlement-items__itemId__complete.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/org-changes/{id}/submit",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__org-changes__id__submit.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-entities",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__org-entities.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-units",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__org-units.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__org-units.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/org-units/{id}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!("../openapi/paths/api__v1__org-units__id.delete.yaml"),
            },
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__org-units__id.get.yaml"),
            },
            Operation {
                method: "patch",
                body: include_str!("../openapi/paths/api__v1__org-units__id.patch.yaml"),
            },
        ],
    },
];

const SCHEMAS: &[NamedYaml] = &[
    NamedYaml {
        name: "AllowedLifecycleEvent",
        body: include_str!("../openapi/schemas/AllowedLifecycleEvent.yaml"),
    },
    NamedYaml {
        name: "AppointmentNotice",
        body: include_str!("../openapi/schemas/AppointmentNotice.yaml"),
    },
    NamedYaml {
        name: "AppointmentNoticeLine",
        body: include_str!("../openapi/schemas/AppointmentNoticeLine.yaml"),
    },
    NamedYaml {
        name: "AppointmentNoticePage",
        body: include_str!("../openapi/schemas/AppointmentNoticePage.yaml"),
    },
    NamedYaml {
        name: "AppointmentNoticeSummary",
        body: include_str!("../openapi/schemas/AppointmentNoticeSummary.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportApplyReport",
        body: include_str!("../openapi/schemas/AttendanceImportApplyReport.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportColumn",
        body: include_str!("../openapi/schemas/AttendanceImportColumn.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportDryRunSummary",
        body: include_str!("../openapi/schemas/AttendanceImportDryRunSummary.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportPreviewResponse",
        body: include_str!("../openapi/schemas/AttendanceImportPreviewResponse.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportPreviewRow",
        body: include_str!("../openapi/schemas/AttendanceImportPreviewRow.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportRowError",
        body: include_str!("../openapi/schemas/AttendanceImportRowError.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportSummaryItem",
        body: include_str!("../openapi/schemas/AttendanceImportSummaryItem.yaml"),
    },
    NamedYaml {
        name: "AttendanceImportSummaryPage",
        body: include_str!("../openapi/schemas/AttendanceImportSummaryPage.yaml"),
    },
    NamedYaml {
        name: "AttendanceRecordKind",
        body: include_str!("../openapi/schemas/AttendanceRecordKind.yaml"),
    },
    NamedYaml {
        name: "AttendanceSummaryItem",
        body: include_str!("../openapi/schemas/AttendanceSummaryItem.yaml"),
    },
    NamedYaml {
        name: "AttendanceSummaryPage",
        body: include_str!("../openapi/schemas/AttendanceSummaryPage.yaml"),
    },
    NamedYaml {
        name: "BulkCorrectionRefusal",
        body: include_str!("../openapi/schemas/BulkCorrectionRefusal.yaml"),
    },
    NamedYaml {
        name: "BulkEmployeeCorrectionCounts",
        body: include_str!("../openapi/schemas/BulkEmployeeCorrectionCounts.yaml"),
    },
    NamedYaml {
        name: "BulkEmployeeCorrectionJob",
        body: include_str!("../openapi/schemas/BulkEmployeeCorrectionJob.yaml"),
    },
    NamedYaml {
        name: "BulkEmployeeCorrectionPreview",
        body: include_str!("../openapi/schemas/BulkEmployeeCorrectionPreview.yaml"),
    },
    NamedYaml {
        name: "BulkEmployeeCorrectionRequest",
        body: include_str!("../openapi/schemas/BulkEmployeeCorrectionRequest.yaml"),
    },
    NamedYaml {
        name: "BulkEmployeeCorrectionResult",
        body: include_str!("../openapi/schemas/BulkEmployeeCorrectionResult.yaml"),
    },
    NamedYaml {
        name: "BulkEmployeeLifecycleEventRequest",
        body: include_str!("../openapi/schemas/BulkEmployeeLifecycleEventRequest.yaml"),
    },
    NamedYaml {
        name: "BulkEmployeeLifecycleEventResponse",
        body: include_str!("../openapi/schemas/BulkEmployeeLifecycleEventResponse.yaml"),
    },
    NamedYaml {
        name: "BulkLifecyclePreview",
        body: include_str!("../openapi/schemas/BulkLifecyclePreview.yaml"),
    },
    NamedYaml {
        name: "BulkLifecycleRefusalBody",
        body: include_str!("../openapi/schemas/BulkLifecycleRefusalBody.yaml"),
    },
    NamedYaml {
        name: "BulkRegisterFactsOutcome",
        body: include_str!("../openapi/schemas/BulkRegisterFactsOutcome.yaml"),
    },
    NamedYaml {
        name: "BulkRegisterFactsRequest",
        body: include_str!("../openapi/schemas/BulkRegisterFactsRequest.yaml"),
    },
    NamedYaml {
        name: "BulkSelection",
        body: include_str!("../openapi/schemas/BulkSelection.yaml"),
    },
    NamedYaml {
        name: "BulkTransferLine",
        body: include_str!("../openapi/schemas/BulkTransferLine.yaml"),
    },
    NamedYaml {
        name: "CancelEmployeeLifecycleEventRequest",
        body: include_str!("../openapi/schemas/CancelEmployeeLifecycleEventRequest.yaml"),
    },
    NamedYaml {
        name: "CancelOrgChangeRequest",
        body: include_str!("../openapi/schemas/CancelOrgChangeRequest.yaml"),
    },
    NamedYaml {
        name: "ChangeRequest",
        body: include_str!("../openapi/schemas/ChangeRequest.yaml"),
    },
    NamedYaml {
        name: "ChangeSetDetail",
        body: include_str!("../openapi/schemas/ChangeSetDetail.yaml"),
    },
    NamedYaml {
        name: "ChangeSetLine",
        body: include_str!("../openapi/schemas/ChangeSetLine.yaml"),
    },
    NamedYaml {
        name: "ChangeSetSummary",
        body: include_str!("../openapi/schemas/ChangeSetSummary.yaml"),
    },
    NamedYaml {
        name: "CloseEmployeeExitCaseRequest",
        body: include_str!("../openapi/schemas/CloseEmployeeExitCaseRequest.yaml"),
    },
    NamedYaml {
        name: "CompleteOrgChangeSettlementItemRequest",
        body: include_str!("../openapi/schemas/CompleteOrgChangeSettlementItemRequest.yaml"),
    },
    NamedYaml {
        name: "ConfirmEmployeeExitCaseRequest",
        body: include_str!("../openapi/schemas/ConfirmEmployeeExitCaseRequest.yaml"),
    },
    NamedYaml {
        name: "CorrectEmployeeRequest",
        body: include_str!("../openapi/schemas/CorrectEmployeeRequest.yaml"),
    },
    NamedYaml {
        name: "CreateEmployeeAttendanceRecordRequest",
        body: include_str!("../openapi/schemas/CreateEmployeeAttendanceRecordRequest.yaml"),
    },
    NamedYaml {
        name: "CreateEmployeeContract",
        body: include_str!("../openapi/schemas/CreateEmployeeContract.yaml"),
    },
    NamedYaml {
        name: "CreateEmployeeLifecycleEventRequest",
        body: include_str!("../openapi/schemas/CreateEmployeeLifecycleEventRequest.yaml"),
    },
    NamedYaml {
        name: "CreateEmployeeRequest",
        body: include_str!("../openapi/schemas/CreateEmployeeRequest.yaml"),
    },
    NamedYaml {
        name: "CreateOrgChangeRequest",
        body: include_str!("../openapi/schemas/CreateOrgChangeRequest.yaml"),
    },
    NamedYaml {
        name: "CreateOrgUnitRequest",
        body: include_str!("../openapi/schemas/CreateOrgUnitRequest.yaml"),
    },
    NamedYaml {
        name: "DraftEmployeeExitApprovalRequest",
        body: include_str!("../openapi/schemas/DraftEmployeeExitApprovalRequest.yaml"),
    },
    NamedYaml {
        name: "DuplicateOverride",
        body: include_str!("../openapi/schemas/DuplicateOverride.yaml"),
    },
    NamedYaml {
        name: "EmergencyContact",
        body: include_str!("../openapi/schemas/EmergencyContact.yaml"),
    },
    NamedYaml {
        name: "Employee",
        body: include_str!("../openapi/schemas/Employee.yaml"),
    },
    NamedYaml {
        name: "EmployeeAttendanceRecord",
        body: include_str!("../openapi/schemas/EmployeeAttendanceRecord.yaml"),
    },
    NamedYaml {
        name: "EmployeeAttendanceRecordPage",
        body: include_str!("../openapi/schemas/EmployeeAttendanceRecordPage.yaml"),
    },
    NamedYaml {
        name: "EmployeeCareer",
        body: include_str!("../openapi/schemas/EmployeeCareer.yaml"),
    },
    NamedYaml {
        name: "EmployeeCorrection",
        body: include_str!("../openapi/schemas/EmployeeCorrection.yaml"),
    },
    NamedYaml {
        name: "EmployeeCreateWarning",
        body: include_str!("../openapi/schemas/EmployeeCreateWarning.yaml"),
    },
    NamedYaml {
        name: "EmployeeDetail",
        body: include_str!("../openapi/schemas/EmployeeDetail.yaml"),
    },
    NamedYaml {
        name: "EmployeeEmploymentDetail",
        body: include_str!("../openapi/schemas/EmployeeEmploymentDetail.yaml"),
    },
    NamedYaml {
        name: "EmployeeEndOptions",
        body: include_str!("../openapi/schemas/EmployeeEndOptions.yaml"),
    },
    NamedYaml {
        name: "EmployeeExitCase",
        body: include_str!("../openapi/schemas/EmployeeExitCase.yaml"),
    },
    NamedYaml {
        name: "EmployeeExitCasePage",
        body: include_str!("../openapi/schemas/EmployeeExitCasePage.yaml"),
    },
    NamedYaml {
        name: "EmployeeExitCaseStatus",
        body: include_str!("../openapi/schemas/EmployeeExitCaseStatus.yaml"),
    },
    NamedYaml {
        name: "EmployeeExitSettlementPackage",
        body: include_str!("../openapi/schemas/EmployeeExitSettlementPackage.yaml"),
    },
    NamedYaml {
        name: "EmployeeFacetCount",
        body: include_str!("../openapi/schemas/EmployeeFacetCount.yaml"),
    },
    NamedYaml {
        name: "EmployeeFacets",
        body: include_str!("../openapi/schemas/EmployeeFacets.yaml"),
    },
    NamedYaml {
        name: "EmployeeHomeBranch",
        body: include_str!("../openapi/schemas/EmployeeHomeBranch.yaml"),
    },
    NamedYaml {
        name: "EmployeeIdentityResolution",
        body: include_str!("../openapi/schemas/EmployeeIdentityResolution.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportApplyJob",
        body: include_str!("../openapi/schemas/EmployeeImportApplyJob.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportApplyRequest",
        body: include_str!("../openapi/schemas/EmployeeImportApplyRequest.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportColumn",
        body: include_str!("../openapi/schemas/EmployeeImportColumn.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportCompanyConfirmation",
        body: include_str!("../openapi/schemas/EmployeeImportCompanyConfirmation.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportCompanySummary",
        body: include_str!("../openapi/schemas/EmployeeImportCompanySummary.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportDecisions",
        body: include_str!("../openapi/schemas/EmployeeImportDecisions.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportDryRunSummary",
        body: include_str!("../openapi/schemas/EmployeeImportDryRunSummary.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportNameCandidate",
        body: include_str!("../openapi/schemas/EmployeeImportNameCandidate.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportPlannedRow",
        body: include_str!("../openapi/schemas/EmployeeImportPlannedRow.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportPreviewResponse",
        body: include_str!("../openapi/schemas/EmployeeImportPreviewResponse.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportPreviewRow",
        body: include_str!("../openapi/schemas/EmployeeImportPreviewRow.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportReconcile",
        body: include_str!("../openapi/schemas/EmployeeImportReconcile.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportReconcileCounts",
        body: include_str!("../openapi/schemas/EmployeeImportReconcileCounts.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportReconcileRow",
        body: include_str!("../openapi/schemas/EmployeeImportReconcileRow.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportReconcileRowPage",
        body: include_str!("../openapi/schemas/EmployeeImportReconcileRowPage.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportReport",
        body: include_str!("../openapi/schemas/EmployeeImportReport.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportReviewItem",
        body: include_str!("../openapi/schemas/EmployeeImportReviewItem.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportReviewQueue",
        body: include_str!("../openapi/schemas/EmployeeImportReviewQueue.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportSheetReport",
        body: include_str!("../openapi/schemas/EmployeeImportSheetReport.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportSignoff",
        body: include_str!("../openapi/schemas/EmployeeImportSignoff.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportUnplaced",
        body: include_str!("../openapi/schemas/EmployeeImportUnplaced.yaml"),
    },
    NamedYaml {
        name: "EmployeeImportUnplacedPage",
        body: include_str!("../openapi/schemas/EmployeeImportUnplacedPage.yaml"),
    },
    NamedYaml {
        name: "EmployeeLifecycleEvent",
        body: include_str!("../openapi/schemas/EmployeeLifecycleEvent.yaml"),
    },
    NamedYaml {
        name: "EmployeeLifecycleEventPage",
        body: include_str!("../openapi/schemas/EmployeeLifecycleEventPage.yaml"),
    },
    NamedYaml {
        name: "EmployeeLifecycleSignoffs",
        body: include_str!("../openapi/schemas/EmployeeLifecycleSignoffs.yaml"),
    },
    NamedYaml {
        name: "EmployeeNextEvent",
        body: include_str!("../openapi/schemas/EmployeeNextEvent.yaml"),
    },
    NamedYaml {
        name: "EmployeeNumberChange",
        body: include_str!("../openapi/schemas/EmployeeNumberChange.yaml"),
    },
    NamedYaml {
        name: "EmployeeNumberChangeRequest",
        body: include_str!("../openapi/schemas/EmployeeNumberChangeRequest.yaml"),
    },
    NamedYaml {
        name: "EmployeeNumberMatch",
        body: include_str!("../openapi/schemas/EmployeeNumberMatch.yaml"),
    },
    NamedYaml {
        name: "EmployeeNumberRule",
        body: include_str!("../openapi/schemas/EmployeeNumberRule.yaml"),
    },
    NamedYaml {
        name: "EmployeeNumberRuleRequest",
        body: include_str!("../openapi/schemas/EmployeeNumberRuleRequest.yaml"),
    },
    NamedYaml {
        name: "EmployeePage",
        body: include_str!("../openapi/schemas/EmployeePage.yaml"),
    },
    NamedYaml {
        name: "EmployeePendingEmploymentDetail",
        body: include_str!("../openapi/schemas/EmployeePendingEmploymentDetail.yaml"),
    },
    NamedYaml {
        name: "EmployeePersonalFacts",
        body: include_str!("../openapi/schemas/EmployeePersonalFacts.yaml"),
    },
    NamedYaml {
        name: "EmployeePhotoUpload",
        body: include_str!("../openapi/schemas/EmployeePhotoUpload.yaml"),
    },
    NamedYaml {
        name: "EmployeeRegisterFacts",
        body: include_str!("../openapi/schemas/EmployeeRegisterFacts.yaml"),
    },
    NamedYaml {
        name: "EmployeeRenumberApplyRequest",
        body: include_str!("../openapi/schemas/EmployeeRenumberApplyRequest.yaml"),
    },
    NamedYaml {
        name: "EmployeeRenumberPreview",
        body: include_str!("../openapi/schemas/EmployeeRenumberPreview.yaml"),
    },
    NamedYaml {
        name: "EmployeeRenumberRequest",
        body: include_str!("../openapi/schemas/EmployeeRenumberRequest.yaml"),
    },
    NamedYaml {
        name: "EmployeeRenumberResult",
        body: include_str!("../openapi/schemas/EmployeeRenumberResult.yaml"),
    },
    NamedYaml {
        name: "EmployeeRrnRevealRequest",
        body: include_str!("../openapi/schemas/EmployeeRrnRevealRequest.yaml"),
    },
    NamedYaml {
        name: "EmployeeRrnRevealed",
        body: include_str!("../openapi/schemas/EmployeeRrnRevealed.yaml"),
    },
    NamedYaml {
        name: "EmployeeRrnStatus",
        body: include_str!("../openapi/schemas/EmployeeRrnStatus.yaml"),
    },
    NamedYaml {
        name: "EmployeeVoidOutcome",
        body: include_str!("../openapi/schemas/EmployeeVoidOutcome.yaml"),
    },
    NamedYaml {
        name: "EmploymentType",
        body: include_str!("../openapi/schemas/EmploymentType.yaml"),
    },
    NamedYaml {
        name: "ExitCaseNextAction",
        body: include_str!("../openapi/schemas/ExitCaseNextAction.yaml"),
    },
    NamedYaml {
        name: "ExitSettlementDeadline",
        body: include_str!("../openapi/schemas/ExitSettlementDeadline.yaml"),
    },
    NamedYaml {
        name: "ExitSettlementInput",
        body: include_str!("../openapi/schemas/ExitSettlementInput.yaml"),
    },
    NamedYaml {
        name: "HrOrgChartCompany",
        body: include_str!("../openapi/schemas/HrOrgChartCompany.yaml"),
    },
    NamedYaml {
        name: "HrOrgChartEmployee",
        body: include_str!("../openapi/schemas/HrOrgChartEmployee.yaml"),
    },
    NamedYaml {
        name: "HrOrgChartPosition",
        body: include_str!("../openapi/schemas/HrOrgChartPosition.yaml"),
    },
    NamedYaml {
        name: "HrOrgChartResponse",
        body: include_str!("../openapi/schemas/HrOrgChartResponse.yaml"),
    },
    NamedYaml {
        name: "HrOrgChartUnit",
        body: include_str!("../openapi/schemas/HrOrgChartUnit.yaml"),
    },
    NamedYaml {
        name: "ImportApplyRequest",
        body: include_str!("../openapi/schemas/ImportApplyRequest.yaml"),
    },
    NamedYaml {
        name: "ImportDryRunRequest",
        body: include_str!("../openapi/schemas/ImportDryRunRequest.yaml"),
    },
    NamedYaml {
        name: "IssueAppointmentNoticeRequest",
        body: include_str!("../openapi/schemas/IssueAppointmentNoticeRequest.yaml"),
    },
    NamedYaml {
        name: "JobTitleKind",
        body: include_str!("../openapi/schemas/JobTitleKind.yaml"),
    },
    NamedYaml {
        name: "LeaveBalanceItem",
        body: include_str!("../openapi/schemas/LeaveBalanceItem.yaml"),
    },
    NamedYaml {
        name: "LeaveBalancePage",
        body: include_str!("../openapi/schemas/LeaveBalancePage.yaml"),
    },
    NamedYaml {
        name: "LeaveBalanceSummary",
        body: include_str!("../openapi/schemas/LeaveBalanceSummary.yaml"),
    },
    NamedYaml {
        name: "LifecycleScheduleConflictBody",
        body: include_str!("../openapi/schemas/LifecycleScheduleConflictBody.yaml"),
    },
    NamedYaml {
        name: "LifecycleSignoffKey",
        body: include_str!("../openapi/schemas/LifecycleSignoffKey.yaml"),
    },
    NamedYaml {
        name: "OrgChangeDecisionRequest",
        body: include_str!("../openapi/schemas/OrgChangeDecisionRequest.yaml"),
    },
    NamedYaml {
        name: "OrgChangePage",
        body: include_str!("../openapi/schemas/OrgChangePage.yaml"),
    },
    NamedYaml {
        name: "OrgEntitySummary",
        body: include_str!("../openapi/schemas/OrgEntitySummary.yaml"),
    },
    NamedYaml {
        name: "OrgTreeNodeKind",
        body: include_str!("../openapi/schemas/OrgTreeNodeKind.yaml"),
    },
    NamedYaml {
        name: "OrgUnitDetail",
        body: include_str!("../openapi/schemas/OrgUnitDetail.yaml"),
    },
    NamedYaml {
        name: "OrgUnitHead",
        body: include_str!("../openapi/schemas/OrgUnitHead.yaml"),
    },
    NamedYaml {
        name: "OrgUnitList",
        body: include_str!("../openapi/schemas/OrgUnitList.yaml"),
    },
    NamedYaml {
        name: "OrgUnitMember",
        body: include_str!("../openapi/schemas/OrgUnitMember.yaml"),
    },
    NamedYaml {
        name: "OrgUnitMembers",
        body: include_str!("../openapi/schemas/OrgUnitMembers.yaml"),
    },
    NamedYaml {
        name: "OrgUnitRevision",
        body: include_str!("../openapi/schemas/OrgUnitRevision.yaml"),
    },
    NamedYaml {
        name: "OrgUnitStatus",
        body: include_str!("../openapi/schemas/OrgUnitStatus.yaml"),
    },
    NamedYaml {
        name: "PersonRecordAward",
        body: include_str!("../openapi/schemas/PersonRecordAward.yaml"),
    },
    NamedYaml {
        name: "PersonRecordBasis",
        body: include_str!("../openapi/schemas/PersonRecordBasis.yaml"),
    },
    NamedYaml {
        name: "PersonRecordDisability",
        body: include_str!("../openapi/schemas/PersonRecordDisability.yaml"),
    },
    NamedYaml {
        name: "PersonRecordDiscipline",
        body: include_str!("../openapi/schemas/PersonRecordDiscipline.yaml"),
    },
    NamedYaml {
        name: "PersonRecordEducation",
        body: include_str!("../openapi/schemas/PersonRecordEducation.yaml"),
    },
    NamedYaml {
        name: "PersonRecordEntry",
        body: include_str!("../openapi/schemas/PersonRecordEntry.yaml"),
    },
    NamedYaml {
        name: "PersonRecordFamily",
        body: include_str!("../openapi/schemas/PersonRecordFamily.yaml"),
    },
    NamedYaml {
        name: "PersonRecordFields",
        body: include_str!("../openapi/schemas/PersonRecordFields.yaml"),
    },
    NamedYaml {
        name: "PersonRecordHistory",
        body: include_str!("../openapi/schemas/PersonRecordHistory.yaml"),
    },
    NamedYaml {
        name: "PersonRecordImportReport",
        body: include_str!("../openapi/schemas/PersonRecordImportReport.yaml"),
    },
    NamedYaml {
        name: "PersonRecordImportRequest",
        body: include_str!("../openapi/schemas/PersonRecordImportRequest.yaml"),
    },
    NamedYaml {
        name: "PersonRecordLanguage",
        body: include_str!("../openapi/schemas/PersonRecordLanguage.yaml"),
    },
    NamedYaml {
        name: "PersonRecordList",
        body: include_str!("../openapi/schemas/PersonRecordList.yaml"),
    },
    NamedYaml {
        name: "PersonRecordMilitary",
        body: include_str!("../openapi/schemas/PersonRecordMilitary.yaml"),
    },
    NamedYaml {
        name: "PersonRecordQualification",
        body: include_str!("../openapi/schemas/PersonRecordQualification.yaml"),
    },
    NamedYaml {
        name: "PersonRecordSection",
        body: include_str!("../openapi/schemas/PersonRecordSection.yaml"),
    },
    NamedYaml {
        name: "PersonRecordSectionSegment",
        body: include_str!("../openapi/schemas/PersonRecordSectionSegment.yaml"),
    },
    NamedYaml {
        name: "PersonRecordSheet",
        body: include_str!("../openapi/schemas/PersonRecordSheet.yaml"),
    },
    NamedYaml {
        name: "PersonRecordTraining",
        body: include_str!("../openapi/schemas/PersonRecordTraining.yaml"),
    },
    NamedYaml {
        name: "PersonRecordVeteran",
        body: include_str!("../openapi/schemas/PersonRecordVeteran.yaml"),
    },
    NamedYaml {
        name: "RehireEmployeeRequest",
        body: include_str!("../openapi/schemas/RehireEmployeeRequest.yaml"),
    },
    NamedYaml {
        name: "ReportEmployeeExitCaseRequest",
        body: include_str!("../openapi/schemas/ReportEmployeeExitCaseRequest.yaml"),
    },
    NamedYaml {
        name: "ResolveEmployeeIdentityRequest",
        body: include_str!("../openapi/schemas/ResolveEmployeeIdentityRequest.yaml"),
    },
    NamedYaml {
        name: "SetEmployeeHomeBranchRequest",
        body: include_str!("../openapi/schemas/SetEmployeeHomeBranchRequest.yaml"),
    },
    NamedYaml {
        name: "SetEmployeeImportReconcileRowRequest",
        body: include_str!("../openapi/schemas/SetEmployeeImportReconcileRowRequest.yaml"),
    },
    NamedYaml {
        name: "SetupDeleteEmployeeRequest",
        body: include_str!("../openapi/schemas/SetupDeleteEmployeeRequest.yaml"),
    },
    NamedYaml {
        name: "SignOffEmployeeImportRequest",
        body: include_str!("../openapi/schemas/SignOffEmployeeImportRequest.yaml"),
    },
    NamedYaml {
        name: "UpdateOrgChangeDraftRequest",
        body: include_str!("../openapi/schemas/UpdateOrgChangeDraftRequest.yaml"),
    },
    NamedYaml {
        name: "UpdateOrgUnitRequest",
        body: include_str!("../openapi/schemas/UpdateOrgUnitRequest.yaml"),
    },
    NamedYaml {
        name: "VoidEmployeeRequest",
        body: include_str!("../openapi/schemas/VoidEmployeeRequest.yaml"),
    },
    NamedYaml {
        name: "VoidedEmployee",
        body: include_str!("../openapi/schemas/VoidedEmployee.yaml"),
    },
];
