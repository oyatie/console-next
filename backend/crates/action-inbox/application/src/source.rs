//! Registered action-inbox source identifiers.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionInboxSource {
    Workflow,
    Dispatch,
    Support,
    WorkOrder,
    Payroll,
    Governance,
    EntityCorrections,
    RegistrationChecks,
    // Pre-registered lane sources (PREREG-1); each composition arm starts as
    // an empty-page stub that its lane fills.
    OrgChange,
    HrExit,
    HrLifecycle,
    HrRequests,
    HrRegister,
    HrInsurance,
    HrIdentity,
    /// N-1 source identifier; current composition emits HrUnplaced.
    HrBranch,
    HrUnplaced,
    HrContract,
    PeriodUnlock,
    Setup,
    GrantNotice,
    SupportAccess,
}

impl ActionInboxSource {
    pub const ALL: [Self; 21] = [
        Self::Workflow,
        Self::Dispatch,
        Self::Support,
        Self::WorkOrder,
        Self::Payroll,
        Self::Governance,
        Self::EntityCorrections,
        Self::RegistrationChecks,
        Self::OrgChange,
        Self::HrExit,
        Self::HrLifecycle,
        Self::HrRequests,
        Self::HrRegister,
        Self::HrInsurance,
        Self::HrIdentity,
        Self::HrUnplaced,
        Self::HrContract,
        Self::PeriodUnlock,
        Self::Setup,
        Self::GrantNotice,
        Self::SupportAccess,
    ];
}
