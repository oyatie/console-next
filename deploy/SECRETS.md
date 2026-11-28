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

Set the API secret `CONSOLE_RECOVERY_CONTACT_KEYRING` to an independent JSON keyring
for encrypting recovery addresses. Retain its previous keys during rotation so
registered contacts remain usable across restarts and deployments. On preview and
production hosts, provision the API environment or its
`CONSOLE_RECOVERY_CONTACT_KEYRING_FILE` through console-infra before updating
the image. A release API with authentication configured checks the key at startup.
The Kubernetes template sources the `CONSOLE_RECOVERY_CONTACT_KEYRING` property of
the environment's `api` external secret and mounts its file into the API pod.

Provide identical `CONSOLE_RRN_KEYRING`, `CONSOLE_RRN_HMAC_KEYRING`, and
`CONSOLE_MAIL_KEYRING` JSON keyrings (`{"active":"...","keys":{...}}`) to both
`api` and `worker` so API writes and worker re-sealing/backfill share the same
master KEKs and HMAC roots. When external audit-chain custody uses a private CA,
supply `CONSOLE_AUDIT_CHAIN_CUSTODY_CA_FILE` alongside `CONSOLE_AUDIT_CHAIN_CUSTODY_URL` (`https://`).
