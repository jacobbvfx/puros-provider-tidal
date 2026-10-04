# TIDAL provider for Puros

TIDAL catalog, library and lossless playback integration.

This is a provider plugin for Puros, a macOS music player. Puros itself is closed source; providers are built against the public [Provider SDK](https://github.com/purosapp/puros-provider-sdk).

## Install

1. Download `puros-provider-tidal-<version>.zip` from [Releases](../../releases).
2. In Puros open **Settings → Accounts → Install provider…** and choose the ZIP.
3. Review the permissions and warnings, then install. Updates use **Update from file…** on the installed provider.

## Build from source

Requirements:

- macOS with the Xcode command line tools
- Node.js 22.12 or newer
- cmake (`brew install cmake`), used once to build the pinned ffmpeg
- Python 3.13 (`brew install python@3.13`); run `npm run setup` once to create `.venv/` with the pinned helper dependencies from `helper/requirements.txt`.

```sh
npm install
npm run typecheck
npm test
npm run package      # builds helpers, writes release/puros-provider-tidal-<version>.zip
```

`npm run build` runs only the helper build steps from `provider.manifest.json`. `npx puros-provider --help` lists every SDK command. The first build compiles ffmpeg from source and caches it in `~/Library/Caches/puros-build`.

## Releases

GitHub Actions builds every push and pull request on macOS. Every push to `main` publishes a release `v<version>-build.<run>` with the compiled `puros-provider-tidal-<version>.zip` and its `.sha256`, so the newest build is always on the [latest release](../../releases/latest). Pushing a tag `v<version>` that matches `version` in `provider.manifest.json` publishes the versioned release `v<version>`. When the repository secret `PUROS_PROVIDER_SIGNING_KEY` holds an Ed25519 publisher key (`npx puros-provider keygen --out=<path outside the repo>`), released packages are signed with it; Puros pins that key on first install.

## License

MIT, see [LICENSE](LICENSE). The package bundles `tidalapi_helper`, a PyInstaller build of `helper/tidalapi_helper.py` and its dependencies from `helper/requirements.txt` (including tidalapi, LGPL-3.0-or-later, and tidal-dl-ng-for-dj, AGPL-3.0-only), and the SDK's pinned LGPL ffmpeg build.
