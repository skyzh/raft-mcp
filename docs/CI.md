# Continuous integration

CI is prepared but **inactive**. The workflow template is
[`ci/github-actions/ci.yml`](../ci/github-actions/ci.yml), outside the
[workflow directory GitHub watches](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
Keep it there while the repository is private to avoid private Actions usage.
Adding this template does not run GitHub Actions.

## What it will check

Once activated, CI runs on pull requests targeting `main` and pushes to `main`.
It checks Node.js 22 and 24 on Ubuntu 24.04; both satisfy the package's
`engines.node` requirement of `>=22` and are supported release lines in the
[Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
Each matrix job has a ten-minute limit. A new run cancels an older run for the
same workflow and ref.

The steps install the committed lockfile with `npm ci --ignore-scripts`, run
`npm run check`, and run `npm test`. The current 31 tests use synthetic fixtures,
including MCP handshake and stdio discovery. They require no Raft credentials,
live Raft server or real agent changes. CI does not run the login or serve commands.

The template grants only `contents: read`, does not persist checkout credentials,
uses the ordinary `pull_request` event, and disables automatic package-manager
caching. It requests no repository secrets, publishing credentials, release or
deployment permissions. Its actions are pinned to complete commit IDs:

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)
- [actions/setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)

The actions' Node.js runtime is separate from the Node.js version under test.
GitHub-hosted runners supply the action runtime; this template does not target
self-hosted runners. Review upstream release notes and pins before activation.

## Run the checks locally

From the repository root, using Node.js 22 or 24:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Passing local checks does not prove that the hosted workflow runs successfully.
Hosted execution, runner setup and the complete Node 22/24 matrix remain deferred
until the repository is public and activation is approved.

## Activate later, after the repository is public

1. Confirm with the repository owner that the repository is public and CI
   activation and hosted testing are authorized. This document does not authorize
   changing repository visibility.
2. In a fresh private working copy, update from the current `main` and create a
   separate activation branch. Check the current engines, action pins and workflow
   syntax. Confirm no secrets or live Raft calls have been added.
3. Move the template to the active path:

   ```sh
   mkdir -p .github/workflows
   git mv ci/github-actions/ci.yml .github/workflows/ci.yml
   ```

   Remove its inactive-template comment and update this document to identify the
   active workflow. Retain the public-repository job guard; it is a second check,
   not a substitute for keeping the file inactive while private.
4. Submit the activation change as a PR. Opening or updating that PR can start
   the first hosted test run because it now contains an active workflow. Check
   both Node jobs and their logs; report failures instead of claiming CI is ready.
5. After review and successful checks, squash-merge the PR. Confirm the subsequent
   `main` run succeeds before treating hosted CI as verified.

Until then, do not copy this file into `.github/workflows`, dispatch Actions,
or add an active workflow merely to validate this template.
