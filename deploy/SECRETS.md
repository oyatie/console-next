# Deployment secrets

Keep secret values outside this repository. Production provisioning and custody are
maintained in the private console-infra repository; its runbook is authoritative.

API and worker processes with `DATABASE_URL` also require
`PLATFORM_FORCE_COMMAND_DATABASE_URL`, using the dedicated
`console_platform_force_cmd` login and a distinct password. Workers use it to run
approved tenant erasures after the cooling period; a missing value fails startup.

Set `CONSOLE_COLDSTART_OTP` to a fresh one-time secret, or leave it unset to disable
cold-start sign-in. Never use the published development value in a deployment.
Set `CONSOLE_OTP_HMAC_KEY` to a 32-byte key (base64 or 64-char hex) for keyed
HMAC-SHA256 hashing of bootstrap OTPs (required for `api` in non-development
builds); `CONSOLE_OTP_HMAC_KEY_PREV` is optionally accepted during key rotation.
Keep `CONSOLE_COOKIE_SECURE` enabled for HTTPS deployments.
