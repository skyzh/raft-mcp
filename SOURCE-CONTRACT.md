# Pinned Raft API contract

Upstream: https://github.com/botiverse/raft-source/tree/a98ae003246a0360872a77d76dec2fccd0347ef7

| Endpoint / fact | Exact upstream reference |
| --- | --- |
| Human session guard and explicit `X-Server-Id` membership guard for `/api/agents` | `packages/server/src/app.ts:637`; `packages/server/src/middleware/auth.ts:128`, `:218` |
| OAuth scopes cover identity/directory/inbound, not agent management | `packages/shared/src/oauthScopes.ts:1` |
| Device login feature gate/mount | `packages/server/src/app.ts:325`; `packages/server/src/routes/deviceAuth.ts:37` |
| POST `/api/auth/device/authorize`, fields `clientName`, then `deviceCode`, `userCode`, verification URI, expires/interval | `packages/server/src/routes/deviceAuth.ts:65` |
| Browser approval is human-authenticated | `packages/server/src/routes/deviceAuth.ts:106` |
| POST `/api/auth/device/token`, private device code; pending/denied/expired/disabled; returns human access/refresh/user ID | `packages/server/src/routes/deviceAuth.ts:138` |
| POST `/api/auth/refresh`, rotating refresh; POST `/api/auth/logout`, revoke current refresh session | `packages/server/src/routes/auth.ts:1152`, `:1726` |
| GET `/api/servers` returns visible ordered servers | `packages/server/src/routes/servers.ts:744`; mount `app.ts:461` |
| GET `/api/agents`, GET `/api/agents/:id` | `packages/server/src/routes/agents.ts:1303`, `:2066` |
| GET `/api/agents/:id/runtime-form`, edit authority; protocol v2 field values; no write-only secrets | `packages/server/src/routes/agents.ts:2876`; `packages/server/src/services/runtimeFormV2Registry.ts:1708` |
| PATCH `/api/agents/:id`; human edit authority, env omission/null/replace, explicit restart; capability fences remain server-owned | `packages/server/src/routes/agents.ts:2911`, `:3003`, `:3058`, `:3237`, `:3350` |
| Protocol-v2 submit `{formDefinitionRef:{protocolVersion:2,runtimeId},formValues}` | `packages/server/src/routes/agents.ts:1206`; `packages/server/src/services/runtimeFormV2Registry.ts:1736`, `:1750` |
| `connection:` saved-provider prefix and connection-owned fields | `packages/server/src/services/runtimeFormV2Registry.ts:87`, `:114` |
| Omitted write-only secrets retained with matching runtime/provider identity | `packages/server/src/services/runtimeFormV2Registry.ts:1873` |
| POST `/api/agents/:id/start`, `{ok:true}` means accepted | `packages/server/src/routes/agents.ts:4001` |
| POST `/api/agents/:id/stop`, optional `appliesOnReconnect` | `packages/server/src/routes/agents.ts:4100` |
| POST `/api/agents/:id/reset`, explicit `mode: restart/session/full`; full requires workspace reset authority, others runtime-control; HTTP 202 precedes background completion | `packages/server/src/routes/agents.ts:4126`; mount `app.ts:637` |
| Reset action semantics (clear session/workspace, subsequent start) | `packages/server/src/services/agentOrchestrator.ts:1906`, `:13645` |
| Source-available Raft license (not redistributed here) | `LICENSE` at the same pinned revision |

Implementation uses fresh runtime-form values rather than the legacy model/env mirrors, so runtime-specific canonical mapping and validation stay in Raft. It does not send a form's schema or display values as canonical RuntimeConfig. API paths require server membership and human authority; agent API keys and OAuth identity tokens cannot substitute for the human session. The standalone CLI's default production origin matches `packages/computer/src/serverUrl.ts:1`.

No upstream conditional-update/ETag contract was found in the inspected PATCH path. The adapter compares fresh form state before PATCH and discloses the remaining race. It does not claim database transactions span the client preflight and mutation. Server-native field error codes/pointers are preserved; free-form errors are never reflected.

All adapter source, documentation and `test/fixtures/{codex,claude,builtin}.edit.json` are independently authored and MIT-licensed. Fixtures are small synthetic HTTP/form responses containing fictional values, not copies of upstream fixtures. No Raft implementation code or FSL-licensed fixture files are vendored. Upstream references document the inspected API contract, not a license change for Raft.

## Human browser login contract

Native OAuth references inspected at upstream `db5e399f017d584e49597e3a28757645d6807893`:

- `packages/server/src/routes/auth.ts:430`, `:615`, `:841`, `:891`: POST `/api/auth/mobile/oauth/start` accepts provider, login mode, return URI and PKCE challenge; POST `/api/auth/mobile/oauth/complete` exchanges code + verifier and issues a human session.
- `packages/server/src/services/socialAuthService.ts:237`, `:266`, `:499`, `:1004`: loopback return URI is `http://127.0.0.1:<port>/auth/done#state=<nonce>`, provider redirect preserves the state fragment, and provider authorization URLs use Google, GitHub or Apple.
- Production app shell `https://app.raft.build/assets/app-shell-CMt5T-_e.js` (inspected 2026-10-30) uses these endpoints for native browser login; its embedded build revision is `a721bc88aadd1e6ba01105f50dc99bcb00ef00a3`.

The reported production `403 device_session_not_allowed` is a session-class rejection, not evidence that the human account lost its administrator role. The public source snapshot predates that production guard; its exact server implementation and introduction date are not established here. Device-code login is no longer the default. Email/password sign-in uses POST `/api/auth/login` (`packages/server/src/routes/auth.ts:1244`), which issues a normal human session. This native sign-in to Raft is separate from third-party app OAuth identity scopes, which still cannot substitute for a human management session.

The production `/api/auth/app-login/start` endpoint was checked with a loopback return URI on 2026-10-30 and returned HTTP 400 `return_uri_not_allowed`, matching the fixed custom-scheme allowlist in `packages/server/src/services/appLoginService.ts:24`. Password login therefore uses a temporary loopback form and the official HTTPS login API; it does not pretend to be an official hosted login page.
