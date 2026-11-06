# 009 Pilot guard checklist

Read this before a pilot runs against a real repository, a real agent account, or a person's home directory. It records what
the DSH bundle does and does not isolate, and the checks that must pass first. It builds on [003 Execution](003-execution.md)
and [006 Deployment](006-deployment.md).

## What is not a security boundary

- `worker-bin`, `worker-gitconfig`, `blockedCommands`, and the prompt are default-path guardrails. A worker can call a program
  by absolute path, edit its own shim, or read files the operator can read.
- `danger-full-access` and the operator's OS user apply to Executor Sessions. One instance per repository is a logical
  arrangement, not filesystem isolation.
- `maxWorkers` limits worker slots, not processes, background jobs, network calls, or T3 threads.
- Issue bodies, comments, reviews, CI logs and chat messages are untrusted text. A prompt cannot stop injection.

The pilot therefore needs controls outside the prompt: a dedicated agent account and token, branch protection, manual merges,
and, where possible, a separate OS user, container or VM.

## Identity

1. The agent GitHub account is separate from the operator's. Give it its own `GH_CONFIG_DIR`, for example
   `~/.config/gh-agent`, and set the GitHub Source's **Agent gh configuration directory** to that absolute path.
2. The server that starts workers and T3 must inherit the same `GH_CONFIG_DIR`. Set it on the T3 server process, not only on
   the DSH process:
   ```sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" \
   GIT_CONFIG_GLOBAL="<stateDir>/worker-gitconfig" \
   GIT_CONFIG_NOSYSTEM=1 \
   GIT_ASKPASS= SSH_AUTH_SOCK= \
   <start T3 Code>
   ```
   Do not export `GH_TOKEN` or `GITHUB_TOKEN` to that process.
3. Run setup. It now checks the `gh` shim, not only the configured CLI: `gh api user --jq .login` through
   `<stateDir>/worker-bin/gh` must equal the resolved agent login. Setup fails with `agentIdentityMismatch` otherwise.
4. Run the doctor with the expected account and state directory:
   ```sh
   node --experimental-strip-types scripts/t3-doctor.ts --account <agent-login> --state-dir <stateDir> --gh-config-dir ~/.config/gh-agent
   ```
   The `T3 env` check reads the listening T3 process environment and fails when `GH_CONFIG_DIR` differs, a token is present,
   or `GIT_CONFIG_GLOBAL` is not the worker git configuration.
5. The agent token is fine-grained: one repository, contents and pull-request write, no administration, no organization
   secrets, no merge permission. People merge.

## Filesystem and credentials

1. Prefer a separate OS user or container/VM that mounts only the ticket worktrees and scratch space. Do not mount the home
   directory, the state directory, other projects, SSH keys, cloud credentials, browser profiles, or other instances' state.
2. If the worker must run as the operator, treat the state directory, SQLite database and shims as readable by the worker and
   say so. `chmod 700` is not isolation between processes of the same user.
3. Do not start the T3 server with the operator's `~/.config/gh`, Keychain, or SSH agent. `SSH_AUTH_SOCK` empty and
   `GIT_ASKPASS` empty are expected.

## Repository and GitHub

1. Branch protection on the target repository: no direct pushes to the default branch, no force push, required review,
   required CI. Auto-merge off for the pilot; a person merges every pull request.
2. The agent may write only the target repository. It must not approve or merge its own pull request.
3. Review every pull request diff during the pilot. Cap the size of a pilot pull request and stop work when it grows beyond
   the ticket's scope.
4. The GitHub Source must be able to read the Issue, pull request, review, and CI events the pilot relies on. Confirm a review
   comment and a failing check each arrive as one Trigger on the ticket's pull-request thread.

## T3 threads

1. Launch through T3 MCP with `workspaceStrategy: existing_worktree` and `clientRequestId = assignment.id`. The CLI cannot bind
   an existing worktree and cannot pass the idempotency key.
2. Pass an explicit runtime mode for read threads; do not rely on the project default. A read thread should not inherit
   `full-access` by accident.
3. A T3 thread reports only through a `psa-report` block with `schema_version: 1`, its `ticket_id`, its `assignment_id`, a
   unique `report_id`, and a state. The adapter blocks a malformed block or a contradictory report; it never guesses
   `progress`. A report bound to another assignment is ignored as stale.

## A T3 thread resumed by hand

The FretSense pilot exposed a real hole: the first MCP launch failed because the parent session was `approval-required`, a
person resumed the T3 thread by hand, and the thread then handled review comments and updated the pull request (PR #117,
thread `mcp:launch:97df6a1c…`, same commit, CI passing, not merged). The Ticket panel stayed `failed`, because no reply from
the failed launch ever reached dsh-superagent and no new binding was written.

Current behaviour, stated plainly:

- A failed launch is still recorded as `failed`. The Ticket does not pretend the work continued.
- T3 names a launched thread `mcp:launch:<hash>`, and a launch from this executor puts `[<ticket id>]` in the thread title.
  When a Ticket has a failed or blocked report and no stored binding, a retry (a new Assignment) or the next Input delivery
  asks `t3_thread_list` for a thread whose title contains that Ticket id. If exactly one unbound
  `mcp:launch:` thread matches, it is bound and the message goes into that thread; the next `psa-report` updates the Ticket.
- If zero or several threads match, nothing is bound. A wrong binding is worse than waiting. Keep the thread title, or rename
  the intended thread so exactly one contains `[<ticket id>]`, then retry or send a message on the Ticket's thread.
- A person's message on the Issue or pull request is the practical way to reattach a failed Ticket: the subscription delivers
  it, the adapter discovers the thread, and the worker answers from the Ticket's one-page context (Issue, PR, review, CI).
- There is no panel action that says "mark this T3 thread as this Ticket" yet. A thread that already finished before any
  message reached the Ticket stays `failed` until a retry or a new message causes discovery.
- Review and CI events on a live Ticket's own thread go straight to that Ticket, not through the main Session, so once
  reattached they are part of the same work.

## Network, audit, and stop

1. Restrict egress to GitHub, the model provider, and Feishu. Disable worker web search/fetch for the pilot or route it through
   an audited proxy.
2. Keep logs of shell commands, pushes, pull-request creation and comments, and `gh` API calls long enough to review the
   pilot.
3. Prepare a kill switch: pause processing, stop the T3 threads, revoke the agent token, and lock the state directory. Know how
   to roll back a worktree and a branch.
4. Run the whole flow first on a sandbox repository: identity, existing-worktree binding, `psa-report`, review and CI delivery,
   and the status question. Only then point it at the real repository.

## Sign-off

The pilot owner writes down the accepted risks before the first real run: same OS user, filesystem visibility, network egress,
and who merges. A green setup or doctor check does not replace that decision.
