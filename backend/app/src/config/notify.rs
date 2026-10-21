//! Push provider configuration (FCM, Solapi Alimtalk).

use crate::config::DEFAULT_FCM_SCOPE;
use crate::config::DEFAULT_FCM_TOKEN_URI;
use crate::config::DEFAULT_SOLAPI_BASE_URL;
use crate::config::parse::non_empty;
use crate::error::AppError;
use console_platform_push::{FcmConfig, SolapiConfig};
use std::collections::HashMap;

pub(crate) fn fcm_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<Option<FcmConfig>, AppError> {
    let project_id = non_empty(vars.get("CONSOLE_FCM_PROJECT_ID"));
    let client_email = non_empty(vars.get("CONSOLE_FCM_CLIENT_EMAIL"));
    let private_key_pem = non_empty(vars.get("CONSOLE_FCM_PRIVATE_KEY_PEM"));
    let configured = project_id.is_some() || client_email.is_some() || private_key_pem.is_some();
    if !configured {
        return Ok(None);
    }
    let config = FcmConfig {
        project_id: project_id.ok_or_else(|| {
            AppError::Config("CONSOLE_FCM_PROJECT_ID is required when FCM is configured".to_owned())
        })?,
        client_email: client_email.ok_or_else(|| {
            AppError::Config(
                "CONSOLE_FCM_CLIENT_EMAIL is required when FCM is configured".to_owned(),
            )
        })?,
        private_key_pem: private_key_pem.ok_or_else(|| {
            AppError::Config(
                "CONSOLE_FCM_PRIVATE_KEY_PEM is required when FCM is configured".to_owned(),
            )
        })?,
        token_uri: non_empty(vars.get("CONSOLE_FCM_TOKEN_URI"))
            .unwrap_or_else(|| DEFAULT_FCM_TOKEN_URI.to_owned()),
        scope: non_empty(vars.get("CONSOLE_FCM_SCOPE"))
            .unwrap_or_else(|| DEFAULT_FCM_SCOPE.to_owned()),
    };
    config
        .validate()
        .map_err(|err| AppError::Config(err.to_string()))?;
    Ok(Some(config))
}

pub(crate) fn solapi_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<(Option<SolapiConfig>, Option<String>), AppError> {
    let api_key = non_empty(vars.get("CONSOLE_SOLAPI_API_KEY"));
    let api_secret = non_empty(vars.get("CONSOLE_SOLAPI_API_SECRET"));
    let from = non_empty(vars.get("CONSOLE_SOLAPI_FROM"));
    let pf_id = non_empty(vars.get("CONSOLE_SOLAPI_PF_ID"));
    let template_id = non_empty(vars.get("CONSOLE_SOLAPI_TEMPLATE_ID"));
    let credentials_configured =
        api_key.is_some() || api_secret.is_some() || from.is_some() || pf_id.is_some();
    if !credentials_configured && template_id.is_none() {
        return Ok((None, None));
    }
    let Some(template_id) = template_id else {
        return Ok((
            None,
            Some(
                "Solapi Alimtalk disabled: CONSOLE_SOLAPI_TEMPLATE_ID is required after Kakao template approval"
                    .to_owned(),
            ),
        ));
    };
    let required = |value: Option<String>, name: &'static str| {
        value.ok_or_else(|| {
            AppError::Config(format!("{name} is required when Solapi is configured"))
        })
    };
    let config = SolapiConfig {
        base_url: non_empty(vars.get("CONSOLE_SOLAPI_BASE_URL"))
            .unwrap_or_else(|| DEFAULT_SOLAPI_BASE_URL.to_owned()),
        api_key: required(api_key, "CONSOLE_SOLAPI_API_KEY")?,
        api_secret: required(api_secret, "CONSOLE_SOLAPI_API_SECRET")?,
        from: required(from, "CONSOLE_SOLAPI_FROM")?,
        pf_id: required(pf_id, "CONSOLE_SOLAPI_PF_ID")?,
        template_id,
    };
    config
        .validate()
        .map_err(|err| AppError::Config(err.to_string()))?;
    Ok((Some(config), None))
}
