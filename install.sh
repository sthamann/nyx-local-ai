#!/usr/bin/env bash
#
# Nyx — Local AI: one-line installer (macOS / Linux)
#
#   curl -fsSL https://raw.githubusercontent.com/sthamann/nyx-local-ai/main/install.sh | bash
#
# Options (append after `bash -s --`):
#   --editor=cursor|code|all   Install only into Cursor, only VS Code, or both (default: all detected)
#   --version=vX.Y.Z           Install a specific release instead of the latest
#   --vsix=<path>              Install a local .vsix (skips download)
#   --from-source              Clone + build instead of downloading a release
#
# Environment:
#   NYX_REPO   GitHub repo slug (default: sthamann/nyx-local-ai)
#
set -euo pipefail

REPO="${NYX_REPO:-sthamann/nyx-local-ai}"
VERSION="latest"
VSIX_PATH=""
EDITOR_CHOICE="all"
FROM_SOURCE=0
EXT_ID="local.nyx-local-ai"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  \033[36m›\033[0m %s\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --editor=*)  EDITOR_CHOICE="${arg#*=}" ;;
    --version=*) VERSION="${arg#*=}" ;;
    --vsix=*)    VSIX_PATH="${arg#*=}" ;;
    --from-source) FROM_SOURCE=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) warn "Unknown option: $arg (ignored)" ;;
  esac
done

bold "Nyx — Local AI installer"

# ---- 1. Find editor CLIs -----------------------------------------------------

find_cli() {
  # $1 = command name, remaining args = well-known absolute fallbacks
  local name="$1"; shift
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"; return 0
  fi
  local candidate
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"; return 0
    fi
  done
  return 1
}

CURSOR_CLI="$(find_cli cursor \
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  "/usr/share/cursor/resources/app/bin/cursor" || true)"
CODE_CLI="$(find_cli code \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "/usr/share/code/bin/code" || true)"

TARGETS=()
case "$EDITOR_CHOICE" in
  cursor) [ -n "$CURSOR_CLI" ] && TARGETS+=("cursor|$CURSOR_CLI|$HOME/.cursor/extensions") ;;
  code)   [ -n "$CODE_CLI" ]   && TARGETS+=("code|$CODE_CLI|$HOME/.vscode/extensions") ;;
  all)
    [ -n "$CURSOR_CLI" ] && TARGETS+=("cursor|$CURSOR_CLI|$HOME/.cursor/extensions")
    [ -n "$CODE_CLI" ]   && TARGETS+=("code|$CODE_CLI|$HOME/.vscode/extensions")
    ;;
  *) fail "--editor must be cursor, code, or all" ;;
esac
[ "${#TARGETS[@]}" -gt 0 ] || fail "No editor CLI found. Install Cursor or VS Code first (or add their 'cursor'/'code' CLI to PATH)."

for t in "${TARGETS[@]}"; do
  ok "Found ${t%%|*}: $(echo "$t" | cut -d'|' -f2)"
done

# ---- 2. Obtain the .vsix -----------------------------------------------------

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

build_from_source() {
  command -v git  >/dev/null 2>&1 || fail "git is required for --from-source"
  command -v node >/dev/null 2>&1 || fail "Node.js >= 18 is required for --from-source"
  command -v npm  >/dev/null 2>&1 || fail "npm is required for --from-source"
  info "Cloning https://github.com/$REPO …"
  git clone --depth 1 "https://github.com/$REPO.git" "$TMP_DIR/src" >/dev/null 2>&1 \
    || fail "Clone failed — is the repository public?"
  info "Building the extension (npm install + package)…"
  ( cd "$TMP_DIR/src" && npm install --no-fund --no-audit >/dev/null && npm run package >/dev/null )
  VSIX_PATH="$(ls "$TMP_DIR"/src/nyx-local-ai-*.vsix | head -1)"
  [ -n "$VSIX_PATH" ] || fail "Build produced no .vsix"
}

download_release() {
  local url checksums
  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/$REPO/releases/latest/download/nyx-local-ai.vsix"
    checksums="https://github.com/$REPO/releases/latest/download/checksums.txt"
  else
    url="https://github.com/$REPO/releases/download/$VERSION/nyx-local-ai.vsix"
    checksums="https://github.com/$REPO/releases/download/$VERSION/checksums.txt"
  fi
  info "Downloading $url …"
  if ! curl -fsSL -o "$TMP_DIR/nyx-local-ai.vsix" "$url"; then
    warn "No release found — falling back to building from source."
    build_from_source
    return
  fi
  # Verify the SHA-256 checksum when the release publishes one (best effort).
  if curl -fsSL -o "$TMP_DIR/checksums.txt" "$checksums" 2>/dev/null; then
    local expected actual
    expected="$(grep 'nyx-local-ai.vsix' "$TMP_DIR/checksums.txt" | awk '{print $1}' | head -1)"
    if [ -n "$expected" ]; then
      if command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$TMP_DIR/nyx-local-ai.vsix" | awk '{print $1}')"
      else
        actual="$(sha256sum "$TMP_DIR/nyx-local-ai.vsix" | awk '{print $1}')"
      fi
      [ "$expected" = "$actual" ] || fail "Checksum mismatch! expected $expected, got $actual"
      ok "Checksum verified (sha256: ${actual:0:16}…)"
    fi
  fi
  VSIX_PATH="$TMP_DIR/nyx-local-ai.vsix"
}

if [ -n "$VSIX_PATH" ]; then
  [ -f "$VSIX_PATH" ] || fail "No such file: $VSIX_PATH"
  ok "Using local package: $VSIX_PATH"
elif [ "$FROM_SOURCE" = "1" ]; then
  build_from_source
else
  download_release
fi

# ---- 3. Install ----------------------------------------------------------------
# Note: no manual cleanup of old version folders — deleting them corrupts the
# editor's extensions.json registry ("Please restart before reinstalling").
# `--install-extension --force` upgrades in place and retires old versions itself.

for t in "${TARGETS[@]}"; do
  name="${t%%|*}"
  cli="$(echo "$t" | cut -d'|' -f2)"

  info "Installing into $name …"
  if ! output="$("$cli" --install-extension "$VSIX_PATH" --force 2>&1)"; then
    printf '%s\n' "$output" | sed 's/^/    /'
    fail "'$cli --install-extension' failed (see output above)"
  fi
  ok "Installed into $name ($EXT_ID)"
done

# ---- 4. Done ------------------------------------------------------------------

echo
bold "Done! Next steps:"
info "1. Reload your editor window (Cmd/Ctrl+Shift+P → 'Developer: Reload Window')."
info "2. Open the Nyx icon in the Activity Bar (or press Cmd/Ctrl+Alt+N)."
info "3. Have a local model ready, e.g.:  ollama pull qwen2.5-coder:32b"
if ! command -v ollama >/dev/null 2>&1 && ! curl -fsS -m 1 http://localhost:11434/api/tags >/dev/null 2>&1; then
  warn "No local Ollama detected — install it from https://ollama.com or add your own machine (DGX, vLLM, LM Studio) in Nyx's ⚙ Manage models."
fi
