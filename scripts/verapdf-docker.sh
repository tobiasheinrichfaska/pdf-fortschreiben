#!/usr/bin/env bash
# Runs the official veraPDF CLI image on paths below the current directory (used in CI via VERAPDF=...).
# The tag is pinned in .github/workflows/tests.yml (VERAPDF_IMAGE_TAG).
set -euo pipefail
exec docker run --rm -v "$PWD:$PWD" -w "$PWD" "verapdf/cli:${VERAPDF_IMAGE_TAG:?set VERAPDF_IMAGE_TAG}" "$@"
