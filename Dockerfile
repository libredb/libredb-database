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
FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun build --compile src/cli/main.ts --outfile /libredb

# Stage 2: a minimal runtime carrying only the binary and the glibc/libstdc++ a
# bun-compiled executable links against. distroless/cc has exactly that.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /libredb /usr/local/bin/libredb
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/libredb"]
