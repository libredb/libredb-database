# Standalone binaries

Every LibreDB release attaches **self-contained executables** of the `libredb`
CLI to its [GitHub Release](https://github.com/libredb/libredb-database/releases).
They embed the Bun runtime, so they run with **no Node, no Bun, and no `npm install`**
— just download one file and run it.

The binary is the exact same CLI documented in [`CLI.md`](./CLI.md); this page only
covers getting and running it.

---

## Download

Each release ships one executable per platform, plus a `.sha256` checksum file:

| Platform | Asset |
| --- | --- |
| Linux x64 | `libredb-linux-x64` |
| Linux arm64 | `libredb-linux-arm64` |
| macOS Intel (x64) | `libredb-darwin-x64` |
| macOS Apple Silicon (arm64) | `libredb-darwin-arm64` |
| Windows x64 | `libredb-windows-x64.exe` |

Grab the one for your platform from the
[latest release](https://github.com/libredb/libredb-database/releases/latest)
(web UI, or with the GitHub CLI):

```sh
gh release download --repo libredb/libredb-database \
  --pattern 'libredb-linux-x64*'        # the binary and its .sha256
```

## Verify the checksum

```sh
sha256sum -c libredb-linux-x64.sha256    # Linux
shasum -a 256 -c libredb-linux-x64.sha256  # macOS
# expected output: libredb-linux-x64: OK
```

## Make it executable and run

```sh
chmod +x libredb-linux-x64
mv libredb-linux-x64 /usr/local/bin/libredb   # optional: put it on PATH

libredb inspect app.libredb
libredb set app.libredb user:1 Ada
```

On macOS you may need to clear the quarantine attribute the first time
(`xattr -d com.apple.quarantine ./libredb-darwin-arm64`). On Windows, run
`libredb-windows-x64.exe` from a terminal.

---

## Usage

Identical to the CLI — see [`CLI.md`](./CLI.md) for the full command reference
(`inspect`, `stats`, `get`, `scan`, `set`, `delete`, `import`), the safety model,
and exit codes. For example:

```sh
libredb stats app.libredb
libredb scan app.libredb user:
```

---

## Build one locally

If you have Bun, you can compile the CLI yourself:

```sh
bun run compile           # produces ./libredb for your current platform
./libredb --help
```

To cross-compile for another target, use Bun directly:

```sh
bun build --compile --target=bun-linux-arm64 src/cli/main.ts --outfile libredb-linux-arm64
```

(`bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`,
`bun-windows-x64` are the supported targets — the same matrix the release workflow
builds.)

---

## Notes

- **Size:** each binary is ~80–90 MB because it bundles the Bun runtime. That is
  the cost of "no install / no dependencies."
- **Not on npm/JSR:** binaries are a GitHub Releases artifact only; the package
  registries ship the importable library + the `libredb` bin instead.
- **Same data files everywhere:** a `.libredb` file written by the library, the
  `npx` CLI, the binary, or the [Docker image](./DOCKER.md) is byte-identical and
  interchangeable.
- Pre-release versions (e.g. pipeline test builds) are marked as pre-releases on
  GitHub; the "Latest release" is always the current stable one.
