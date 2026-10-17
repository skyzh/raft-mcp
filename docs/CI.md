# Continuous integration

The workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), in the
[workflow directory GitHub watches](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
The workflow runs only when the repository is public. Opening a pull request
with this workflow starts hosted testing; preparing the local change alone does
not. Verify both hosted matrix jobs before claiming hosted CI works.

## What it checks

CI runs on pull requests targeting `main` and pushes to `main`.
It checks Node.js 22 and 24 on Ubuntu 24.04; both satisfy the package's
`engines.node` requirement of `>=22` and are supported release lines in the
[Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
Each matrix job has a ten-minute limit. A new run cancels an older run for the
same workflow and ref.

The steps install the committed lockfile with `npm ci --ignore-scripts`, then run
`npm run format:check`, `npm run lint`, `npm run check`, and `npm test`. The current
31 tests use synthetic fixtures, including MCP handshake and stdio discovery.
They require no Raft credentials, live Raft server or real agent changes. Tests
may launch the local CLI/stdio server and exercise login against synthetic
fixtures; they do not authenticate to a real Raft account, contact a production
Raft server or change real agents.

The workflow grants only `contents: read`, does not persist checkout credentials,
uses the ordinary `pull_request` event, and disables automatic package-manager
caching. It requests no repository secrets, publishing credentials, release or
deployment permissions. Its actions are pinned to complete commit IDs:

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)
- [actions/setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)

The actions' Node.js runtime is separate from the Node.js version under test.
GitHub-hosted runners supply the action runtime; this workflow does not target
self-hosted runners. Review upstream release notes and pins before updating them.

## Run the checks locally

From the repository root, using Node.js 22.13 or newer in the 22.x line, or
Node.js 24 or newer (the pinned ESLint requirement):

```sh
npm ci --ignore-scripts
npm run format:check
npm run lint
npm run check
npm test
```

## Formatting and linting

The pinned development tools have separate jobs: [Prettier](https://prettier.io/docs/install.html)
formats the JavaScript files, while [ESLint](https://eslint.org/docs/latest/use/getting-started)
checks its recommended correctness rules with Node.js built-in globals. The
formatter does not rewrite Markdown, image assets or JSON fixtures. No stylistic
ESLint rules overlap with Prettier, and no recommended lint rules are disabled.

Run `npm run format` to write formatting changes, then `npm run format:check`
and `npm run lint` to verify them. CI uses only the check commands. Exact direct
dev-dependency versions and the committed lockfile make installation reproducible.
ESLint requires Node.js `^20.19.0 || ^22.13.0 || >=24`. The CI jobs resolve Node.js
22.x and 24.x and may use a matching cached patch. Record the actual Node.js
version from each job. The application's runtime requirement remains `>=22`.

## Verify hosted results

Local validation used Node.js 25.8.0. It does not prove that the hosted Node.js
22/24 jobs or Ubuntu runner setup work. No hosted activation run had executed
when this change was prepared. Use the [CI runs](https://github.com/skyzh/raft-mcp/actions/workflows/ci.yml)
and the activation PR's checks for current results.

For the exact PR commit, confirm that **both** `Node 22` and `Node 24` jobs actually
execute locked installation, formatting and lint checks, syntax checks and all
31 synthetic fixture tests.
A skipped or cancelled job does not count as tested. Record the run URL, commit
and each job's conclusion; investigate a concrete failure before changing the
workflow or rerunning it.

After independent review and successful PR checks, squash-merge the PR and check
that the subsequent `main` run also executes both jobs successfully. Branch
results alone do not establish the merged commit's result.

The public-repository job guard is retained. Private, internal or missing
visibility skips the jobs. Making the repository private again therefore needs
a deliberate decision about whether to revise the guard and pay for private CI.
CI never needs Raft account secrets or real agent actions.
