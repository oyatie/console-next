//! MR-33 company sections: 어학, 포상, 징계, 가족. Not named by 별지 제16호;
//! kept because the 인사카드 is expected to hold them (decisions #21), each
//! behind its own tenant switch (개인정보 보호법 §16①).

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;

use super::fields::ordered;
use super::guard::{optional_text, required_text};
use super::{code_enum, iso_date};

code_enum!(FamilyRelation {
    Spouse => "SPOUSE",
    Child => "CHILD",
    Parent => "PARENT",
    ParentInLaw => "PARENT_IN_LAW",
    Sibling => "SIBLING",
    Grandparent => "GRANDPARENT",
    Grandchild => "GRANDCHILD",
    Other => "OTHER",
});

/// 어학. `language` is an ISO 639 code (`en`, `ja`, `zh`, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Language {
    pub language: String,
    #[serde(default)]
    pub test: Option<String>,
    #[serde(default)]
    pub score: Option<String>,
    #[serde(default, with = "iso_date::option")]
    pub taken_on: Option<Date>,
    #[serde(default, with = "iso_date::option")]
    pub expires_on: Option<Date>,
}

/// 포상.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Award {
    pub title: String,
    #[serde(with = "iso_date")]
    pub decided_on: Date,
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
}

/// 징계. `title` is the 징계 종류 as the 취업규칙 names it (견책, 감급, 정직 …);
/// `ends_on` closes a 기간 (정직·감급). A restricted section: reads are
/// purpose-coded and audited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Discipline {
    pub title: String,
    #[serde(with = "iso_date")]
    pub decided_on: Date,
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default, with = "iso_date::option")]
    pub ends_on: Option<Date>,
}

/// 가족. A family member is a data subject too: relation, name, birth date
/// and 동거 only; never a 주민등록번호 (§24조의2) and no 부양 flag (payroll).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Family {
    pub relation: FamilyRelation,
    pub name: String,
    #[serde(default, with = "iso_date::option")]
    pub birth_date: Option<Date>,
    #[serde(default)]
    pub cohabiting: Option<bool>,
}

impl Language {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        let language = self.language.trim().to_ascii_lowercase();
        if !(2..=3).contains(&language.len()) || !language.bytes().all(|b| b.is_ascii_lowercase()) {
            return Err(KernelError::validation(
                "language must be an ISO 639 code of 2 or 3 letters",
            ));
        }
        let v = Self {
            language,
            test: optional_text(self.test, 100, "test")?,
            score: optional_text(self.score, 30, "score")?,
            ..self
        };
        ordered(
            v.taken_on,
            v.expires_on,
            "expires_on must not be before taken_on",
        )?;
        Ok(v)
    }
}

impl Award {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        Ok(Self {
            title: required_text(self.title, 100, "title")?,
            issuer: optional_text(self.issuer, 100, "issuer")?,
            details: optional_text(self.details, 500, "details")?,
            ..self
        })
    }
}

impl Discipline {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        let v = Self {
            title: required_text(self.title, 100, "title")?,
            issuer: optional_text(self.issuer, 100, "issuer")?,
            details: optional_text(self.details, 500, "details")?,
            ..self
        };
        ordered(
            Some(v.decided_on),
            v.ends_on,
            "ends_on must not be before decided_on",
        )?;
        Ok(v)
    }
}

impl Family {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        Ok(Self {
            name: required_text(self.name, 50, "name")?,
            ..self
        })
    }
}
