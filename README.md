# pi-model-aliases

A Pi extension for stable, named routes to physical models. Define an alias once, select it as `aliases/<name>`, and change its target without changing the model name used in your workflow.

## Install and load

From this package directory, load the extension directly while developing:

```sh
pi --extension ./src/index.ts
```

When installed as a Pi package, the `pi.extensions` entry in `package.json` loads `./src/index.ts` automatically. Restart or reload Pi after installing or changing the package.

## Manage aliases

Run `/model-aliases` in the Pi TUI to add, retarget, rename, or remove an alias. Target search matches the provider, model ID, and display name. Only currently available physical models are offered as new targets; virtual models and unauthenticated targets are excluded.

Aliases are selected with the normal model picker using:

```text
aliases/<name>
```

For example, `aliases/fast` can route to `openai/gpt-4.1-mini` today and to another physical model later.

## Configuration

The global configuration file is:

```text
~/.pi/agent/model-aliases.json
```

If `PI_CODING_AGENT_DIR` is set, the file is `model-aliases.json` inside that directory. The schema is:

```json
{
  "version": 1,
  "aliases": [
    {
      "name": "fast",
      "target": {
        "provider": "openai",
        "model": "gpt-4.1-mini"
      }
    }
  ]
}
```

Names are trimmed and lowercased, and must match `^[a-z0-9][a-z0-9._-]*$`. Target provider and model values must be non-empty strings. Invalid entries are reported; a malformed root, version, or aliases array is fatal and prevents virtual aliases from being registered.

Configured targets are resolved when a request is routed. If a target is missing, no longer available, or resolves to another virtual model, the alias reports an error instead of silently selecting a different model. Existing aliases whose target is currently unavailable remain visible as stale entries and are marked `(unavailable)` in the manager and report.

## Non-interactive use

In print, RPC, and other non-TUI modes, `/model-aliases` does not open custom UI. It emits a report through Pi's custom-message channel, including configured aliases, unavailable targets, configuration diagnostics, and the instruction to use TUI mode for management.

## Development

```sh
npm install
npm test
npm run typecheck
```
