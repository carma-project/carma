# Connect your agents (Claude Desktop & Cursor)

Phase A of going live: point your day-to-day harnesses at CARMA so every session
**wakes** with the right context and **captures** its reasoning back into memory.
Both Claude Desktop and Cursor are MCP hosts, so this is configuration — no custom
integration. CARMA exposes the MCP Streamable HTTP transport at `POST /mcp`; a
session authenticates with a capability token and gets these tools:

- `wake` — reload the agent's durable identity + recent decisions (+ precedent for a
  task) at session start. With `MCP_WAKE_INSTRUCTIONS=true` (default) the brief also
  rides along automatically on the MCP `initialize` response, so the agent reloads
  its self on connect even without calling the tool.
- `search_memory` — precedent recall (similarity × outcome × recency).
- `store_trace` — write a decision/reasoning trace (needs `write`).
- `record_outcome` — record how a decision turned out (needs `write`).
- `retract_memory` — retract a superseded/incorrect memory (needs `write`).

## 1. Reach CARMA privately

CARMA has no public listener (see [`EXPOSURE.md`](EXPOSURE.md)). Your desktop reaches
it over the Zero-Trust tunnel/tailnet, so the base URL your client uses is the tunnel
hostname, e.g. `https://carma.example.ts.net` (Tailscale) or a Cloudflare Access
hostname. Substitute that for `<CARMA_URL>` below.

## 2. Mint a capability token

Agents that both recall and write need `read,write`. Mint a medium-TTL, least-privilege
token (from a host holding `PRIVATE_KEY`, or via `POST /capability`):

```sh
TOKEN=$(npm run --silent mint-token -- --domains trust://cyberorbit --actions read,write --ttl 24h --sub my-laptop)
```

Treat it like a credential and rotate on your chosen cadence. (For a hands-off setup,
have the Access edge inject the token as the `Authorization` header instead — see
[`EXPOSURE.md`](EXPOSURE.md#tokens-for-external-mcp-harnesses).)

## 3. Cursor

Cursor speaks remote MCP over HTTP with headers. Add CARMA to `~/.cursor/mcp.json`
(global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "carma": {
      "url": "<CARMA_URL>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

Reload Cursor; confirm `carma` shows its tools (`wake`, `search_memory`, `store_trace`,
`record_outcome`, `retract_memory`) under Settings → MCP.

## 4. Claude Desktop

Claude Desktop's config file launches MCP servers as local processes, so bridge the
remote HTTP transport with the `mcp-remote` shim. Edit `claude_desktop_config.json`
(Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "carma": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "<CARMA_URL>/mcp",
        "--header",
        "Authorization: Bearer <TOKEN>"
      ]
    }
  }
}
```

Restart Claude Desktop; `carma` appears in the tools menu. (Newer Claude Desktop builds
can also add a remote MCP server via Settings → Connectors using `<CARMA_URL>/mcp` + a
bearer token, which avoids the shim.)

## 5. Use it in a session

- **Start of session** — the `initialize` instructions carry the wake brief
  automatically. To also pull task-specific precedent, prompt the agent to
  `wake` with the task (e.g. *"wake for: Q3 SOC2 evidence review"*), or just ask a
  question — `search_memory` returns ranked precedent.
- **During/after work** — have the agent `store_trace` the decision + reasoning at end
  of turn/session, and `record_outcome` once a result is known. This is what turns
  live sessions into durable corpus (and fixes the "blank issues / lost traces"
  problem). A short standing instruction in the agent's rules works well, e.g.:

  > At the end of a meaningful decision, call `store_trace` with the task, the
  > reasoning, and the decision. When you learn how a past decision turned out, call
  > `record_outcome`.

## 6. Verify capture

After a session, confirm the trace landed:

```sh
curl -s "<CARMA_URL>/search?q=<something%20you%20decided>&k=5&domain=cyberorbit" \
  -H "Authorization: Bearer $TOKEN"
```

You should see the decision come back with its reasoning and (once recorded) outcome.
From there the normal loop applies: `dream` consolidates, `wake` re-surfaces it next
session, and `distill` can post-train on it (see [`GO_LIVE.md`](GO_LIVE.md)).
