# 010 Scheduled role agents

This document describes the first Mandate-first role instance. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md), and [003 Execution](003-execution.md).

## Role, Mandate, and executor profile

A role is deployment configuration, not a new domain object. A trusted `schedule` Source stores a `RoleSpec` and emits one immutable Trigger per local-time slot. Eval still decides whether that Trigger becomes work. On acceptance, the Ticket's Mandate records the role id, executor profile, policy rule and stop limits; those values do not come from the model.

The `executorProfiles` settings separate authorization from physical capability:

| Profile | Preset | Use |
| --- | --- | --- |
| `router` | `dsh-superagent-router` | Main Session routing |
| `builder` | `dsh-superagent-worker` | Existing read/write work line |
| `observer` | `dsh-superagent-observer` | Fixed read-only role runs |

The observer preset has no shell, jobs, write/edit tools, subagents, web tools, todo list or scheduler. `dsh-superagent` registers only `fretsense_user_sim_run`, `fretsense_user_sim_publish`, `orchestrator_read` and `orchestrator_report` on that Session.

## FretSense nightly observer

The example instance runs at 02:30 Asia/Tokyo. The Trigger id is derived from `role + slot`, so a restart does not run the same slot twice. If the machine was asleep, the latest slot may run once inside a six-hour catch-up window; outside it the Source records `missed`.

The fixed runner:

- opens the local FretSense preview at `http://127.0.0.1:4173`;
- runs cold start, Home, Notes, Intervals, Scales, Chords and Me at 1440x900;
- records console errors, page errors, failed requests, screenshots and horizontal overflow in `run.json`;
- records `git status --porcelain` before and after and aborts if the checkout changed;
- writes only under the role artifact root, never into the product checkout.

The observer may publish at most one aggregate Issue. The publication tool, not the model, renders the `<!-- whoSaid: ai-record -->` marker, coverage, evidence and the explicit “real microphone / guitar / audio accuracy was not tested” boundary. It refuses duplicate fingerprints (area, title and repro) and more than three findings.

Stop conditions are copied into the Mandate: 20 minutes, one Issue, three findings, or no new finding. Reaching any one ends the run.

## Agent identity and morning review

The publication wrapper uses the RoleSpec's `GH_CONFIG_DIR`, removes inherited `GH_TOKEN` and `GITHUB_TOKEN`, and checks that `gh api user` is exactly `javey-agent` before creating an Issue. It exposes no arbitrary `gh` command.

The role instance's GitHub Source has no allowed senders and leaves repository observation off. Its own Issue is therefore not accepted as new work by this instance. The Router reviews `javey-agent` Issues in the morning, dispatches worthy work with `@javey-agent`, and closes the rest with a reason. The W7 acceptance remains separate: after the first real nightly run, record the resulting Issue link in `ROUTER_INBOX`.

## Known boundaries

Preset restrictions reduce accidents but are not a security boundary. The current implementation relies on the read-only checkout, the fixed runner, the fixed GitHub wrapper and the separate agent gh directory/account. A dedicated OS user and filesystem ACL are still deferred. The browser is restricted to a local target by the RoleSpec schema; general outbound network isolation is not implemented.

The first Schedule implementation supports one daily five-field cron expression (`minute hour * * *`). It does not yet support arbitrary cron fields, multiple roles per Source instance, per-profile worker quotas, or screenshot upload to GitHub. Artifacts remain local; the Issue records their run id and filenames.
