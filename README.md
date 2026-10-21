# Console

Source of the Console HR and organisation platform: a React web client (`apps/`, `packages/`, `e2e/`) and a
Rust backend (`backend/`).

**This repository is source-available, not open source.** All rights are reserved; no licence is granted
(see [LICENSE](LICENSE) and [NOTICE](NOTICE)). It is public so that it can be read and so that its checks run
in the open. Outside contributions are not accepted. Report security issues privately: [SECURITY.md](SECURITY.md).

## Layout

| Path | What |
|---|---|
| `apps/web` | the web client (Vite, React) |
| `apps/desktop` | the Windows desktop shell (Tauri) |
| `packages/*` | shared API client, i18n catalogs, design tokens |
| `e2e/` | browser tests (Playwright) |
| `backend/` | the Rust workspace: `app/` (the server binary), `crates/` (domains), `openapi/` |
| `third-party/` | vendored, modified third-party crates under their own licences |

## Checks

```sh
npm ci && npm run check
(cd backend && cargo fmt --check && cargo clippy --workspace --all-targets --locked -- -D warnings)
```

`npm run check` covers the web client: the API contract against `backend/openapi`, types, lint, unit tests, the
build, a secret scan of the history, licence headers and fixture identifiers. `.github/workflows/ci.yml` runs
these steps on pushes to `dev` and on pull requests while GitHub Actions is enabled for the repository.
The backend's database tests and the browser end-to-end
suite need a Postgres topology this repository does not carry yet.
