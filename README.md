# Raft agent control MCP

An MIT-licensed local stdio MCP for Raft agent configuration, explicit start/stop/restart, and restart/session/full-workspace reset. It runs as the human who approves login, with that human's existing Raft permissions. No live login or agent mutation was used to develop or test this package.

## Install and sign in

Requires Node.js 22 or newer and npm. From this directory:

```sh
npm ci --ignore-scripts
export RAFT_MCP_API_URL=https://api.raft.build
node src/cli.mjs login
node src/cli.mjs servers
```

The login command prints a verification URL and public approval code. Open it in your own browser, log into Raft normally, and approve this device. The command polls at the server's interval and saves a private session cache; it never prints access/refresh tokens or the private device code. The browser step is performed by you. No password or token copying is required.

Use `servers` to find the UUID of the server you want to control. For a self-hosted deployment, set `RAFT_MCP_API_URL` to its API origin. HTTPS is required except for loopback development. URL credentials, query parameters and path prefixes are rejected. Device login must be enabled on that deployment; a disabled/error response has no OAuth fallback.

## Connect an MCP client

Use a client that supports a local stdio server. A typical configuration is:

```json
{
  "mcpServers": {
    "raft-agent-control": {
      "command": "node",
      "args": ["/absolute/path/to/raft-agent-mcp/src/cli.mjs", "serve"],
      "env": {
        "RAFT_MCP_API_URL": "https://api.raft.build",
        "RAFT_MCP_SERVER_ID": "YOUR-SERVER-UUID"
      }
    }
  }
}
```

Replace the absolute path and server UUID. Stdio mode writes only MCP protocol output to stdout. Errors on stderr contain codes, never raw backend bodies or credentials.

Session cache defaults to `~/.config/raft-agent-mcp/session.json`. To separate installations/accounts, use a different `RAFT_MCP_SESSION_FILE` under a private directory for each. The directory must have mode 0700, and the file has mode 0600; symlink files/directories are refused. Do not commit, upload or paste the cache. Run login/logout with MCP processes stopped, and do not share a cache between machines. Refresh uses a process-local single-flight and a file lock; `session_busy` means another process holds it. A crashed process can leave a lock directory: stop all users of that cache before manually removing only its empty `.lock` directory.

Refresh rotates the session privately before API calls. A failed/uncertain refresh blocks further attempts rather than replaying a possibly consumed token; sign in again. To revoke this session and remove its local cache:

```sh
node src/cli.mjs logout
```

If logout fails, the cache remains and revocation is not claimed. Revoke the session in Raft's session controls if it cannot be reached. No agent/daemon credentials are reused.

## Tools and behavior

| Tool | Behavior |
| --- | --- |
| `list_servers` | Visible server IDs/names, for the signed-in human. |
| `list_agents` | Agents in the explicitly configured server; identity, model, runtime, observed state and environment key names. |
| `get_agent` | The same configuration summary for one agent ID returned by the list. No env values or provider/session secrets. |
| `plan_agent_config` | Prepare a five-minute plan for `model`, `reasoningEffort`, `fastMode`, `envSet`, `envUnset`, and explicit `applyMode`. No remote config write. |
| `commit_agent_config` | Apply that exact plan once after a fresh comparison; return persisted-field readback status. |
| `start_agent` / `stop_agent` | Explicit lifecycle action, acceptance and freshly observed state. |
| `restart_agent` | Explicit process restart, preserving workspace and runtime session. |
| `reset_agent` | Select `restart`, `session` or `full`; full mode prepares a confirmation only. |
| `confirm_full_reset` | Dangerous, separately confirmed workspace/session reset; requires MCP form elicitation. |

For example, call `plan_agent_config` with the selected `agentId`, `envSet: {"EXAMPLE_FLAG":"1"}`, `envUnset: ["OLD_FLAG"]`, and optionally `model: "your-model-id"`. Inspect its secret-free change summary, then call `commit_agent_config` with the returned `planId`. Unmentioned environment keys remain. `envUnset` deletes only named keys; to clear the entire user env map, list and unset every current key. Invalid keys, NUL values, conflicting set/unset keys and empty changes refuse. Each runtime must expose the requested fields in its current form; otherwise the adapter refuses rather than guessing.

`applyMode` defaults to `next_start`: no `restartMode` is sent. Saving a model is **not** proof that a running agent has adopted it. An explicit `restart` or `session` forwards Raft's application mode; a Codex model change with requested restart is upgraded by Raft to a session reset, which abandons its prior runtime session. Receipt `runtimeApplication` is `not_requested` or `requested_not_verified`; even successful persisted readback does not certify runtime application.

Agent configuration uses the server's protocol-v2 runtime form and preserves unrelated fields. Write-only provider secrets are omitted, so Raft retains them under its identity rules; display redactions are not written back. Saved-connection-owned fields are omitted from submissions. There are no provider/role/runtime-switch/delete/migrate or arbitrary-shell tools. Raft enforces creator/capability permissions, verified-account requirements, machine state and runtime-native validation. External agents cannot be controlled through managed lifecycle/config tools.

Plans are memory-only, expire after five minutes and are consumed before commit attempts; a failed commit must be inspected/replanned, never blindly replayed. Detected intervening edits refuse without writing. **Residual simultaneous-edit race:** upstream PATCH has no atomic compare-and-swap, so a change between the final read and PATCH can still be overwritten. Coordinate concurrent editors. A successful PATCH followed by failed readback reports saved with verification unavailable; mismatched readback reports mismatch. Neither retries the write.

Start acceptance does not prove a running process. Observed state can lag dispatch; a stop on an offline computer can apply on reconnect. Failed state reads return `observedState: null` without replaying the action. Network errors, malformed mutation responses and HTTP 5xx have unknown outcome. For a config write, the adapter attempts one readback and returns `writeOutcome: "unknown"`, `saved: null`, and observed field verification as an MCP error result. Settings can match even if a requested restart failed after persistence; matching does not prove runtime application or success of this write. Inspect state before any further operation. Authentication/permission failures and safe field-level error codes are reported without reflecting raw backend error text.

### Reset confirmation

`reset_agent(mode="restart")` preserves workspace and runtime session. `mode="session"` clears the runtime session but preserves workspace. Both request a subsequent start; a previously stopped agent may start. `restart_agent` is an explicit alias for the restart mode.

`reset_agent(mode="full")` does **not** reset anything. It returns a five-minute, single-use confirmation bound to the exact server, agent, machine and current configuration. The separate `confirm_full_reset` call requires an actual MCP client form response: type the exact agent name and check the explicit deletion confirmation. The checkbox defaults to false. Decline, cancel, unsupported clients, timeout, changed targets and expired/replayed confirmations refuse without sending a reset. A tool argument alone cannot stand in for this confirmation. Full reset requires an assigned machine.

Configure the confirmation-only tool to prompt in your Codex MCP entry:

```toml
[mcp_servers.raft_agent_control.tools.confirm_full_reset]
approval_mode = "prompt"
```

This is separate from the in-tool human confirmation. Do not disable elicitation or auto-answer it. Clients without form elicitation cannot perform full reset. [Codex MCP settings](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [client elicitation](https://learn.chatgpt.com/docs/app-server#mcp-server-elicitation-requests) describe these controls; local client availability must still be checked.

Raft acknowledges reset requests with HTTP 202 before background processing finishes. Every reset receipt says `accepted: true`, `completed: false`, and includes freshly observed state when available. This does not prove successful restart or workspace deletion. An offline computer or background failure can delay/prevent completion. The server separately enforces runtime-control/workspace-reset authority.

The cache is a normal human session, not a narrowly scoped OAuth management grant. Limit access to this local process and account. This adapter does not add a remote HTTP listener or OAuth authorization server.

## Source and license

Pinned source: [botiverse/raft-source at a98ae003246a0360872a77d76dec2fccd0347ef7](https://github.com/botiverse/raft-source/tree/a98ae003246a0360872a77d76dec2fccd0347ef7). This is a **source-available release mirror**, not an Apache-licensed release today. Its authoritative [LICENSE](https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/LICENSE) is FSL-1.1-ALv2. This adapter is an independent local integration; it does not modify or redistribute the Raft platform. This repository’s independent adapter code, documentation and newly authored synthetic test fixtures are covered by the MIT `LICENSE`. No upstream implementation or licensed fixture files are included. Raft itself retains its own license and trademarks.

Exact endpoints, references and assumptions are in `SOURCE-CONTRACT.md`. Compatibility was checked against that snapshot; deployed server behavior still requires the normal human login and separately authorized validation. No production compatibility claim is made from fixture tests alone.

## Verify locally

```sh
npm test
npm run check
```

Tests use synthetic HTTP responses and independently authored synthetic runtime-form fixtures. They include device login, refresh/logout, environment preservation/removal, config application modes, stale/expired/single-use plans, state reporting, credential-file permissions and an SDK MCP client handshake/discovery/invocation. No real login, agent changes, native builds or production API calls occur.

## Development copies

Use a private clone/worktree per agent for edits and tests. Keep the user’s configured checkout as the stable runnable copy. Advance it only to an independently reviewed, authorized commit; do not add automatic publishing or update hooks. See `AGENTS.md`. Local Codex configuration, account/server identifiers, authentication caches and private evidence are never part of the Git repository.
