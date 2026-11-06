# Multi-instance deployment

`deploy/projects.json` is the source of truth for each project's DSH profile, port, state directory, model route and initial settings. `scripts/instances.mjs` renders the profile patch and drives the existing `scripts/dsh-superagent` service script.

```sh
node scripts/instances.mjs list
node scripts/instances.mjs provision fretsense   # create profile, link this checkout, write patch
node scripts/instances.mjs start fretsense
node scripts/instances.mjs configure fretsense   # Source, Policy and Execution through the management API
node scripts/instances.mjs status
node scripts/instances.mjs stop fretsense
```

`provision` backs up an existing `cordis.patch.yml` before replacing it. It does not recreate an existing profile, because that would delete its machine configuration.

## Fretsense

| Field | Value |
| --- | --- |
| Profile | `superagent-fretsense` |
| URL | `http://127.0.0.1:3082` |
| State | `~/.dsh/state/superagent-fretsense` |
| Repository | `Javey-Li/FretSense` |
| Worker limit | `2` |
| Checkout for prepare | `/Users/javeyli/Projects/FretSense` |

The prepare command creates one worktree per Ticket under the default `<stateDir>/work` root and uses the worker git configuration written by setup.

## Model route

The profile declares one `llm-pi-ai` route named `magpie` with `api: openai-completions` at `http://127.0.0.1:3425/v1`, and makes `workbuddy/deepseek-v4.1-flash` the profile default. A direct Chat Completions request to Magpie returns `OK`; a temporary headless DSH profile using the same route returned `MAGPIE_OK`.

pi-ai requires a credential reference even when the endpoint accepts any bearer value. `defaults.env` supplies the non-secret placeholder `MAGPIE_API_KEY=local`, and `instances.mjs start` exports it to the service. Replace it with a real key if Magpie starts checking authentication.

## Pilot boundary with the owner account

The owner account can run setup: `gh api user` is `Javey-Li`, and `Javey-Li/FretSense` reports `ADMIN`/`push`. That is not enough for a one-account pilot. The GitHub Source drops every Issue, pull request and comment authored by the agent login before it reaches the Policy (`src/sources/github.ts`, the `sameName(item.user.login, login)` checks). When the agent CLI and the requester are both `Javey-Li`, every request from that account is dropped, so no Ticket can be created. A dedicated agent account, or a second requester account, is required; only the owner can create or invite it.

`~/.local/bin/gh-agent` exists for the pilot. It sets `GH_CONFIG_DIR` to `~/.config/gh-agent` and, when that directory has no login, falls back to the owner's existing `gh auth token` through `GH_TOKEN`. This keeps the identity boundary explicit without copying a token file. Replace the fallback with `gh-agent auth login` before using a dedicated agent account.

An empty `GH_CONFIG_DIR` is not signed in on its own:

```text
$ GH_CONFIG_DIR=~/.config/gh-agent gh api user
To get started with GitHub CLI, please run:  gh auth login
```

The fallback identity is still the owner:

```text
$ ~/.local/bin/gh-agent api user --jq .login
Javey-Li
```

## Worker permissions

`Sessions.ensure` sets every managed Session to `danger-full-access` (`src/app/sessions.ts`). `maxWorkers` is therefore the only concurrency guard; this instance keeps it at `2` for the pilot. For real isolation, run the agent under a dedicated OS account that holds only the agent credentials.
