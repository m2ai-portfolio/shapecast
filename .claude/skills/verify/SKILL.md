---
name: verify
description: Verify ShapeCast changes at their runtime surface. Forge connector (HTTP/OAuth/MCP) and the artifact pages.
---

# Verify ShapeCast

## Forge connector (forge/)
Runs under pm2 as `shapecast-forge` on 127.0.0.1:3420, public at
`https://im4tlai-dev.tail2efc28.ts.net/forge` (Tailscale Funnel 443, prefix stripped).
claude.ai only reaches port 443.

Rebuild and restart (sanitized env, secrets come from the wrapper):
```bash
(cd forge && npx tsc -p tsconfig.json)
env -i HOME=$HOME USER=$USER PATH=$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin bash -c "pm2 restart shapecast-forge && pm2 save"
```

Public surface (what claude.ai sees): 401 + `resource_metadata` on `POST /forge/mcp`,
`/forge/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/forge`,
`/forge/authorize?...client_id=https://claude.ai/oauth/mcp-oauth-client-metadata...` renders the
passphrase form with an absolute `action`.

Full sign-in + every tool, locally, passphrase sourced not printed:
```bash
bash -c "set -a; source ~/.env.shared; set +a; node forge/verify/drive-forge.mjs"
```

Logs: `~/.pm2/logs/shapecast-forge-out.log` (one line per request; failed MCP calls add the
JSON-RPC method and protocol header), `-error.log`.

Gotchas:
- Do not send 5 wrong passphrases to the live server: it locks the real sign-in for 15 minutes.
- Artifact pages (probe/, index.html) run inside claude.ai's cross-origin frame. Chrome-extension
  clicks into that frame are unreliable; test page logic in a local harness with a stub
  `window.claude` (Playwright via the CCOS Bunker loopback `127.0.0.1:3399`), then have Matthew click
  through the real frame once.
- claude.ai's connector proxy caps a reply at 16 MB and adds 1-16 s latency per call.
