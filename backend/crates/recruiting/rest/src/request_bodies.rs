use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateRecruitPostingRequest {
    pub(super) role_title: String,
    pub(super) company: String,
    pub(super) worksite: String,
    #[serde(deserialize_with = "deserialize_enum_34")]
    pub(super) employment_type: String,
    #[serde(deserialize_with = "deserialize_enum_35")]
    pub(super) scope: String,
    pub(super) headcount: i32,
    pub(super) deadline: Option<String>,
    #[serde(default)]
    pub(super) requirements: Vec<String>,
    pub(super) position_ref: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AssessRecruitApplicantRequest {
    #[serde(deserialize_with = "deserialize_enum_33")]
    pub(super) score: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RejectRecruitApplicantRequest {
    #[serde(deserialize_with = "deserialize_enum_38")]
    pub(super) reason: String,
    pub(super) note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExtendRecruitOfferRequest {
    pub(super) amount: String,
    #[serde(deserialize_with = "deserialize_enum_36")]
    pub(super) amount_period: String,
    pub(super) reply_deadline: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecordOfferReplyRequest {
    #[serde(deserialize_with = "deserialize_enum_37")]
    pub(super) decision: String,
}

fn deserialize_enum_33<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["SUITABLE", "NEUTRAL", "UNSUITABLE"],
    )
}

fn deserialize_enum_34<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["REGULAR", "RESIDENT_SHIFT", "PART_TIME", "POOL_DAILY"],
    )
}

fn deserialize_enum_35<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["INTERNAL", "EXTERNAL"],
    )
}

fn deserialize_enum_36<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(deserializer, &["MONTHLY", "DAILY"])
}

fn deserialize_enum_37<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["ACCEPTED", "DECLINED"],
    )
}

fn deserialize_enum_38<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &[
            "CAREER_SHORTFALL",
            "ROLE_MISMATCH",
            "COMP_MISMATCH",
            "ACCEPTED_ELSEWHERE",
            "OTHER",
        ],
    )
}
