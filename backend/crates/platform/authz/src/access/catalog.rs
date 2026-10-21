//! AX-2: the platform-fixed data-domain × level catalog (access-model §2.6).
//! The operation-key tags live in `tags.rs`.

use serde::{Deserialize, Serialize};

/// A platform data domain. Wire names are the snake-case keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Domain {
    Org,
    HrBasic,
    Appointment,
    Exit,
    Attendance,
    Pay,
    Bank,
    Evaluation,
    Discipline,
    Sensitive,
    Documents,
    Notice,
    Access,
    Audit,
    Settings,
    Exceptions,
    Retention,
    Tenant,
}

/// 조회 · 등록·수정 · 결재 · 내보내기.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    View,
    Edit,
    Approve,
    Export,
}

/// Why a role line does not fit the catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogError {
    DomainUnknown,
    DomainNotGrantable,
    LevelNotOffered,
    LevelUnknown,
    LevelsEmpty,
}

impl CatalogError {
    /// The stable wire code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::DomainUnknown => "domain_unknown",
            Self::DomainNotGrantable => "domain_not_grantable",
            Self::LevelNotOffered => "level_not_offered",
            Self::LevelUnknown => "level_unknown",
            Self::LevelsEmpty => "lines_empty",
        }
    }
}

const ALL4: &[Level] = &[Level::View, Level::Edit, Level::Approve, Level::Export];
const VIEW_EDIT_EXPORT: &[Level] = &[Level::View, Level::Edit, Level::Export];
const VIEW_EDIT_APPROVE: &[Level] = &[Level::View, Level::Edit, Level::Approve];

impl Domain {
    pub const ALL: [Self; 18] = [
        Self::Org,
        Self::HrBasic,
        Self::Appointment,
        Self::Exit,
        Self::Attendance,
        Self::Pay,
        Self::Bank,
        Self::Evaluation,
        Self::Discipline,
        Self::Sensitive,
        Self::Documents,
        Self::Notice,
        Self::Access,
        Self::Audit,
        Self::Settings,
        Self::Exceptions,
        Self::Retention,
        Self::Tenant,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Org => "org",
            Self::HrBasic => "hr_basic",
            Self::Appointment => "appointment",
            Self::Exit => "exit",
            Self::Attendance => "attendance",
            Self::Pay => "pay",
            Self::Bank => "bank",
            Self::Evaluation => "evaluation",
            Self::Discipline => "discipline",
            Self::Sensitive => "sensitive",
            Self::Documents => "documents",
            Self::Notice => "notice",
            Self::Access => "access",
            Self::Audit => "audit",
            Self::Settings => "settings",
            Self::Exceptions => "exceptions",
            Self::Retention => "retention",
            Self::Tenant => "tenant",
        }
    }

    /// # Errors
    /// `DomainUnknown` for any other string.
    pub fn parse(raw: &str) -> Result<Self, CatalogError> {
        Self::ALL
            .into_iter()
            .find(|d| d.as_str() == raw)
            .ok_or(CatalogError::DomainUnknown)
    }

    /// The levels a role line may carry for this domain, in display order.
    /// Empty = listed but not grantable (징계 until its module mounts).
    #[must_use]
    pub const fn offered(self) -> &'static [Level] {
        match self {
            Self::Org
            | Self::HrBasic
            | Self::Appointment
            | Self::Exit
            | Self::Attendance
            | Self::Pay
            | Self::Evaluation
            | Self::Documents
            | Self::Access => ALL4,
            Self::Bank | Self::Sensitive => VIEW_EDIT_EXPORT,
            Self::Notice => &[Level::View, Level::Edit],
            Self::Audit => &[Level::View, Level::Approve, Level::Export],
            Self::Settings | Self::Exceptions | Self::Retention => VIEW_EDIT_APPROVE,
            Self::Tenant => &[Level::Approve],
            Self::Discipline => &[],
        }
    }

    #[must_use]
    pub const fn grantable(self) -> bool {
        !self.offered().is_empty()
    }
}

impl Level {
    pub const ALL: [Self; 4] = [Self::View, Self::Edit, Self::Approve, Self::Export];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Edit => "edit",
            Self::Approve => "approve",
            Self::Export => "export",
        }
    }

    /// # Errors
    /// `LevelUnknown` for any other string.
    pub fn parse(raw: &str) -> Result<Self, CatalogError> {
        Self::ALL
            .into_iter()
            .find(|l| l.as_str() == raw)
            .ok_or(CatalogError::LevelUnknown)
    }
}

/// The Cedar action group of one (domain, level), e.g. `hr_basic::edit`.
#[must_use]
pub fn action_group(domain: Domain, level: Level) -> String {
    format!("{}::{}", domain.as_str(), level.as_str())
}

/// Normalize one line: every level offered by the domain, `view` added when an
/// edit/approve/export level implies it and the domain offers it, sorted and
/// de-duplicated.
///
/// # Errors
/// `DomainNotGrantable`, `LevelsEmpty` or `LevelNotOffered`.
pub fn normalize_levels(domain: Domain, levels: &[Level]) -> Result<Vec<Level>, CatalogError> {
    if !domain.grantable() {
        return Err(CatalogError::DomainNotGrantable);
    }
    if levels.is_empty() {
        return Err(CatalogError::LevelsEmpty);
    }
    let offered = domain.offered();
    if levels.iter().any(|l| !offered.contains(l)) {
        return Err(CatalogError::LevelNotOffered);
    }
    let mut out: Vec<Level> = levels.to_vec();
    if offered.contains(&Level::View) {
        out.push(Level::View);
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}
