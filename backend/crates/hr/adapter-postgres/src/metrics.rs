//! HR request and import counters.

pub fn record_hr_read(surface: &'static str) {
    metrics::counter!("hr_core_requests_total", "surface" => surface).increment(1);
}

pub fn record_hr_import(inserted: usize, updated: usize) {
    metrics::counter!("hr_employee_import_rows_total", "outcome" => "inserted")
        .increment(inserted as u64);
    metrics::counter!("hr_employee_import_rows_total", "outcome" => "updated")
        .increment(updated as u64);
}

pub fn record_import_rollback(stage: &'static str, seconds: f64) {
    metrics::counter!("hr_data_import_runs_total", "stage" => stage).increment(1);
    metrics::histogram!("hr_data_import_run_duration_seconds", "stage" => stage).record(seconds);
}
