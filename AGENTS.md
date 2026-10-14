# Working on this MCP

Use a private clone or worktree for each agent's edits and tests. Keep the user's configured checkout as the stable runnable copy; do not edit it concurrently from multiple agents. After independent review, advance that checkout to the exact approved commit under the user's authorized update scope. Do not add automatic push, publication, deployment or update hooks.

Run `npm ci --ignore-scripts`, `npm test` and `npm run check` in the private candidate. Tests use synthetic fixtures: do not log in, change live agent settings or start/stop real agents as part of validation. Preserve the MIT license and upstream API source revision references; keep test fixtures independently authored.

Keep human-session caches, environment secrets, local Codex settings and machine/account identifiers outside version control. Never copy an agent's runtime or authentication configuration into this repository. Give reviewers an exact commit/tree and bounded changed paths before proposing promotion or publication.
