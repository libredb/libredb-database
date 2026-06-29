# syntax=docker/dockerfile:1
#
# A portable shell for the `libredb` CLI — NOT a server. LibreDB is an embedded,
# in-process database; this image just carries the inspection/edit CLI so it can
# run anywhere with a volume-mounted .libredb file. Mount your data and run a
# command, e.g.:
#
#   docker run --rm -v "$PWD:/data" ghcr.io/libredb/libredb inspect /data/app.libredb
#
# The CLI has zero runtime dependencies, so the build needs no `bun install`:
# `bun build --compile` bundles only src/ into one self-contained executable.

# Stage 1: compile the CLI for the build platform (buildx sets it per --platform,
# so the same Dockerfile cross-builds amd64 and arm64).
# Pinned by digest (the tag is mutable) for a reproducible, supply-chain-safe
# build; the tag stays for readability and tracks .bun-version (1.3.14, the same
# Bun the binaries job pins via setup-bun). Bump both the tag and the digest
# together when .bun-version changes.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /src
# bun build --compile bundles only the source it reaches; the CLI imports nothing
# outside src/, so no package.json/tsconfig and no `bun install` are needed.
COPY src ./src
RUN bun build --compile src/cli/main.ts --outfile /libredb

# Stage 2: a minimal runtime carrying only the binary and the glibc/libstdc++ a
# bun-compiled executable links against. distroless/cc has exactly that. Pinned
# by digest because `cc-debian12` is a rolling tag (no version), so the digest is
# what makes the runtime reproducible; refresh it periodically for base updates.
FROM gcr.io/distroless/cc-debian12@sha256:d703b626ba455c4e6c6fbe5f36e6f427c85d51445598d564652a2f334179f96e
COPY --from=build /libredb /usr/local/bin/libredb
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/libredb"]
