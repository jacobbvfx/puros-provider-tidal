#!/bin/zsh
set -euo pipefail

HELPER_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="$(cd "${HELPER_DIR}/.." && pwd)/.venv/bin/python"
# A source checkout with its virtual environment runs the script directly; packages ship only dist/.
if [[ -f "${HELPER_DIR}/tidalapi_helper.py" && -x "${PYTHON_BIN}" ]]; then
  exec "${PYTHON_BIN}" "${HELPER_DIR}/tidalapi_helper.py" "$@"
fi
if [[ -x "${HELPER_DIR}/dist/tidalapi_helper" ]]; then
  exec "${HELPER_DIR}/dist/tidalapi_helper" "$@"
fi
if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Tidal development helper is unavailable; run helper/setup-python.sh first." >&2
  exit 1
fi
exec "${PYTHON_BIN}" "${HELPER_DIR}/tidalapi_helper.py" "$@"
