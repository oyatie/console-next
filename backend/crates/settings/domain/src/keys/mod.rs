//! The key roster. Every tenant policy value in the product is one variant
//! here, declared once with its wire key and definition, so a referenced key
//! that does not exist is a compile error (backend proposal §3.2).
//!
//! Sources: `decisions.md` Appendix A (the `approval.doc_class.{…}` row is two
//! keys), the #10 retention table (17 classes) plus the entity
//! registration document (ENT-CAPTURE), and
//! `exit.settlement.wage_deviation_pct` (BW-09; missing from App. A).
//! The frontend catalog labels each key by its wire string (`settings.ts`).
//!
//! One file per lane (`keys/<lane>.rs`), each an append-only list of
//! one-line keys wrapped in a `macro_rules!` named after the file. A lane
//! copies the two wrapper lines of `found.rs`; INTEG adds its `mod` line and
//! its name to the `roster!` call below. List order is `SettingKey::ALL`
//! order, so a new lane goes last.

use crate::citations::{
    BASIC_NATIONAL_TAX_ACT_85_3, COMMERCIAL_ACT_383, COMMERCIAL_ACT_393, HEALTH_INSURANCE_ACT_96_4,
    INCOME_TAX_ACT_128, LABOR_STANDARDS_DECREE_22, NIST_800_63B_4, PIPA_26_2,
    SAFETY_MEASURES_NOTICE_4, SAFETY_MEASURES_NOTICE_5, SAFETY_MEASURES_NOTICE_8,
    STANDARD_PRIVACY_GUIDELINE_10,
};
use crate::definition::{Governance, LooserWhen::*, SettingDef as D, Unit::*};
use serde::Serialize;

/// A stored or requested key string that names no registered key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownKey(pub String);

impl std::fmt::Display for UnknownKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown setting key: {}", self.0)
    }
}

impl std::error::Error for UnknownKey {}

macro_rules! setting_keys {
    ($($variant:ident => $key:literal = $def:expr;)+) => {
        /// A registered setting key. Wire strings never change once shipped.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        pub enum SettingKey {
            $(#[serde(rename = $key)] $variant,)+
        }

        impl SettingKey {
            /// Every key, in declaration order.
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $key,)+ }
            }

            #[must_use]
            pub const fn def(self) -> D {
                match self { $(Self::$variant => $def,)+ }
            }
        }

        impl std::str::FromStr for SettingKey {
            type Err = UnknownKey;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($key => Ok(Self::$variant),)+
                    _ => Err(UnknownKey(value.to_owned())),
                }
            }
        }
    };
}

/// Exit access revocation modes, strictest first.
pub const REVOKE_MODES: &[&str] = &["ON_CONFIRM", "END_OF_EXIT_DATE"];
/// Sole-holder handling, strictest first.
pub const SOLE_HOLDER_MODES: &[&str] = &["refuse", "step_up_notice_review"];
/// 결재 policy of a change class (decisions #26), strictest first.
pub const APPROVAL_POLICIES: &[&str] = &["route", "none"];
/// 원천징수 신고 주기 (소득세법 §128). A fact; no order.
pub const FILING_CADENCES: &[&str] = &["MONTHLY", "SEMIANNUAL"];
/// A row without 사번 at import (decisions #25), strictest first.
pub const UNNUMBERED_MODES: &[&str] = &["queue", "assign_by_rule"];

const fn retention_years(years: i64) -> D {
    D::int(Years, Some(years), None, years, Lower)
}

/// Folds every lane's list into one `setting_keys!` call, in list order.
macro_rules! roster {
    ([$($acc:tt)*]) => { setting_keys! { $($acc)* } };
    ([$($acc:tt)*] $lane:ident $(, $rest:ident)*) => { $lane! { [$($acc)*] $($rest),* } };
}

#[macro_use]
mod found;
#[macro_use]
mod pa_ent;
#[macro_use]
mod ent_capture;
// --- lane: EMP-RECORD ---
#[macro_use]
pub mod emp_record;
#[macro_use]
mod people_a;
#[macro_use]
mod d26;
// --- lane: IMPORT-2 ---
#[macro_use]
mod import2;
// --- lane: BE-MIG ---
#[macro_use]
mod mig;
// --- lane: PERF-BE ---
#[macro_use]
mod perf;
#[macro_use]
mod attendance;

#[macro_use]
mod ops_recovery;

#[macro_use]
mod display;
#[macro_use]
mod support;

#[macro_use]
mod nts;
#[macro_use]
mod orgchange;

#[macro_use]
mod privacy_reveal;
#[macro_use]
mod access_log_review;
#[macro_use]
mod privacy_rights;

roster!([] found, pa_ent, ent_capture, emp_record, people_a, d26, import2, mig, perf, attendance, ops_recovery, display, support, nts, orgchange, privacy_reveal, access_log_review, privacy_rights);
