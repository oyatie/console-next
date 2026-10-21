//! Directory: employee list, detail, org chart, export, creation and the
//! first home-branch assignment (moved from `app/src/hr.rs`, R2-people).
//! PEOPLE-B owns `read_*`.

pub mod access_log;
pub mod audit;
pub mod create;
pub mod create_checks;
pub mod create_core;
pub mod create_duplicates;
pub mod create_exception;
pub mod create_facts;
pub mod create_guard;
pub mod create_onboard;
pub mod create_placement;
pub mod create_rehire;
pub mod create_rehire_input;
mod create_types;
pub mod home_branch;
pub mod normalize;
pub mod read_detail;
pub mod read_export;
pub mod read_export_register;
pub mod read_facets;
pub mod read_filters;
pub mod read_from;
pub mod read_list;
pub mod read_org_chart;
pub mod read_sort;
mod read_warnings;
pub mod register_review;
pub mod types;
