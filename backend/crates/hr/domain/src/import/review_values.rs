//! IMPORT-2: the value-mapping kinds of the 확인 필요 queue.

/// One kind of value-mapping item.
#[derive(Clone, Copy)]
pub(super) struct ValueMap {
    pub(super) reason: &'static str,
    pub(super) blocking: bool,
    pub(super) decision: &'static str,
    pub(super) field: &'static str,
    pub(super) choices: &'static [&'static str],
}

pub(super) const STATUS: ValueMap = ValueMap {
    reason: "status_unmapped",
    blocking: true,
    decision: "status_map",
    field: "employment_status",
    choices: &super::normalize::STATUS_CODES,
};
pub(super) const LEAVE: ValueMap = ValueMap {
    reason: "leave_type_unmapped",
    blocking: true,
    decision: "leave_type_map",
    field: "leave_type",
    choices: &crate::lifecycle::leave_facts::LEAVE_TYPES,
};
pub(super) const UNIT: ValueMap = ValueMap {
    reason: "unit_unmapped",
    blocking: false,
    decision: "unit_map",
    field: "org_unit",
    choices: &[],
};
pub(super) const WORKPLACE: ValueMap = ValueMap {
    reason: "workplace_unmapped",
    blocking: false,
    decision: "workplace_map",
    field: "workplace",
    choices: &[],
};
/// W02: blocking. An unanswered label kept apply open and 300 people came
/// in with no 고용형태; `null` (leave it empty) is an answer.
pub(super) const EMPLOYMENT_TYPE: ValueMap = ValueMap {
    reason: "employment_type_unmapped",
    blocking: true,
    decision: "employment_type_map",
    field: "employment_type",
    choices: &[],
};
