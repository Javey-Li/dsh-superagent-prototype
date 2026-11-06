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
| Executor | `composite`: write → T3, read → DSH worker |
| Worker limit | `2` |
| Checkout for prepare | `/Users/javeyli/Projects/FretSense` |

The prepare command creates one worktree per Ticket under the default `<stateDir>/work` root and uses the worker git configuration written by setup.

## T3 write line

The composite executor sends write Mandates to a headless T3 server and read Mandates to a DSH worker. Keep the headless server on its own base directory so the desktop T3 app is untouched:

```sh
GH_CONFIG_DIR=~/.config/gh-agent t3 serve --port 3778 --host 127.0.0.1 \
  --base-dir ~/.t3-superagent --no-browser
t3 project add /Users/javeyli/Projects/FretSense --title FretSense --base-dir ~/.t3-superagent
T3_MCP_TOKEN=$(t3 auth session issue --base-dir ~/.t3-superagent --label dsh-superagent-w1 \
  --ttl 7d --scope orchestration:read --scope orchestration:operate --token-only)
export T3_MCP_TOKEN
node scripts/instances.mjs restart fretsense
```

`instances.mjs` seeds `defaults.env` and the exported `T3_MCP_TOKEN` into the tmux server environment before restarting, so the service process receives them. `executor.t3` points at `http://127.0.0.1:3778/mcp`, `ghConfigDir: /Users/javeyli/.config/gh-agent`, provider `magpie-codex`, model `auto/dfmodel`. The token is read from `T3_MCP_TOKEN` and is never stored in `deploy/projects.json`.

The server process was checked for `GH_CONFIG_DIR=/Users/javeyli/.config/gh-agent`, and a T3 thread asked to run `gh api user --jq .login` returned `javey-agent`.

## Model route

The profile declares one `llm-pi-ai` route named `magpie` with `api: openai-completions` at `http://127.0.0.1:3425/v1`, and makes `workbuddy/deepseek-v4.1-flash` the profile default. A direct Chat Completions request to Magpie returns `OK`; a temporary headless DSH profile using the same route returned `MAGPIE_OK`.

pi-ai requires a credential reference even when the endpoint accepts any bearer value. `defaults.env` supplies the non-secret placeholders `MAGPIE_API_KEY=local` and `MAGPIE_GATEWAY_KEY=local`, and `instances.mjs start` exports them to the service. Replace them with real keys if Magpie starts checking authentication. The profile's merged Magpie route uses `MAGPIE_GATEWAY_KEY`; the alias keeps both the minimal generated patch and the merged provider catalog serviceable.

## Requester and agent accounts

The agent runs as `javey-agent` through `GH_CONFIG_DIR=~/.config/gh-agent`; `Javey-Li/FretSense` reports `permissions.push: true` for that account. The only allowed requester remains `Javey-Li`.

The GitHub Source drops every Issue, pull request and comment authored by the agent login before it reaches the Policy (`src/sources/github.ts`, the `sameName(item.user.login, login)` checks). The owner must write the request and mention `@javey-agent`; a request authored by `javey-agent` is ignored by design.

`~/.local/bin/gh-agent` only selects the agent configuration directory and never falls back to the operator token:

```text
$ ~/.local/bin/gh-agent api user --jq .login
javey-agent
```

This separation is what lets the owner submit work while the executor commits and pushes as the agent account.

## Worker permissions

`Sessions.ensure` sets every managed Session to `danger-full-access` (`src/app/sessions.ts`). Read work uses `executor.maxWorkers`, and the composite executor caps T3 write work at `WRITE_LIMIT` (2). This instance keeps `maxWorkers` at `2` for the pilot. For real isolation, run the agent under a dedicated OS account that holds only the agent credentials.
