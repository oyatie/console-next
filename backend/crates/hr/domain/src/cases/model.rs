//! The closed item-kind vocabulary (§3 column keys). The `kind` CHECK on
//! `case_template_items` / `lifecycle_case_items` lists the same set, and the
//! Cedar item actions are one per kind.

use console_kernel_core::KernelError;

/// What an item is: DOC document · FIL filing · NOT notice · PAY payment ·
/// BACK hand-back · ACC account action · REC register/record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ItemKind {
    Doc,
    Fil,
    Not,
    Pay,
    Back,
    Acc,
    Rec,
}

impl ItemKind {
    pub const ALL: [Self; 7] = [
        Self::Doc,
        Self::Fil,
        Self::Not,
        Self::Pay,
        Self::Back,
        Self::Acc,
        Self::Rec,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Doc => "DOC",
            Self::Fil => "FIL",
            Self::Not => "NOT",
            Self::Pay => "PAY",
            Self::Back => "BACK",
            Self::Acc => "ACC",
            Self::Rec => "REC",
        }
    }

    /// # Errors
    /// Validation `lifecycle_item_kind_unknown` for anything outside the set.
    pub fn parse(value: &str) -> Result<Self, KernelError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| KernelError::validation("lifecycle_item_kind_unknown"))
    }
}

#[cfg(test)]
mod tests {
    use super::ItemKind;

    #[test]
    fn every_kind_round_trips_and_nothing_else_parses() {
        for kind in ItemKind::ALL {
            assert_eq!(ItemKind::parse(kind.as_str()).unwrap(), kind);
        }
        for odd in ["", "doc", "FILING", "XYZ"] {
            assert!(ItemKind::parse(odd).is_err(), "{odd}");
        }
    }
}
