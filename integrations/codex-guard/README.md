# Codex guard

This host-level hook refuses `computer` / `open_application` calls that target the wrong Codex app.
It runs before tools and does not belong to the `dsh-superagent` bundle patch.

The installer pins `PAOS_CODEX_APP=com.openai.codex` and registers one `PreToolUse` entry in
`~/.codex/hooks.json` (or the file passed with `--file`). It keeps a backup, replaces an older
`personal-super-agent` guard, and is safe to run again.

```sh
node integrations/codex-guard/install.mjs
node integrations/codex-guard/install.mjs --dry-run
```

It blocks only two cases:

- an app operation that names Waves CODEX or Codex Web GPT;
- an ambiguous Codex app target when no working pin resolves it.

Every other tool call, and every app that is not Codex, passes through.
