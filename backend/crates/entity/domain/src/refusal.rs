//! Refusals and field-level issues (ADR-005/010: stable codes, field pointers).

use console_kernel_core::{ErrorKind, KernelError};
use serde::Serialize;

/// One field-level problem: `field` is the request-body path (`representatives[1]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldIssue {
    pub field: String,
    pub code: &'static str,
}

/// A soft signal returned with a successful save (never blocks).
pub type Warning = FieldIssue;

/// Why a command was refused: a stable code, optional field issues, and the
/// remedy the UI should offer (R3: no refusal without a way forward).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub kind: ErrorKind,
    pub code: &'static str,
    pub message: String,
    pub fields: Vec<FieldIssue>,
    pub remedy: Option<&'static str>,
    /// On `stale_revision`: the version the record is at now (INTEG-2).
    pub current_version: Option<i32>,
}

impl Refusal {
    #[must_use]
    pub fn new(kind: ErrorKind, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            code,
            message: message.into(),
            fields: Vec::new(),
            remedy: None,
            current_version: None,
        }
    }

    #[must_use]
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Conflict, code, message)
    }

    #[must_use]
    pub fn not_found(code: &'static str) -> Self {
        Self::new(ErrorKind::NotFound, code, code)
    }

    #[must_use]
    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, code, message)
    }

    /// 422 naming one field.
    #[must_use]
    pub fn field(field: impl Into<String>, code: &'static str) -> Self {
        Self::fields(vec![FieldIssue {
            field: field.into(),
            code,
        }])
    }

    #[must_use]
    pub fn fields(fields: Vec<FieldIssue>) -> Self {
        Self {
            kind: ErrorKind::Validation,
            code: "validation_failed",
            message: "one or more fields are invalid".to_owned(),
            fields,
            remedy: None,
            current_version: None,
        }
    }

    #[must_use]
    pub fn with_remedy(mut self, remedy: &'static str) -> Self {
        self.remedy = Some(remedy);
        self
    }

    /// 409 `stale_revision`: someone revised the record after the client read
    /// `expected`; `current` is where it is now.
    #[must_use]
    pub fn stale_revision(expected: i32, current: i32) -> Self {
        let mut refusal = Self::conflict(
            "stale_revision",
            format!("the record changed since version {expected}; it is at version {current}"),
        )
        .with_remedy("reload_and_reapply");
        refusal.current_version = Some(current);
        refusal
    }
}

impl From<KernelError> for Refusal {
    fn from(err: KernelError) -> Self {
        let code = err.code.unwrap_or(match err.kind {
            ErrorKind::Validation => "validation_failed",
            ErrorKind::NotFound => "not_found",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::Conflict | ErrorKind::InvalidTransition => "conflict",
            ErrorKind::Unavailable => "unavailable",
            ErrorKind::Internal => "internal",
        });
        let mut refusal = Self::new(err.kind, code, err.message);
        if let Some(field) = err.field {
            refusal.fields.push(FieldIssue { field, code });
        }
        refusal
    }
}

pub const REQUIRED: &str = "required";
pub const TOO_LONG: &str = "too_long";
/// A server revision marker (`SystemReason`) sent as a person's `reason_code` (0h).
pub const REASON_CODE_RESERVED: &str = "reason_code_reserved";
pub const INVALID_OPTION: &str = "invalid_option";
pub const NOT_APPLICABLE: &str = "not_applicable";
pub const DATE_INVALID: &str = "date_invalid";
pub const DATE_IN_FUTURE: &str = "date_in_future";
pub const OUT_OF_RANGE: &str = "out_of_range";

/// Collects every issue of one input before refusing (inline validation shows
/// them all at once, not one round trip per field).
#[derive(Debug, Default)]
pub struct Issues(Vec<FieldIssue>);

impl Issues {
    pub fn push(&mut self, field: impl Into<String>, code: &'static str) {
        self.0.push(FieldIssue {
            field: field.into(),
            code,
        });
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn count(&self) -> usize {
        self.0.len()
    }

    /// Trimmed text; `None` when blank. Refuses blank-when-required and over-long.
    pub fn text(
        &mut self,
        field: &str,
        raw: Option<&str>,
        max: usize,
        required: bool,
    ) -> Option<String> {
        let value = raw.map(str::trim).filter(|v| !v.is_empty());
        match value {
            None if required => {
                self.push(field, REQUIRED);
                None
            }
            Some(v) if v.chars().count() > max => {
                self.push(field, TOO_LONG);
                None
            }
            other => other.map(str::to_owned),
        }
    }

    /// A newtype parsed from text; the newtype's own code on failure.
    pub fn parsed<T>(
        &mut self,
        field: &str,
        raw: Option<&str>,
        required: bool,
        parse: impl FnOnce(&str) -> Result<T, KernelError>,
    ) -> Option<T> {
        match raw.map(str::trim).filter(|v| !v.is_empty()) {
            None => {
                if required {
                    self.push(field, REQUIRED);
                }
                None
            }
            Some(v) => match parse(v) {
                Ok(value) => Some(value),
                Err(err) => {
                    self.push(field, err.code.unwrap_or(INVALID_OPTION));
                    None
                }
            },
        }
    }

    /// A code-list value (enum) parsed from its wire code.
    pub fn choice<E>(
        &mut self,
        field: &str,
        raw: Option<&str>,
        required: bool,
        parse: impl FnOnce(&str) -> Option<E>,
    ) -> Option<E> {
        match raw.map(str::trim).filter(|v| !v.is_empty()) {
            None => {
                if required {
                    self.push(field, REQUIRED);
                }
                None
            }
            Some(v) => {
                let parsed = parse(v);
                if parsed.is_none() {
                    self.push(field, INVALID_OPTION);
                }
                parsed
            }
        }
    }

    /// An ISO `YYYY-MM-DD` date; optionally refused when after `latest`.
    pub fn date(
        &mut self,
        field: &str,
        raw: Option<&str>,
        required: bool,
        latest: Option<time::Date>,
    ) -> Option<time::Date> {
        let format = time::macros::format_description!("[year]-[month]-[day]");
        let date = self.parsed(field, raw, required, |v| {
            time::Date::parse(v, &format)
                .map_err(|_| KernelError::validation(DATE_INVALID).with_code(DATE_INVALID))
        })?;
        if latest.is_some_and(|max| date > max) {
            self.push(field, DATE_IN_FUTURE);
            return None;
        }
        Some(date)
    }

    /// `Ok(value())` when no issue was recorded, else a 422 naming them all.
    ///
    /// # Errors
    /// The collected field issues.
    pub fn finish<T>(self, value: impl FnOnce() -> T) -> Result<T, Refusal> {
        if self.0.is_empty() {
            Ok(value())
        } else {
            Err(Refusal::fields(self.0))
        }
    }

    /// Like [`Issues::finish`], for builders that unwrap required values with
    /// `?`: with no issue recorded every required value is present, so `None`
    /// would be a validation bug and is reported as one, never as a 422.
    ///
    /// # Errors
    /// The collected field issues, or `validation_inconsistent`.
    pub fn finish_opt<T>(self, value: impl FnOnce() -> Option<T>) -> Result<T, Refusal> {
        if !self.0.is_empty() {
            return Err(Refusal::fields(self.0));
        }
        value().ok_or_else(|| {
            Refusal::new(
                ErrorKind::Internal,
                "validation_inconsistent",
                "a required value passed validation but is missing",
            )
        })
    }

    #[must_use]
    pub fn into_vec(self) -> Vec<FieldIssue> {
        self.0
    }
}

/// Wire code enums: one declaration gives the type, its codes, `parse`,
/// `as_str`, `ALL` (for OpenAPI and the FE option lists) and serde.
#[macro_export]
macro_rules! code_enum {
    ($(#[$m:meta])* $name:ident { $($(#[$vm:meta])* $variant:ident => $code:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $($(#[$vm])* #[serde(rename = $code)] $variant),+
        }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $code),+ }
            }
            #[must_use]
            pub fn parse(raw: &str) -> Option<Self> {
                match raw.trim() { $($code => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}
