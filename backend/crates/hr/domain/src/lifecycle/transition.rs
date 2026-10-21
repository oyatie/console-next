//! Lifecycle transition vocabulary shared by the directory and lifecycle
//! paths (moved from `app/src/hr.rs` in R2-people; R2-life moves the rest of
//! the transition rules here).

/// The events `allowed_events` evaluates: every recordable type except the
/// exits (OFFBOARD/TERMINATE go through exit cases). GROUP_TRANSFER (전적)
/// is listed by its state rule alone; whether another 법인 can receive the
/// employee is the target's question, answered when it is recorded.
pub const RECORDABLE_LIFECYCLE_EVENT_TYPES: [&str; 9] = [
    "ONBOARD",
    "TRANSFER",
    "GROUP_TRANSFER",
    "PROMOTE",
    "APPOINT",
    "EMPLOYMENT_TYPE_CHANGE",
    "LEAVE_OF_ABSENCE",
    "RETURN_FROM_LEAVE",
    "CONTRACT_RENEWAL",
];

pub fn default_lifecycle_status(event_type: &str) -> &'static str {
    match event_type {
        "OFFBOARD" | "TERMINATE" => "EXITED",
        "ONBOARD" | "TRANSFER" | "GROUP_TRANSFER" | "PROMOTE" | "RETURN_FROM_LEAVE" => "ACTIVE",
        "LEAVE_OF_ABSENCE" => "ON_LEAVE",
        // Resolved against the current status by the handler.
        "CONTRACT_RENEWAL" | "APPOINT" | "EMPLOYMENT_TYPE_CHANGE" => "",
        _ => "UNKNOWN",
    }
}
