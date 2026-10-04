#!/bin/bash
# pm2 entry for shapecast-forge: secrets are sourced at exec, never frozen into pm2's dump.
set -a; source "$HOME/.env.shared"; set +a
export FORGE_PUBLIC_URL="https://im4tlai-dev.tail2efc28.ts.net/forge"
export FORGE_PORT=3420
export FORGE_COMFY_URL="http://10.0.0.24:8188"
exec node "$(dirname "$0")/../dist/server.js"
