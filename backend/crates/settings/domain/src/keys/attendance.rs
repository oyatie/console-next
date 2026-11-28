//! Attendance §6 bounds; MAIN03:55 preserves S2's zero defaults.
macro_rules! attendance { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    AttendanceExcessNoticeMinutes => "attendance.excess.notice_minutes" = D::int(Minutes, Some(0), Some(30), 0, Higher).scope_ceiling(crate::definition::ScopeCeiling::Person);
    AttendanceExcessDispositionDueDays => "attendance.excess.disposition_due_days" = D::int(Days, Some(1), None, 3, Higher).scope_ceiling(crate::definition::ScopeCeiling::Person);
    AttendanceExcessRepeatWindowDays => "attendance.excess.repeat_window_days" = D::int(Days, Some(1), None, 28, Lower).scope_ceiling(crate::definition::ScopeCeiling::Person);
    AttendanceExcessRepeatCount => "attendance.excess.repeat_count" = D::int(Count, Some(1), None, 3, Higher).scope_ceiling(crate::definition::ScopeCeiling::Person);
    AttendanceLongSpanConfirmMinutes => "attendance.entry.long_span_confirm_minutes" = D::int(Minutes, Some(1), Some(1440), 16 * 60, Higher).cited(crate::citations::LABOR_STANDARDS_ACT_50_53).scope_ceiling(crate::definition::ScopeCeiling::Person);
    AttendanceLateGraceMinutes => "attendance.late.grace_minutes" = D::int(Minutes, Some(0), Some(60), 0, Higher).scope_ceiling(crate::definition::ScopeCeiling::Person);
    AttendanceWeek52WarnHours => "attendance.week52.warn_hours" = D::int(Hours, Some(40), Some(51), 48, Higher).cited(crate::citations::LABOR_STANDARDS_ACT_50_53).scope_ceiling(crate::definition::ScopeCeiling::Person);
] $($rest)* } }; }
