#!/bin/zsh

set -euo pipefail

# Creates the provider's .venv with the pinned helper dependencies and PyInstaller.
PROVIDER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3.13}"

if ! command -v "${PYTHON}" >/dev/null 2>&1; then
  echo "Missing ${PYTHON}. Install Python 3.13 (for example 'brew install python@3.13') or set PYTHON." >&2
  exit 1
fi

"${PYTHON}" -m venv "${PROVIDER_DIR}/.venv"
"${PROVIDER_DIR}/.venv/bin/python" -m pip install --quiet --upgrade pip
"${PROVIDER_DIR}/.venv/bin/python" -m pip install --quiet --requirement "${PROVIDER_DIR}/helper/requirements.txt"
echo "Tidal helper environment ready: ${PROVIDER_DIR}/.venv"
