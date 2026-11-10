// SPDX-License-Identifier: LicenseRef-Proprietary
use console_attendance_application as app;
use console_platform_db::DbError;

#[derive(Debug, thiserror::Error)]
pub enum AttendanceStoreError {
    #[error(transparent)]
    Schedule(#[from] crate::ScheduleStoreError),
    #[error(transparent)]
    Application(#[from] app::AttendanceApplicationError),
    #[error(transparent)]
    Database(#[from] DbError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    #[error("conflict")]
    Conflict,
    #[error("weekly policy read unavailable")]
    WeeklyPolicyUnavailable,
    #[error("close check source unavailable")]
    CloseSourceUnavailable(#[source] sqlx::Error),
    #[error("close is blocked")]
    CloseBlocked,
    #[error("invalid close month")]
    InvalidCloseMonth,
}
