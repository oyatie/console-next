//! Stable refusal codes of the schedule store (ko/en catalog entries in the
//! console); each one is asserted by a test.

pub const CREW_MEMBERS_INVALID: &str = "crew_members_invalid";
pub const CREW_MEMBERSHIP_OVERLAP: &str = "crew_membership_overlap";
pub const CREW_NAME_INVALID: &str = "crew_name_invalid";
pub const CREW_NAME_TAKEN: &str = "crew_name_taken";
pub const CREW_NOT_FOUND: &str = "crew_not_found";
pub const EMPLOYEE_NOT_IN_WORKPLACE: &str = "employee_not_in_workplace";
pub const HOLIDAY_MONTH_CLOSED: &str = "holiday_month_closed";
pub const HOLIDAY_NOT_FOUND: &str = "holiday_not_found";
pub const HOLIDAY_RETIRE_YEAR_INVALID: &str = "holiday_retire_year_invalid";
pub const HOLIDAY_RULE_INVALID: &str = "holiday_rule_invalid";
pub const IDEMPOTENCY_KEY_INVALID: &str = "idempotency_key_invalid";
pub const IDEMPOTENCY_KEY_REUSED: &str = "idempotency_key_reused";
pub const LAYER_ALREADY_CANCELLED: &str = "layer_already_cancelled";
pub const LAYER_NOT_FOUND: &str = "layer_not_found";
pub const MONTH_INVALID: &str = "month_invalid";
pub const PATTERN_INPUT_INVALID: &str = "pattern_input_invalid";
pub const PATTERN_NAME_TAKEN: &str = "pattern_name_taken";
pub const PATTERN_NOT_FOUND: &str = "pattern_not_found";
pub const REASON_INVALID: &str = "reason_invalid";
pub const REASON_REQUIRED: &str = "reason_required";
pub const SCOPE_NOT_FOUND: &str = "scope_not_found";
pub const TARGETS_INVALID: &str = "targets_invalid";
pub const BATCH_ALREADY_UNDONE: &str = "batch_already_undone";
pub const BATCH_MONTH_CLOSED: &str = "batch_month_closed";
pub const BATCH_NOT_FOUND: &str = "batch_not_found";
pub const BATCH_TOO_LARGE: &str = "batch_too_large";
pub const ENTRY_CONFLICT: &str = "entry_conflict";
pub const ENTRY_MONTH_CLOSED: &str = "entry_month_closed";
pub const ENTRY_NOT_FOUND: &str = "entry_not_found";
pub const ENTRY_SUPERSEDED: &str = "entry_superseded";
pub const EVIDENCE_CONFIRMER_REQUIRED: &str = "evidence_confirmer_required";
pub const NOT_ON_ROSTER: &str = "not_on_roster";
pub const NOTHING_TO_SAVE: &str = "nothing_to_save";
pub const OWN_ROW: &str = "own_row";
