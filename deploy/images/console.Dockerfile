# SPDX-License-Identifier: LicenseRef-Proprietary
# Image arguments are required and supplied only from deploy/versions.json.
ARG NODE_IMAGE
ARG RUST_IMAGE
ARG RUNTIME_IMAGE
FROM ${NODE_IMAGE} AS web
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run build

FROM ${RUST_IMAGE} AS backend
WORKDIR /src/backend
COPY backend ./
COPY third-party/rust/vendor /src/third-party/rust/vendor
COPY rustfmt.toml /src/rustfmt.toml
COPY docs/specs/cedar-pbac-coexistence-map.json /src/docs/specs/
ENV SQLX_OFFLINE=true
RUN cargo build --locked --release -p console-app --bin console-app

FROM ${RUNTIME_IMAGE}
WORKDIR /app
COPY --from=backend /src/backend/target/release/console-app /app/console-app
COPY --from=web /src/apps/web/dist /app/web
ENV CONSOLE_WEB_DIST=/app/web CONSOLE_HTTP_ADDR=0.0.0.0:8080
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/console-app"]
