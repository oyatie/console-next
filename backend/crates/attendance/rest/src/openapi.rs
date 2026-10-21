//! This face's slice of the published OpenAPI contract.
//!
//! Bodies live as YAML under `openapi/` and are pulled in via `include_str!`.
//! `console_contracts` re-indents them; composition rejects duplicate keys.

use console_contracts::{Fragment, NamedYaml, Operation, PathItem};

/// This face's contribution to the composed OpenAPI document.
pub const OPENAPI_FRAGMENT: Fragment = Fragment {
    source: "console-attendance-rest",
    paths: PATHS,
    schemas: SCHEMAS,
    parameters: &[],
    responses: &[],
    security_schemes: &[],
    external_schemas: EXTERNAL_SCHEMAS,
};

const EXTERNAL_SCHEMAS: &[&str] = &["Uuid"];

const PATHS: &[PathItem] = &[
    PathItem {
        path: "/api/v1/attendance/batches/{batch_id}/undo",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__batches__batch_id__undo.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/closes",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__attendance__closes.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__attendance__closes.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/attendance/closes/preflight",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__attendance__closes__preflight.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/closes/{close_id}/amendments",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__closes__close_id__amendments.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/crews",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__attendance__crews.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__attendance__crews.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/attendance/crews/{crew_id}/members",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__crews__crew_id__members.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/days",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__days.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/entries",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__attendance__entries.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/entries/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__attendance__entries__preview.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/entries/{entry_id}/correct",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__entries__entry_id__correct.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/entries/{entry_id}/void",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__entries__entry_id__void.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/exceptions",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__attendance__exceptions.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__attendance__exceptions.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/attendance/exceptions/{exception_id}",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__exceptions__exception_id.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/exceptions/{exception_id}/resolve",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__exceptions__exception_id__resolve.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/holidays",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__attendance__holidays.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__attendance__holidays.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/attendance/holidays/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__attendance__holidays__preview.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/holidays/{holiday_id}/retire",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__holidays__holiday_id__retire.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/me/exceptions",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__me__exceptions.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/me/schedule",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__me__schedule.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/me/week52",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__me__week52.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/month",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__month.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/patterns",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__attendance__patterns.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__attendance__patterns.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/attendance/patterns/{pattern_id}/retire",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__patterns__pattern_id__retire.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/people/{employee_id}/month",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__people__employee_id__month.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/schedule/calendar",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__schedule__calendar.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/schedule/layers",
        operations: &[
            Operation {
                method: "get",
                body: include_str!(
                    "../openapi/paths/api__v1__attendance__schedule__layers.get.yaml"
                ),
            },
            Operation {
                method: "post",
                body: include_str!(
                    "../openapi/paths/api__v1__attendance__schedule__layers.post.yaml"
                ),
            },
        ],
    },
    PathItem {
        path: "/api/v1/attendance/schedule/layers/preview",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__schedule__layers__preview.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/schedule/layers/{layer_id}/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__schedule__layers__layer_id__cancel.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/schedule/tree",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__schedule__tree.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/substitution-candidates",
        operations: &[Operation {
            method: "get",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__substitution-candidates.get.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/substitutions",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__attendance__substitutions.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__attendance__substitutions.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/attendance/substitutions/{substitution_id}/cancel",
        operations: &[Operation {
            method: "post",
            body: include_str!(
                "../openapi/paths/api__v1__attendance__substitutions__substitution_id__cancel.post.yaml"
            ),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/week52",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__attendance__week52.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/attendance/week52/acks",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__attendance__week52__acks.post.yaml"),
        }],
    },
];

const SCHEMAS: &[NamedYaml] = &[
    NamedYaml {
        name: "AssignAttendanceSubstituteRequest",
        body: include_str!("../openapi/schemas/AssignAttendanceSubstituteRequest.yaml"),
    },
    NamedYaml {
        name: "AttendanceBoardGroup",
        body: include_str!("../openapi/schemas/AttendanceBoardGroup.yaml"),
    },
    NamedYaml {
        name: "AttendanceBoardRow",
        body: include_str!("../openapi/schemas/AttendanceBoardRow.yaml"),
    },
    NamedYaml {
        name: "AttendanceCellInput",
        body: include_str!("../openapi/schemas/AttendanceCellInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceCellPreview",
        body: include_str!("../openapi/schemas/AttendanceCellPreview.yaml"),
    },
    NamedYaml {
        name: "AttendanceCloseAmendment",
        body: include_str!("../openapi/schemas/AttendanceCloseAmendment.yaml"),
    },
    NamedYaml {
        name: "AttendanceCloseAmendmentRequest",
        body: include_str!("../openapi/schemas/AttendanceCloseAmendmentRequest.yaml"),
    },
    NamedYaml {
        name: "AttendanceCloseBoard",
        body: include_str!("../openapi/schemas/AttendanceCloseBoard.yaml"),
    },
    NamedYaml {
        name: "AttendanceCloseCheck",
        body: include_str!("../openapi/schemas/AttendanceCloseCheck.yaml"),
    },
    NamedYaml {
        name: "AttendanceClosePreflight",
        body: include_str!("../openapi/schemas/AttendanceClosePreflight.yaml"),
    },
    NamedYaml {
        name: "AttendanceCloseRequest",
        body: include_str!("../openapi/schemas/AttendanceCloseRequest.yaml"),
    },
    NamedYaml {
        name: "AttendanceConflict",
        body: include_str!("../openapi/schemas/AttendanceConflict.yaml"),
    },
    NamedYaml {
        name: "AttendanceContractualHoliday",
        body: include_str!("../openapi/schemas/AttendanceContractualHoliday.yaml"),
    },
    NamedYaml {
        name: "AttendanceCorrectInput",
        body: include_str!("../openapi/schemas/AttendanceCorrectInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceCrew",
        body: include_str!("../openapi/schemas/AttendanceCrew.yaml"),
    },
    NamedYaml {
        name: "AttendanceCrewInput",
        body: include_str!("../openapi/schemas/AttendanceCrewInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceCrewList",
        body: include_str!("../openapi/schemas/AttendanceCrewList.yaml"),
    },
    NamedYaml {
        name: "AttendanceCrewMember",
        body: include_str!("../openapi/schemas/AttendanceCrewMember.yaml"),
    },
    NamedYaml {
        name: "AttendanceCrewMembersInput",
        body: include_str!("../openapi/schemas/AttendanceCrewMembersInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceDay",
        body: include_str!("../openapi/schemas/AttendanceDay.yaml"),
    },
    NamedYaml {
        name: "AttendanceDayBoard",
        body: include_str!("../openapi/schemas/AttendanceDayBoard.yaml"),
    },
    NamedYaml {
        name: "AttendanceDayKind",
        body: include_str!("../openapi/schemas/AttendanceDayKind.yaml"),
    },
    NamedYaml {
        name: "AttendanceDaySpec",
        body: include_str!("../openapi/schemas/AttendanceDaySpec.yaml"),
    },
    NamedYaml {
        name: "AttendanceEntry",
        body: include_str!("../openapi/schemas/AttendanceEntry.yaml"),
    },
    NamedYaml {
        name: "AttendanceEntryConflictBody",
        body: include_str!("../openapi/schemas/AttendanceEntryConflictBody.yaml"),
    },
    NamedYaml {
        name: "AttendanceEntryKind",
        body: include_str!("../openapi/schemas/AttendanceEntryKind.yaml"),
    },
    NamedYaml {
        name: "AttendanceEvidence",
        body: include_str!("../openapi/schemas/AttendanceEvidence.yaml"),
    },
    NamedYaml {
        name: "AttendanceException",
        body: include_str!("../openapi/schemas/AttendanceException.yaml"),
    },
    NamedYaml {
        name: "AttendanceExceptionEvidence",
        body: include_str!("../openapi/schemas/AttendanceExceptionEvidence.yaml"),
    },
    NamedYaml {
        name: "AttendanceExceptionLink",
        body: include_str!("../openapi/schemas/AttendanceExceptionLink.yaml"),
    },
    NamedYaml {
        name: "AttendanceExceptionPage",
        body: include_str!("../openapi/schemas/AttendanceExceptionPage.yaml"),
    },
    NamedYaml {
        name: "AttendanceExceptionResolution",
        body: include_str!("../openapi/schemas/AttendanceExceptionResolution.yaml"),
    },
    NamedYaml {
        name: "AttendanceGridCell",
        body: include_str!("../openapi/schemas/AttendanceGridCell.yaml"),
    },
    NamedYaml {
        name: "AttendanceGridRow",
        body: include_str!("../openapi/schemas/AttendanceGridRow.yaml"),
    },
    NamedYaml {
        name: "AttendanceGridTotals",
        body: include_str!("../openapi/schemas/AttendanceGridTotals.yaml"),
    },
    NamedYaml {
        name: "AttendanceHistoryRow",
        body: include_str!("../openapi/schemas/AttendanceHistoryRow.yaml"),
    },
    NamedYaml {
        name: "AttendanceHolidayInput",
        body: include_str!("../openapi/schemas/AttendanceHolidayInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceHolidayOverlap",
        body: include_str!("../openapi/schemas/AttendanceHolidayOverlap.yaml"),
    },
    NamedYaml {
        name: "AttendanceHolidayPreview",
        body: include_str!("../openapi/schemas/AttendanceHolidayPreview.yaml"),
    },
    NamedYaml {
        name: "AttendanceHolidayRetireInput",
        body: include_str!("../openapi/schemas/AttendanceHolidayRetireInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceHolidayYear",
        body: include_str!("../openapi/schemas/AttendanceHolidayYear.yaml"),
    },
    NamedYaml {
        name: "AttendanceLayerSummary",
        body: include_str!("../openapi/schemas/AttendanceLayerSummary.yaml"),
    },
    NamedYaml {
        name: "AttendanceLedger",
        body: include_str!("../openapi/schemas/AttendanceLedger.yaml"),
    },
    NamedYaml {
        name: "AttendanceMark",
        body: include_str!("../openapi/schemas/AttendanceMark.yaml"),
    },
    NamedYaml {
        name: "AttendanceMarkCounts",
        body: include_str!("../openapi/schemas/AttendanceMarkCounts.yaml"),
    },
    NamedYaml {
        name: "AttendanceMonthClose",
        body: include_str!("../openapi/schemas/AttendanceMonthClose.yaml"),
    },
    NamedYaml {
        name: "AttendanceMonthCloseItem",
        body: include_str!("../openapi/schemas/AttendanceMonthCloseItem.yaml"),
    },
    NamedYaml {
        name: "AttendanceMonthGrid",
        body: include_str!("../openapi/schemas/AttendanceMonthGrid.yaml"),
    },
    NamedYaml {
        name: "AttendanceMonthState",
        body: include_str!("../openapi/schemas/AttendanceMonthState.yaml"),
    },
    NamedYaml {
        name: "AttendancePattern",
        body: include_str!("../openapi/schemas/AttendancePattern.yaml"),
    },
    NamedYaml {
        name: "AttendancePatternInput",
        body: include_str!("../openapi/schemas/AttendancePatternInput.yaml"),
    },
    NamedYaml {
        name: "AttendancePatternKind",
        body: include_str!("../openapi/schemas/AttendancePatternKind.yaml"),
    },
    NamedYaml {
        name: "AttendancePatternList",
        body: include_str!("../openapi/schemas/AttendancePatternList.yaml"),
    },
    NamedYaml {
        name: "AttendancePersonMonth",
        body: include_str!("../openapi/schemas/AttendancePersonMonth.yaml"),
    },
    NamedYaml {
        name: "AttendancePlan",
        body: include_str!("../openapi/schemas/AttendancePlan.yaml"),
    },
    NamedYaml {
        name: "AttendancePreviewInput",
        body: include_str!("../openapi/schemas/AttendancePreviewInput.yaml"),
    },
    NamedYaml {
        name: "AttendancePublicHoliday",
        body: include_str!("../openapi/schemas/AttendancePublicHoliday.yaml"),
    },
    NamedYaml {
        name: "AttendanceReasonInput",
        body: include_str!("../openapi/schemas/AttendanceReasonInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceRecognition",
        body: include_str!("../openapi/schemas/AttendanceRecognition.yaml"),
    },
    NamedYaml {
        name: "AttendanceRefusal",
        body: include_str!("../openapi/schemas/AttendanceRefusal.yaml"),
    },
    NamedYaml {
        name: "AttendanceRotationSlot",
        body: include_str!("../openapi/schemas/AttendanceRotationSlot.yaml"),
    },
    NamedYaml {
        name: "AttendanceSaveInput",
        body: include_str!("../openapi/schemas/AttendanceSaveInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceSavePreview",
        body: include_str!("../openapi/schemas/AttendanceSavePreview.yaml"),
    },
    NamedYaml {
        name: "AttendanceSaveReceipt",
        body: include_str!("../openapi/schemas/AttendanceSaveReceipt.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleAssignInput",
        body: include_str!("../openapi/schemas/AttendanceScheduleAssignInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleAssignReceipt",
        body: include_str!("../openapi/schemas/AttendanceScheduleAssignReceipt.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleCalendar",
        body: include_str!("../openapi/schemas/AttendanceScheduleCalendar.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleDay",
        body: include_str!("../openapi/schemas/AttendanceScheduleDay.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleKept",
        body: include_str!("../openapi/schemas/AttendanceScheduleKept.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleLayer",
        body: include_str!("../openapi/schemas/AttendanceScheduleLayer.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleLayerList",
        body: include_str!("../openapi/schemas/AttendanceScheduleLayerList.yaml"),
    },
    NamedYaml {
        name: "AttendanceSchedulePreview",
        body: include_str!("../openapi/schemas/AttendanceSchedulePreview.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleTarget",
        body: include_str!("../openapi/schemas/AttendanceScheduleTarget.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleTree",
        body: include_str!("../openapi/schemas/AttendanceScheduleTree.yaml"),
    },
    NamedYaml {
        name: "AttendanceScheduleTreeNode",
        body: include_str!("../openapi/schemas/AttendanceScheduleTreeNode.yaml"),
    },
    NamedYaml {
        name: "AttendanceScopeKind",
        body: include_str!("../openapi/schemas/AttendanceScopeKind.yaml"),
    },
    NamedYaml {
        name: "AttendanceShift",
        body: include_str!("../openapi/schemas/AttendanceShift.yaml"),
    },
    NamedYaml {
        name: "AttendanceStackEntry",
        body: include_str!("../openapi/schemas/AttendanceStackEntry.yaml"),
    },
    NamedYaml {
        name: "AttendanceSubstitution",
        body: include_str!("../openapi/schemas/AttendanceSubstitution.yaml"),
    },
    NamedYaml {
        name: "AttendanceSubstitutionCandidate",
        body: include_str!("../openapi/schemas/AttendanceSubstitutionCandidate.yaml"),
    },
    NamedYaml {
        name: "AttendanceSubstitutionCandidatePage",
        body: include_str!("../openapi/schemas/AttendanceSubstitutionCandidatePage.yaml"),
    },
    NamedYaml {
        name: "AttendanceSubstitutionPage",
        body: include_str!("../openapi/schemas/AttendanceSubstitutionPage.yaml"),
    },
    NamedYaml {
        name: "AttendanceVoidInput",
        body: include_str!("../openapi/schemas/AttendanceVoidInput.yaml"),
    },
    NamedYaml {
        name: "AttendanceWeek52AckRequest",
        body: include_str!("../openapi/schemas/AttendanceWeek52AckRequest.yaml"),
    },
    NamedYaml {
        name: "AttendanceWeek52Board",
        body: include_str!("../openapi/schemas/AttendanceWeek52Board.yaml"),
    },
    NamedYaml {
        name: "AttendanceWeek52Row",
        body: include_str!("../openapi/schemas/AttendanceWeek52Row.yaml"),
    },
    NamedYaml {
        name: "AttendanceWindow",
        body: include_str!("../openapi/schemas/AttendanceWindow.yaml"),
    },
    NamedYaml {
        name: "CancelAttendanceSubstitutionRequest",
        body: include_str!("../openapi/schemas/CancelAttendanceSubstitutionRequest.yaml"),
    },
    NamedYaml {
        name: "OwnAttendanceException",
        body: include_str!("../openapi/schemas/OwnAttendanceException.yaml"),
    },
    NamedYaml {
        name: "OwnAttendanceExceptionPage",
        body: include_str!("../openapi/schemas/OwnAttendanceExceptionPage.yaml"),
    },
    NamedYaml {
        name: "OwnAttendanceExceptionResolution",
        body: include_str!("../openapi/schemas/OwnAttendanceExceptionResolution.yaml"),
    },
    NamedYaml {
        name: "OwnAttendanceWeek52",
        body: include_str!("../openapi/schemas/OwnAttendanceWeek52.yaml"),
    },
    NamedYaml {
        name: "OwnAttendanceWeek52Response",
        body: include_str!("../openapi/schemas/OwnAttendanceWeek52Response.yaml"),
    },
    NamedYaml {
        name: "RaiseAttendanceExceptionRequest",
        body: include_str!("../openapi/schemas/RaiseAttendanceExceptionRequest.yaml"),
    },
    NamedYaml {
        name: "ResolveAttendanceExceptionRequest",
        body: include_str!("../openapi/schemas/ResolveAttendanceExceptionRequest.yaml"),
    },
];
