//! This face's slice of the published OpenAPI contract.
//!
//! Bodies live as YAML under `openapi/` and are pulled in via `include_str!`.
//! `console_contracts` re-indents them; composition rejects duplicate keys.

use console_contracts::{Fragment, NamedYaml, Operation, PathItem};

/// This face's contribution to the composed OpenAPI document.
pub const OPENAPI_FRAGMENT: Fragment = Fragment {
    source: "console-entity-rest",
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
    "MobilePasskeyStepUpEnvelope",
    "OrgUnitMembers",
    "Uuid",
];

const PATHS: &[PathItem] = &[
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}",
        operations: &[Operation {
            method: "put",
            body: include_str!(
                "../openapi/paths/api__v1__business-registrations__registrationId.put.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}/checks",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__business-registrations__registrationId__checks.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__business-registrations__registrationId__checks.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}/end-options",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__business-registrations__registrationId__end-options.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}/identifier-corrections",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__business-registrations__registrationId__identifier-corrections.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}/original",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__business-registrations__registrationId__original.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}/reissues",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__business-registrations__registrationId__reissues.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}/revisions",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__business-registrations__registrationId__revisions.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/business-registrations/{registrationId}/void",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__business-registrations__registrationId__void.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employment-assignments",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__employment-assignments.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__employment-assignments.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/employment-assignments/map-company",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__employment-assignments__map-company.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/employment-assignments/unmapped-companies",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__employment-assignments__unmapped-companies.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/entity-documents",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__entity-documents.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/entity-documents/{id}",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__entity-documents__id.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/entity-documents/{id}/content",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__entity-documents__id__content.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/entity-identifier-corrections",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__entity-identifier-corrections.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/entity-identifier-corrections/{id}",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__entity-identifier-corrections__id.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/entity-identifier-corrections/{id}/review",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__entity-identifier-corrections__id__review.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/entity-setup/batches",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__entity-setup__batches.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__entity-setup__batches.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/entity-setup/batches/{batchId}/undo",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__entity-setup__batches__batchId__undo.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/governed-exceptions/{id}/decide",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__governed-exceptions__id__decide.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__legal-entities.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__legal-entities.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__legal-entities__entityId.get.yaml"),
            },
            Operation {
                method: "put",
                body: include_str!("../openapi/paths/api__v1__legal-entities__entityId.put.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/close",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!(
                    "../openapi/paths/api__v1__legal-entities__entityId__close.delete.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__legal-entities__entityId__close.post.yaml"
                ),
            },
            Operation {
                method: "put",
                body: include_str!(
                    "../openapi/paths/api__v1__legal-entities__entityId__close.put.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/documents",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__documents.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/end-options",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__end-options.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/identifier-corrections",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__identifier-corrections.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/name-reviews/{reviewId}/settle",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__name-reviews__reviewId__settle.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/registrations",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__registrations.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/revisions",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__revisions.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/roles",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__roles.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/void",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__legal-entities__entityId__void.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/legal-entities/{entityId}/workplaces",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__legal-entities__entityId__workplaces.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__legal-entities__entityId__workplaces.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/org-structure",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__org-structure.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/batches",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__org-structure__batches.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__org-structure__batches.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/org-structure/batches/{batchId}/undo",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__org-structure__batches__batchId__undo.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/change-dates",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__org-structure__change-dates.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/diff",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__org-structure__diff.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/order",
        operations: &[Operation {
            method: "put",
            body: include_str!("../openapi/paths/api__v1__org-structure__order.put.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/units",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__org-structure__units.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/units/{orgUnitId}",
        operations: &[
            Operation {
                method: "delete",
                body: include_str!(
                    "../openapi/paths/api__v1__org-structure__units__orgUnitId.delete.yaml"
                ),
            },
            Operation {
                method: "patch",
                body: include_str!(
                    "../openapi/paths/api__v1__org-structure__units__orgUnitId.patch.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/org-structure/units/{orgUnitId}/details",
        operations: &[Operation {
            method: "put",
            body: include_str!(
                "../openapi/paths/api__v1__org-structure__units__orgUnitId__details.put.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/units/{orgUnitId}/dissolve",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__org-structure__units__orgUnitId__dissolve.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/units/{orgUnitId}/end-options",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__org-structure__units__orgUnitId__end-options.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/units/{orgUnitId}/erase",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__org-structure__units__orgUnitId__erase.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/org-structure/units/{orgUnitId}/members",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__org-structure__units__orgUnitId__members.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/ref/address-detail",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__ref__address-detail.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/ref/address-search",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__ref__address-search.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/ref/lists/{key}/codes",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__ref__lists__key__codes.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/registration-checks/availability",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__registration-checks__availability.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/registration-checks/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__registration-checks__preview.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/workplace-kinds",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__workplace-kinds.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__workplace-kinds.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/workplace-kinds/{code}",
        operations: &[Operation {
            method: "patch",
            body: include_str!("../openapi/paths/api__v1__workplace-kinds__code.patch.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__workplaces.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__workplaces__workplaceId.get.yaml"),
            },
            Operation {
                method: "put",
                body: include_str!("../openapi/paths/api__v1__workplaces__workplaceId.put.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/close-plan",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__workplaces__workplaceId__close-plan.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__workplaces__workplaceId__close-plan.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/close-plan/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__workplaces__workplaceId__close-plan__cancel.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/code",
        operations: &[Operation {
            method: "put",
            body: include_str!("../openapi/paths/api__v1__workplaces__workplaceId__code.put.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/end-options",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__workplaces__workplaceId__end-options.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/insurance",
        operations: &[Operation {
            method: "put",
            body: include_str!(
                "../openapi/paths/api__v1__workplaces__workplaceId__insurance.put.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/kind",
        operations: &[Operation {
            method: "put",
            body: include_str!("../openapi/paths/api__v1__workplaces__workplaceId__kind.put.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/registration-changes",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__workplaces__workplaceId__registration-changes.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/revisions",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__workplaces__workplaceId__revisions.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/workplaces/{workplaceId}/void",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__workplaces__workplaceId__void.post.yaml"),
        }],
    },
];

const SCHEMAS: &[NamedYaml] = &[
    NamedYaml {
        name: "AddressDetailOption",
        body: include_str!("../openapi/schemas/AddressDetailOption.yaml"),
    },
    NamedYaml {
        name: "AddressDetailResult",
        body: include_str!("../openapi/schemas/AddressDetailResult.yaml"),
    },
    NamedYaml {
        name: "AddressSearchResult",
        body: include_str!("../openapi/schemas/AddressSearchResult.yaml"),
    },
    NamedYaml {
        name: "BindAssignmentRequest",
        body: include_str!("../openapi/schemas/BindAssignmentRequest.yaml"),
    },
    NamedYaml {
        name: "BrnPendingReason",
        body: include_str!("../openapi/schemas/BrnPendingReason.yaml"),
    },
    NamedYaml {
        name: "BusinessRegistration",
        body: include_str!("../openapi/schemas/BusinessRegistration.yaml"),
    },
    NamedYaml {
        name: "CloseCorrectionRequest",
        body: include_str!("../openapi/schemas/CloseCorrectionRequest.yaml"),
    },
    NamedYaml {
        name: "CloseLegalEntityRequest",
        body: include_str!("../openapi/schemas/CloseLegalEntityRequest.yaml"),
    },
    NamedYaml {
        name: "CloseWithdrawalRequest",
        body: include_str!("../openapi/schemas/CloseWithdrawalRequest.yaml"),
    },
    NamedYaml {
        name: "CodeInput",
        body: include_str!("../openapi/schemas/CodeInput.yaml"),
    },
    NamedYaml {
        name: "CodeRef",
        body: include_str!("../openapi/schemas/CodeRef.yaml"),
    },
    NamedYaml {
        name: "CreateBusinessRegistrationRequest",
        body: include_str!("../openapi/schemas/CreateBusinessRegistrationRequest.yaml"),
    },
    NamedYaml {
        name: "CreateLegalEntityRequest",
        body: include_str!("../openapi/schemas/CreateLegalEntityRequest.yaml"),
    },
    NamedYaml {
        name: "CreateSetupOrgUnitRequest",
        body: include_str!("../openapi/schemas/CreateSetupOrgUnitRequest.yaml"),
    },
    NamedYaml {
        name: "CreateWorkplaceKindRequest",
        body: include_str!("../openapi/schemas/CreateWorkplaceKindRequest.yaml"),
    },
    NamedYaml {
        name: "CreateWorkplaceRequest",
        body: include_str!("../openapi/schemas/CreateWorkplaceRequest.yaml"),
    },
    NamedYaml {
        name: "EmploymentAssignment",
        body: include_str!("../openapi/schemas/EmploymentAssignment.yaml"),
    },
    NamedYaml {
        name: "EmploymentAssignmentList",
        body: include_str!("../openapi/schemas/EmploymentAssignmentList.yaml"),
    },
    NamedYaml {
        name: "EntityBizKind",
        body: include_str!("../openapi/schemas/EntityBizKind.yaml"),
    },
    NamedYaml {
        name: "EntityBusinessType",
        body: include_str!("../openapi/schemas/EntityBusinessType.yaml"),
    },
    NamedYaml {
        name: "EntityBusinessTypeInput",
        body: include_str!("../openapi/schemas/EntityBusinessTypeInput.yaml"),
    },
    NamedYaml {
        name: "EntityChangeMode",
        body: include_str!("../openapi/schemas/EntityChangeMode.yaml"),
    },
    NamedYaml {
        name: "EntityCloseReason",
        body: include_str!("../openapi/schemas/EntityCloseReason.yaml"),
    },
    NamedYaml {
        name: "EntityCorrectionReason",
        body: include_str!("../openapi/schemas/EntityCorrectionReason.yaml"),
    },
    NamedYaml {
        name: "EntityDirector",
        body: include_str!("../openapi/schemas/EntityDirector.yaml"),
    },
    NamedYaml {
        name: "EntityDirectorInput",
        body: include_str!("../openapi/schemas/EntityDirectorInput.yaml"),
    },
    NamedYaml {
        name: "EntityDirectorRole",
        body: include_str!("../openapi/schemas/EntityDirectorRole.yaml"),
    },
    NamedYaml {
        name: "EntityDocument",
        body: include_str!("../openapi/schemas/EntityDocument.yaml"),
    },
    NamedYaml {
        name: "EntityDocumentKind",
        body: include_str!("../openapi/schemas/EntityDocumentKind.yaml"),
    },
    NamedYaml {
        name: "EntityDocumentList",
        body: include_str!("../openapi/schemas/EntityDocumentList.yaml"),
    },
    NamedYaml {
        name: "EntityDocumentUpload",
        body: include_str!("../openapi/schemas/EntityDocumentUpload.yaml"),
    },
    NamedYaml {
        name: "EntityFieldChange",
        body: include_str!("../openapi/schemas/EntityFieldChange.yaml"),
    },
    NamedYaml {
        name: "EntityFieldWarning",
        body: include_str!("../openapi/schemas/EntityFieldWarning.yaml"),
    },
    NamedYaml {
        name: "EntityIssueReasonKind",
        body: include_str!("../openapi/schemas/EntityIssueReasonKind.yaml"),
    },
    NamedYaml {
        name: "EntityRepresentationMode",
        body: include_str!("../openapi/schemas/EntityRepresentationMode.yaml"),
    },
    NamedYaml {
        name: "EntityRevision",
        body: include_str!("../openapi/schemas/EntityRevision.yaml"),
    },
    NamedYaml {
        name: "EntityRevisionList",
        body: include_str!("../openapi/schemas/EntityRevisionList.yaml"),
    },
    NamedYaml {
        name: "EntityRolesRequest",
        body: include_str!("../openapi/schemas/EntityRolesRequest.yaml"),
    },
    NamedYaml {
        name: "EntitySetupBatchList",
        body: include_str!("../openapi/schemas/EntitySetupBatchList.yaml"),
    },
    NamedYaml {
        name: "EntitySetupBatchRequest",
        body: include_str!("../openapi/schemas/EntitySetupBatchRequest.yaml"),
    },
    NamedYaml {
        name: "EntitySetupBatchView",
        body: include_str!("../openapi/schemas/EntitySetupBatchView.yaml"),
    },
    NamedYaml {
        name: "EntitySetupItem",
        body: include_str!("../openapi/schemas/EntitySetupItem.yaml"),
    },
    NamedYaml {
        name: "EntitySetupOp",
        body: include_str!("../openapi/schemas/EntitySetupOp.yaml"),
    },
    NamedYaml {
        name: "EntitySetupOpError",
        body: include_str!("../openapi/schemas/EntitySetupOpError.yaml"),
    },
    NamedYaml {
        name: "EntitySetupResult",
        body: include_str!("../openapi/schemas/EntitySetupResult.yaml"),
    },
    NamedYaml {
        name: "FormattedValue",
        body: include_str!("../openapi/schemas/FormattedValue.yaml"),
    },
    NamedYaml {
        name: "IaciBusinessForm",
        body: include_str!("../openapi/schemas/IaciBusinessForm.yaml"),
    },
    NamedYaml {
        name: "IdentifierCorrectionCase",
        body: include_str!("../openapi/schemas/IdentifierCorrectionCase.yaml"),
    },
    NamedYaml {
        name: "IdentifierCorrectionCasePage",
        body: include_str!("../openapi/schemas/IdentifierCorrectionCasePage.yaml"),
    },
    NamedYaml {
        name: "IdentifierCorrectionReason",
        body: include_str!("../openapi/schemas/IdentifierCorrectionReason.yaml"),
    },
    NamedYaml {
        name: "IdentifierCorrectionRequest",
        body: include_str!("../openapi/schemas/IdentifierCorrectionRequest.yaml"),
    },
    NamedYaml {
        name: "InsuranceRelation",
        body: include_str!("../openapi/schemas/InsuranceRelation.yaml"),
    },
    NamedYaml {
        name: "InsuranceRevisionRequest",
        body: include_str!("../openapi/schemas/InsuranceRevisionRequest.yaml"),
    },
    NamedYaml {
        name: "InsuranceSetupInput",
        body: include_str!("../openapi/schemas/InsuranceSetupInput.yaml"),
    },
    NamedYaml {
        name: "InsuranceShortcut",
        body: include_str!("../openapi/schemas/InsuranceShortcut.yaml"),
    },
    NamedYaml {
        name: "InsuranceStatus",
        body: include_str!("../openapi/schemas/InsuranceStatus.yaml"),
    },
    NamedYaml {
        name: "InsuranceUnitMode",
        body: include_str!("../openapi/schemas/InsuranceUnitMode.yaml"),
    },
    NamedYaml {
        name: "Insurer",
        body: include_str!("../openapi/schemas/Insurer.yaml"),
    },
    NamedYaml {
        name: "InsurerInput",
        body: include_str!("../openapi/schemas/InsurerInput.yaml"),
    },
    NamedYaml {
        name: "LegalEntity",
        body: include_str!("../openapi/schemas/LegalEntity.yaml"),
    },
    NamedYaml {
        name: "LegalEntityInput",
        body: include_str!("../openapi/schemas/LegalEntityInput.yaml"),
    },
    NamedYaml {
        name: "LegalEntityList",
        body: include_str!("../openapi/schemas/LegalEntityList.yaml"),
    },
    NamedYaml {
        name: "LegalEntityNameReview",
        body: include_str!("../openapi/schemas/LegalEntityNameReview.yaml"),
    },
    NamedYaml {
        name: "LegalEntityRevisionRequest",
        body: include_str!("../openapi/schemas/LegalEntityRevisionRequest.yaml"),
    },
    NamedYaml {
        name: "LegalEntityState",
        body: include_str!("../openapi/schemas/LegalEntityState.yaml"),
    },
    NamedYaml {
        name: "MapCompanyRequest",
        body: include_str!("../openapi/schemas/MapCompanyRequest.yaml"),
    },
    NamedYaml {
        name: "MapCompanyResult",
        body: include_str!("../openapi/schemas/MapCompanyResult.yaml"),
    },
    NamedYaml {
        name: "NhisWorkplaceClass",
        body: include_str!("../openapi/schemas/NhisWorkplaceClass.yaml"),
    },
    NamedYaml {
        name: "NtsTaxType",
        body: include_str!("../openapi/schemas/NtsTaxType.yaml"),
    },
    NamedYaml {
        name: "OperatingStatus",
        body: include_str!("../openapi/schemas/OperatingStatus.yaml"),
    },
    NamedYaml {
        name: "OrgSetupBatchList",
        body: include_str!("../openapi/schemas/OrgSetupBatchList.yaml"),
    },
    NamedYaml {
        name: "OrgSetupBatchRequest",
        body: include_str!("../openapi/schemas/OrgSetupBatchRequest.yaml"),
    },
    NamedYaml {
        name: "OrgSetupBatchView",
        body: include_str!("../openapi/schemas/OrgSetupBatchView.yaml"),
    },
    NamedYaml {
        name: "OrgSetupOp",
        body: include_str!("../openapi/schemas/OrgSetupOp.yaml"),
    },
    NamedYaml {
        name: "OrgSetupReceipt",
        body: include_str!("../openapi/schemas/OrgSetupReceipt.yaml"),
    },
    NamedYaml {
        name: "OrgSetupUnit",
        body: include_str!("../openapi/schemas/OrgSetupUnit.yaml"),
    },
    NamedYaml {
        name: "OrgStructure",
        body: include_str!("../openapi/schemas/OrgStructure.yaml"),
    },
    NamedYaml {
        name: "OrgStructureNode",
        body: include_str!("../openapi/schemas/OrgStructureNode.yaml"),
    },
    NamedYaml {
        name: "OrgUnitDetailsRequest",
        body: include_str!("../openapi/schemas/OrgUnitDetailsRequest.yaml"),
    },
    NamedYaml {
        name: "OrgUnitEndOptions",
        body: include_str!("../openapi/schemas/OrgUnitEndOptions.yaml"),
    },
    NamedYaml {
        name: "OrgUnitErased",
        body: include_str!("../openapi/schemas/OrgUnitErased.yaml"),
    },
    NamedYaml {
        name: "OrgUnitHeadRef",
        body: include_str!("../openapi/schemas/OrgUnitHeadRef.yaml"),
    },
    NamedYaml {
        name: "PinnedVersionRequest",
        body: include_str!("../openapi/schemas/PinnedVersionRequest.yaml"),
    },
    NamedYaml {
        name: "PrioritySupport",
        body: include_str!("../openapi/schemas/PrioritySupport.yaml"),
    },
    NamedYaml {
        name: "PrioritySupportBasis",
        body: include_str!("../openapi/schemas/PrioritySupportBasis.yaml"),
    },
    NamedYaml {
        name: "RecordEndOptions",
        body: include_str!("../openapi/schemas/RecordEndOptions.yaml"),
    },
    NamedYaml {
        name: "RefCode",
        body: include_str!("../openapi/schemas/RefCode.yaml"),
    },
    NamedYaml {
        name: "RefCodePage",
        body: include_str!("../openapi/schemas/RefCodePage.yaml"),
    },
    NamedYaml {
        name: "RefList",
        body: include_str!("../openapi/schemas/RefList.yaml"),
    },
    NamedYaml {
        name: "RefListSource",
        body: include_str!("../openapi/schemas/RefListSource.yaml"),
    },
    NamedYaml {
        name: "RegistrationCheckAnswer",
        body: include_str!("../openapi/schemas/RegistrationCheckAnswer.yaml"),
    },
    NamedYaml {
        name: "RegistrationCheckAvailability",
        body: include_str!("../openapi/schemas/RegistrationCheckAvailability.yaml"),
    },
    NamedYaml {
        name: "RegistrationCheckEvidence",
        body: include_str!("../openapi/schemas/RegistrationCheckEvidence.yaml"),
    },
    NamedYaml {
        name: "RegistrationCheckHistory",
        body: include_str!("../openapi/schemas/RegistrationCheckHistory.yaml"),
    },
    NamedYaml {
        name: "RegistrationCheckPreview",
        body: include_str!("../openapi/schemas/RegistrationCheckPreview.yaml"),
    },
    NamedYaml {
        name: "RegistrationCheckRequest",
        body: include_str!("../openapi/schemas/RegistrationCheckRequest.yaml"),
    },
    NamedYaml {
        name: "RegistrationEndOptions",
        body: include_str!("../openapi/schemas/RegistrationEndOptions.yaml"),
    },
    NamedYaml {
        name: "RegistrationInput",
        body: include_str!("../openapi/schemas/RegistrationInput.yaml"),
    },
    NamedYaml {
        name: "RegistrationReissueRequest",
        body: include_str!("../openapi/schemas/RegistrationReissueRequest.yaml"),
    },
    NamedYaml {
        name: "RegistrationRevisionRequest",
        body: include_str!("../openapi/schemas/RegistrationRevisionRequest.yaml"),
    },
    NamedYaml {
        name: "RegistrationState",
        body: include_str!("../openapi/schemas/RegistrationState.yaml"),
    },
    NamedYaml {
        name: "RegularWorkers",
        body: include_str!("../openapi/schemas/RegularWorkers.yaml"),
    },
    NamedYaml {
        name: "RenameSetupOrgUnitRequest",
        body: include_str!("../openapi/schemas/RenameSetupOrgUnitRequest.yaml"),
    },
    NamedYaml {
        name: "ReorderStructureRequest",
        body: include_str!("../openapi/schemas/ReorderStructureRequest.yaml"),
    },
    NamedYaml {
        name: "SavedBusinessRegistration",
        body: include_str!("../openapi/schemas/SavedBusinessRegistration.yaml"),
    },
    NamedYaml {
        name: "SavedLegalEntity",
        body: include_str!("../openapi/schemas/SavedLegalEntity.yaml"),
    },
    NamedYaml {
        name: "SavedWorkplace",
        body: include_str!("../openapi/schemas/SavedWorkplace.yaml"),
    },
    NamedYaml {
        name: "SetWorkplaceCodeRequest",
        body: include_str!("../openapi/schemas/SetWorkplaceCodeRequest.yaml"),
    },
    NamedYaml {
        name: "SetWorkplaceKindRequest",
        body: include_str!("../openapi/schemas/SetWorkplaceKindRequest.yaml"),
    },
    NamedYaml {
        name: "SettleNameReviewRequest",
        body: include_str!("../openapi/schemas/SettleNameReviewRequest.yaml"),
    },
    NamedYaml {
        name: "SetupOrgUnitResult",
        body: include_str!("../openapi/schemas/SetupOrgUnitResult.yaml"),
    },
    NamedYaml {
        name: "StructureChangeDates",
        body: include_str!("../openapi/schemas/StructureChangeDates.yaml"),
    },
    NamedYaml {
        name: "StructureDiff",
        body: include_str!("../openapi/schemas/StructureDiff.yaml"),
    },
    NamedYaml {
        name: "StructureNodeDiff",
        body: include_str!("../openapi/schemas/StructureNodeDiff.yaml"),
    },
    NamedYaml {
        name: "StructureOrder",
        body: include_str!("../openapi/schemas/StructureOrder.yaml"),
    },
    NamedYaml {
        name: "StructureScheduledBy",
        body: include_str!("../openapi/schemas/StructureScheduledBy.yaml"),
    },
    NamedYaml {
        name: "UnmappedCompanyList",
        body: include_str!("../openapi/schemas/UnmappedCompanyList.yaml"),
    },
    NamedYaml {
        name: "UnverifiedReason",
        body: include_str!("../openapi/schemas/UnverifiedReason.yaml"),
    },
    NamedYaml {
        name: "UpdateWorkplaceKindRequest",
        body: include_str!("../openapi/schemas/UpdateWorkplaceKindRequest.yaml"),
    },
    NamedYaml {
        name: "VatUnitBasis",
        body: include_str!("../openapi/schemas/VatUnitBasis.yaml"),
    },
    NamedYaml {
        name: "VatUnitMode",
        body: include_str!("../openapi/schemas/VatUnitMode.yaml"),
    },
    NamedYaml {
        name: "VoidRecordRequest",
        body: include_str!("../openapi/schemas/VoidRecordRequest.yaml"),
    },
    NamedYaml {
        name: "WithholdingMode",
        body: include_str!("../openapi/schemas/WithholdingMode.yaml"),
    },
    NamedYaml {
        name: "WithholdingTarget",
        body: include_str!("../openapi/schemas/WithholdingTarget.yaml"),
    },
    NamedYaml {
        name: "Workplace",
        body: include_str!("../openapi/schemas/Workplace.yaml"),
    },
    NamedYaml {
        name: "WorkplaceCloseJob",
        body: include_str!("../openapi/schemas/WorkplaceCloseJob.yaml"),
    },
    NamedYaml {
        name: "WorkplaceClosePlanRequest",
        body: include_str!("../openapi/schemas/WorkplaceClosePlanRequest.yaml"),
    },
    NamedYaml {
        name: "WorkplaceClosePlanView",
        body: include_str!("../openapi/schemas/WorkplaceClosePlanView.yaml"),
    },
    NamedYaml {
        name: "WorkplaceInput",
        body: include_str!("../openapi/schemas/WorkplaceInput.yaml"),
    },
    NamedYaml {
        name: "WorkplaceKind",
        body: include_str!("../openapi/schemas/WorkplaceKind.yaml"),
    },
    NamedYaml {
        name: "WorkplaceKindList",
        body: include_str!("../openapi/schemas/WorkplaceKindList.yaml"),
    },
    NamedYaml {
        name: "WorkplaceList",
        body: include_str!("../openapi/schemas/WorkplaceList.yaml"),
    },
    NamedYaml {
        name: "WorkplaceRegistrationChangeRequest",
        body: include_str!("../openapi/schemas/WorkplaceRegistrationChangeRequest.yaml"),
    },
    NamedYaml {
        name: "WorkplaceRevisionRequest",
        body: include_str!("../openapi/schemas/WorkplaceRevisionRequest.yaml"),
    },
    NamedYaml {
        name: "WorkplaceState",
        body: include_str!("../openapi/schemas/WorkplaceState.yaml"),
    },
];
