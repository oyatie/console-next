#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! EMP-CREATE: registration with the EMP-MODEL facts, on a `console_rt` pool
//! (the 0256 grants and RLS are what is proved), and its pure rules.

mod dates;
mod fixture;
mod minimum;
mod register;
mod register_inbox;
mod rules;
mod void;
mod void_governed;
