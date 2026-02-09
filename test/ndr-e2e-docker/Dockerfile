# Use the existing OpenClaw e2e image as base so this test can run fully offline
# (no Docker Hub access needed).
FROM openclaw-plugins-e2e:latest

RUN ( \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' /etc/apt/sources.list; \
    fi; \
  ) \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*

# Install rust toolchain (needed to compile local ndr)
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
ENV PATH=/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

WORKDIR /work

# Provided by run.sh build context
COPY nostr-double-ratchet/rust /work/nostr-double-ratchet/rust

RUN cargo install --locked --path /work/nostr-double-ratchet/rust/crates/ndr

COPY openclaw-ndr/dist /plugin/dist
COPY scripts /e2e

ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"

CMD ["bash"]
