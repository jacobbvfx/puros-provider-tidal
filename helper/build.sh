#!/bin/zsh

set -euo pipefail

PROVIDER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_BIN="${PROVIDER_DIR}/.venv/bin/python"
HELPER_SCRIPT="${PROVIDER_DIR}/helper/tidalapi_helper.py"
DIST_DIR="${PROVIDER_DIR}/helper/dist"
WORK_DIR="${PROVIDER_DIR}/helper/work"
SPEC_DIR="${WORK_DIR}"
export PYINSTALLER_CONFIG_DIR="${WORK_DIR}/pyinstaller-config"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Missing ${PYTHON_BIN}. Run: helper/setup-python.sh" >&2
  exit 1
fi

if [[ ! -f "${HELPER_SCRIPT}" ]]; then
  echo "Missing helper script: ${HELPER_SCRIPT}" >&2
  exit 1
fi

rm -rf "${DIST_DIR}" "${WORK_DIR}"
mkdir -p "${DIST_DIR}" "${WORK_DIR}" "${SPEC_DIR}" "${PYINSTALLER_CONFIG_DIR}"

"${PYTHON_BIN}" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name tidalapi_helper \
  --distpath "${DIST_DIR}" \
  --workpath "${WORK_DIR}" \
  --specpath "${SPEC_DIR}" \
  "${HELPER_SCRIPT}"

# The pinned, self-contained LGPL ffmpeg (no Homebrew/PATH binary), with its
# license and build record, so the package runs on a Mac without Homebrew.
node "${PUROS_PROVIDER_CLI:?Run through puros-provider build (or npm run build)}" ffmpeg "--install=${DIST_DIR}" >/dev/null
if ! "${DIST_DIR}/ffmpeg" -version >/dev/null 2>&1; then
  echo "Installed ffmpeg cannot start: ${DIST_DIR}/ffmpeg" >&2
  exit 1
fi
