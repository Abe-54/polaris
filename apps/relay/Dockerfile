# The Polaris Relay. Build from the repository root:
#   docker build -f apps/relay/Dockerfile -t polaris-relay .
# The image tag is the toolchain; keep it in step with rust-toolchain.toml.
FROM rust:1.99.1-bookworm AS build
WORKDIR /src
COPY apps/relay .
RUN cargo build --release --locked -p polaris-relay

FROM debian:bookworm-slim
# The push service is reached over TLS, verified against the system's certificates.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/polaris-relay /usr/local/bin/polaris-relay
ENV PORT=8080
EXPOSE 8080
USER nobody
CMD ["polaris-relay"]
