# SPDX-License-Identifier: LicenseRef-Proprietary
# Image arguments are required and supplied only from deploy/versions.json.
ARG NODE_IMAGE
ARG RUST_IMAGE
ARG RUNTIME_IMAGE
FROM ${NODE_IMAGE} AS web
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json postcss.config.mjs ./
COPY packages ./packages
COPY apps/web ./apps/web
# The SPA bundles the public suffix list as raw text (apps/web/src/ui/external-url-host.tsx).
COPY third-party/public-suffix-list ./third-party/public-suffix-list
COPY scripts/font-subsets.mjs ./scripts/font-subsets.mjs
COPY deploy/ci/api-probe.mjs ./deploy/ci/api-probe.mjs
COPY backend/openapi/openapi.yaml ./backend/openapi/openapi.yaml
# Builds only the shipped web app; type-checking tests and e2e/ (outside this context) is CI's npm run check.
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN --network=none npm run build -w @console/web
ARG SOURCE_REVISION
RUN --network=none node deploy/ci/api-probe.mjs backend/openapi/openapi.yaml "${SOURCE_REVISION}" > /src/api-probe.json

FROM ${RUST_IMAGE} AS backend
WORKDIR /src/backend
COPY backend ./
COPY packages/i18n/src/catalogs/approval-sources.json /src/packages/i18n/src/catalogs/approval-sources.json
COPY packages/i18n/src/catalogs/payroll-reference-labels.json /src/packages/i18n/src/catalogs/payroll-reference-labels.json
COPY third-party/rust/vendor /src/third-party/rust/vendor
COPY rustfmt.toml /src/rustfmt.toml
COPY docs/specs/cedar-pbac-coexistence-map.json /src/docs/specs/
ENV SQLX_OFFLINE=true
RUN cargo build --locked --release -p console-app --bin console-app

FROM ${RUNTIME_IMAGE}
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.title="console-app" \
      com.cosskorea.console.backend.revision="${SOURCE_REVISION}" \
      com.cosskorea.console.web.revision="${SOURCE_REVISION}"
WORKDIR /app
COPY --from=backend /src/backend/target/release/console-app /app/console-app
COPY --from=web /src/apps/web/dist /app/web
COPY --from=web /src/api-probe.json /app/api-probe.json
ENV CONSOLE_WEB_DIST=/app/web CONSOLE_HTTP_ADDR=0.0.0.0:8080 RUST_BACKTRACE=1 RUST_LIB_BACKTRACE=0
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/console-app"]
