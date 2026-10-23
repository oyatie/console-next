// SPDX-License-Identifier: LicenseRef-Proprietary
/// Blockers found by a preflight. Empty means the command may be submitted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preflight {
    blockers: Vec<String>,
    code: Option<&'static str>,
}

impl Preflight {
    /// No blockers.
    #[must_use]
    pub const fn ok() -> Self {
        Self {
            blockers: Vec::new(),
            code: None,
        }
    }

    /// Blocked, for the given reasons.
    #[must_use]
    pub fn blocked(blockers: Vec<String>) -> Self {
        Self {
            blockers,
            code: None,
        }
    }

    /// A stable, machine-readable refusal while retaining the remedy text.
    #[must_use]
    pub fn with_code(mut self, code: &'static str) -> Self {
        self.code = Some(code);
        self
    }

    #[must_use]
    pub const fn code(&self) -> Option<&'static str> {
        self.code
    }

    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.blockers.is_empty()
    }

    #[must_use]
    pub fn blockers(&self) -> &[String] {
        &self.blockers
    }
}
