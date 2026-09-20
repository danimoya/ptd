# ptd-db: HeliosDB-Nano from the official release, TLS with the X25519MLKEM768
# post-quantum hybrid key exchange, SCRAM-SHA-256 auth, HTTP/MCP listener off.
FROM debian:trixie-slim
ARG NANO_VERSION=4.40.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openssl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$(dpkg --print-architecture)" in amd64) T=x86_64-unknown-linux-gnu ;; arm64) T=aarch64-unknown-linux-gnu ;; *) echo "unsupported arch" >&2; exit 1 ;; esac; \
    cd /tmp; \
    B="https://github.com/Dimensigon/HDB-HeliosDB-Nano/releases/download/v${NANO_VERSION}"; \
    curl -fsSLO "$B/heliosdb-nano-v${NANO_VERSION}-${T}.tar.gz"; curl -fsSLO "$B/SHA256SUMS"; \
    grep "heliosdb-nano-v${NANO_VERSION}-${T}.tar.gz" SHA256SUMS | sha256sum -c -; \
    tar xzf "heliosdb-nano-v${NANO_VERSION}-${T}.tar.gz"; \
    install -m 0755 heliosdb-nano /usr/local/bin/heliosdb-nano; rm -rf /tmp/*
# /backups exists (and is owned by the database user) so that an empty named volume
# mounted there inherits that ownership — the backup sidecar runs as uid 999 too and
# would otherwise be handed a root-owned directory it cannot write to.
RUN useradd -r -u 999 -m -d /home/heliosdb heliosdb && mkdir -p /data /tls /backups \
    && chown heliosdb:heliosdb /data /tls /backups
COPY entrypoint.sh /usr/local/bin/ptd-db-entrypoint
RUN chmod 0755 /usr/local/bin/ptd-db-entrypoint
USER heliosdb
VOLUME ["/data", "/tls"]
EXPOSE 5432
ENTRYPOINT ["ptd-db-entrypoint"]
