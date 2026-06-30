# Docker image

LibreDB publishes a small, **multi-arch** Docker image of the `libredb` CLI. It is
a **portable CLI shell, not a server**: LibreDB stays an embedded, in-process
database, and the image simply carries the inspection/edit tool so you can run it
anywhere with your data volume-mounted. There is no daemon, no port, nothing
listening.

The container runs the exact same CLI documented in [`CLI.md`](./CLI.md); this page
covers pulling, running, and the container specifics.

---

## Where it lives

The same image is pushed to two registries (use whichever you prefer):

| Registry | Reference |
| --- | --- |
| GitHub Container Registry | `ghcr.io/libredb/libredb` |
| Docker Hub | `libredb/libredb` |

Tags: the release version (e.g. `0.1.3`) and `latest`. Architectures:
`linux/amd64` and `linux/arm64` (Docker pulls the right one automatically).

```sh
docker pull ghcr.io/libredb/libredb:latest
# or a pinned version:
docker pull ghcr.io/libredb/libredb:0.1.3
# or from Docker Hub:
docker pull libredb/libredb:0.1.3
```

---

## Run it

The image's working directory is `/data` and its entrypoint is the `libredb`
binary, so you **mount your data into `/data`** and pass a CLI command + the file
path:

```sh
# inspect a file in the current directory
docker run --rm -v "$PWD:/data" ghcr.io/libredb/libredb inspect /data/app.libredb

# read a value
docker run --rm -v "$PWD:/data" ghcr.io/libredb/libredb get /data/app.libredb user:1

# write a value (the file is created in your mounted directory)
docker run --rm -v "$PWD:/data" ghcr.io/libredb/libredb set /data/app.libredb user:1 Ada
```

- `--rm` removes the container after it exits (the CLI is one-shot).
- `-v "$PWD:/data"` maps your current directory to `/data` inside the container,
  so files and any `<path>.lock` live on *your* disk, not in the container.
- Everything after the image name is passed straight to the CLI.

For a bulk import, mount the JSON file too (it's in the same `/data` mount):

```sh
docker run --rm -v "$PWD:/data" ghcr.io/libredb/libredb import /data/app.libredb /data/seed.json
```

A shell alias makes it feel native:

```sh
alias libredb='docker run --rm -v "$PWD:/data" ghcr.io/libredb/libredb'
libredb stats /data/app.libredb
```

---

## Usage

All commands, the safety model (read-only reads, advisory lock, reserved-key
guard), and exit codes are in [`CLI.md`](./CLI.md). Exit codes propagate out of the
container, so `docker run ... libredb get ...` is scriptable just like the bare CLI.

---

## Build it locally

```sh
docker build -t libredb .
docker run --rm -v "$PWD:/data" libredb inspect /data/app.libredb
```

Multi-arch build (as the release does) needs buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t libredb .
```

---

## Notes

- **It's a CLI, not a service.** Don't expect a listening database server — run a
  command, it does the work and exits. (LibreDB is embedded by design; see the
  [manifesto](../MANIFESTO.md).)
- **Minimal & shell-less.** The runtime stage is a
  [distroless](https://github.com/GoogleContainerTools/distroless) image (`cc`
  variant) — it carries the binary and the glibc/libstdc++ it links against, and
  nothing else (no shell, no package manager). The base images are pinned by
  **digest** for reproducible, supply-chain-safe builds.
- **Single-writer still applies.** The advisory `<path>.lock` lives in your mounted
  volume, so two concurrent `docker run` writes against the same file behave like
  any two writers — one wins, the other is refused. LibreDB is single-process.
- **Same files everywhere.** A `.libredb` file is byte-identical across the library,
  the `npx` CLI, the [standalone binary](./BINARY.md), and this image.
- **Permissions:** files the container writes are owned by the container's user;
  if that's a problem on Linux, add `--user "$(id -u):$(id -g)"` to the
  `docker run`.
