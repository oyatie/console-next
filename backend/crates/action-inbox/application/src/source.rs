//! Registered action-inbox source identifiers.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionInboxSource {
    Workflow,
    Dispatch,
    Support,
    WorkOrder,
    Payroll,
    Governance,
    // Pre-registered lane sources (PREREG-1); each composition arm starts as
    // an empty-page stub that its lane fills.
    OrgChange,
    HrExit,
    HrLifecycle,
    HrRequests,
    HrRegister,
    HrInsurance,
}

impl ActionInboxSource {
    pub const ALL: [Self; 12] = [
        Self::Workflow,
        Self::Dispatch,
        Self::Support,
        Self::WorkOrder,
        Self::Payroll,
        Self::Governance,
        Self::OrgChange,
        Self::HrExit,
        Self::HrLifecycle,
        Self::HrRequests,
        Self::HrRegister,
        Self::HrInsurance,
    ];
}
