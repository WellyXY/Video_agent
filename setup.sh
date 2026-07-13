#!/usr/bin/env bash
# Video Agent Studio — one-shot setup.
# Idempotent: safe to re-run. Clones OpenMontage, installs deps, injects the chat widget.
set -euo pipefail
cd "$(dirname "$0")"

STUDIO_PORT="${PORT:-4747}"

say()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 0. prerequisites ----------
say "Checking prerequisites"
command -v node    >/dev/null || fail "Node.js 18+ is required (https://nodejs.org)"
command -v python3 >/dev/null || fail "Python 3.10+ is required"
command -v ffmpeg  >/dev/null || fail "FFmpeg is required (macOS: brew install ffmpeg)"
command -v git     >/dev/null || fail "git is required"
node -e 'process.exit(parseInt(process.versions.node)>=18?0:1)' || fail "Node.js >= 18 required (found $(node -v))"
python3 -c 'import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)' || fail "Python >= 3.10 required"
if ! command -v claude >/dev/null; then
  echo "  note: 'claude' CLI not found. The Agent SDK needs Claude Code credentials"
  echo "        (npm i -g @anthropic-ai/claude-code && claude login) or ANTHROPIC_API_KEY."
fi

# ---------- 1. studio deps ----------
say "Installing studio dependencies (express + claude-agent-sdk)"
npm install --no-fund --no-audit

# ---------- 2. OpenMontage ----------
if [ ! -d OpenMontage ]; then
  say "Cloning OpenMontage"
  git clone --depth 1 https://github.com/calesthio/OpenMontage.git
else
  say "OpenMontage already present — skipping clone"
fi

# venvs hardcode absolute paths — if this repo was copied from another machine/path,
# the old venv is broken. Detect and rebuild.
if [ -d OpenMontage/.venv ] && ! OpenMontage/.venv/bin/python -c 'import sys' >/dev/null 2>&1; then
  say "Existing venv is broken (repo was moved/copied) — rebuilding"
  rm -rf OpenMontage/.venv
fi

say "Running OpenMontage setup (venv, Python deps, Remotion, Piper TTS)"
( cd OpenMontage && make setup )

# agent sessions are tied to the machine/path they were created on — reset on fresh deploys
if [ -f studio-projects.json ]; then
  say "Resetting stale agent session ids (projects & assets are kept)"
  python3 - <<'PY'
import json
try:
    r = json.load(open('studio-projects.json'))
    for p in r.get('projects', []):
        p['sessionId'] = None
    json.dump(r, open('studio-projects.json', 'w'), indent=2, ensure_ascii=False)
    print('  done')
except Exception as e:
    print('  skipped:', e)
PY
fi

say "Installing pytest (needed by Backlot's demo simulator)"
OpenMontage/.venv/bin/python -m pip install -q pytest

# ---------- 3. inject chat widget into Backlot ----------
inject() {
  local file="$1"
  local tag="<script src=\"http://localhost:${STUDIO_PORT}/chat-widget.js\" defer></script>"
  if grep -q "chat-widget.js" "$file"; then
    echo "  already injected: $file"
  else
    # insert before </body>
    python3 - "$file" "$tag" <<'PY'
import sys
path, tag = sys.argv[1], sys.argv[2]
html = open(path).read()
marker = "</body>"
assert marker in html, f"no </body> in {path}"
html = html.replace(marker, "<!-- video-agent-studio: agent chat overlay -->\n" + tag + "\n" + marker, 1)
open(path, "w").write(html)
print(f"  injected: {path}")
PY
  fi
}
say "Injecting chat widget into Backlot pages"
inject OpenMontage/backlot/ui/board.html
inject OpenMontage/backlot/ui/index.html

# ---------- 4. done ----------
say "Setup complete"
echo
echo "  API keys (optional, for commercial video models): edit OpenMontage/.env  (FAL_KEY recommended)"
echo "  Start:   npm start          (or: node server.js)"
echo "  Open:    http://localhost:4750   ← single entrance (Backlot library, ＋ 新專案 bottom-right)"
