# pi-provider

**English** | [简体中文](README.zh-CN.md)

A [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that adds an interactive `/provider` command for managing custom providers (relays / proxies / local OpenAI-compatible servers) in `~/.pi/agent/models.json` — a step-by-step Q&A flow instead of hand-editing JSON.

## Features

- **Provider-first screens**: `/provider` opens your provider list. Enter opens a provider's page, where every setting is a row you edit in place (base URL, protocol, API key, display name, compat, models); `t` tests a provider straight from the list
- **Five-screen add flow**: base URL → API key → protocol → models → review. Values survive stepping back with Esc, and the review page edits any field in place, so fixing a typo never means walking back through the wizard
- API protocol is always picked manually, never guessed: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, Google Generative AI
- API key in one field: paste a key to store it, type `$NAME` to reference an environment variable, or leave it empty and use `/login` later. Literal keys are never shown back (`sk-…abcd`)
- Fetches the relay's `GET /v1/models` automatically and opens a checklist with each model's context / thinking metadata on its row (type to search, Space toggles, Ctrl+A toggles everything visible)
- Auto-enriches selected models against the **official pi model catalog** — fills in `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `cost`, etc.; falls back to sane defaults (128k context) when no match is found
- Forwards model-level Anthropic `compat` flags (e.g. `forceAdaptiveThinking` for Claude Opus/Sonnet 4.6) so relay copies of those models negotiate thinking the same way as the official endpoint
- **Save and test**: saving runs the test panel right away; press Enter on a passing model to switch the session to it
- **Tests use pi's own request path** (`modelRegistry.streamSimple`): the same credentials (including `/login` and provider `headers`), URL building, compat flags and request shape as a real session — the system prompt goes out as the `developer` role for reasoning models, with `reasoning_effort`
- **Compat from evidence, not guesses**: when a relay rejects a request field (`developer` role, `reasoning_effort`, `max_tokens` vs `max_completion_tokens`, `stream_options`, `store`), the panel names it and `c` applies the matching compat flag, then re-tests the models that failed
- Test panel shows per-model latency, `x` removes failing models, `s` chooses which models to test; the provider list shows each provider's last result for the session
- **One model list per provider**: configured models start checked, models the relay lists but you haven't added are marked `new`, configured models the relay no longer lists are flagged; toggling builds a `+`/`-` diff that is confirmed and written in one go
- Local server presets: Ollama, LM Studio, vLLM
- Can route a built-in provider through a relay by overriding just its `baseUrl`, without touching its model list
- Can re-sync configured models with pi's official catalog (picks up upstream fixes like new `compat` flags without touching ids, custom names, or hand-edited fields)
- Writes `models.json` atomically (temp file + rename) with permissions tightened to `0600` where possible; each write re-reads the file first, so edits made meanwhile survive
- No runtime dependencies of its own: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are provided by your pi install

## Installation

Install a release as a pi package (no clone needed):

```bash
pi install git:github.com/BlueOcean223/pi-provider@v0.2.0
```

pi pins the tag; install a newer tag to upgrade. The npm package named `pi-provider` is a different project, so don't install `npm:pi-provider`.

**From a clone (for development)**

```bash
git clone https://github.com/BlueOcean223/pi-provider.git
cd pi-provider
```

Then either symlink it into the global extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)" ~/.pi/agent/extensions/pi-provider
```

and restart pi (or run `/reload` inside a session), or load it for one run:

```bash
pi -e "$(pwd)/index.ts"
```

## Usage

Inside a pi session (sub-commands and provider ids support Tab completion):

| Command | What it does |
|---|---|
| `/provider` | Provider list — Enter opens a provider, `t` tests it; adding and editing `models.json` sit at the bottom (alias `list`) |
| `/provider <id>` | Open that provider's page |
| `/provider add` | Add a relay or any OpenAI-, Anthropic- or Google-compatible endpoint |
| `/provider local` | Add a local server (Ollama, LM Studio, vLLM) |
| `/provider models [id]` | Add or remove a provider's models (alias `add-models`) |
| `/provider proxy` | Route a built-in provider through a relay (`baseUrl` override only) |
| `/provider test [id]` | Test connectivity and chat with each model (alias `probe`) |
| `/provider remove [id]` | Delete a provider (alias `rm`) |
| `/provider path` | Edit `models.json` directly (alias `edit`) |

Inside the screens, the outcome of an action (saved, removed, now using …) shows as a note on the next screen. A sub-command that returns to the chat reports its outcome as one notification line.

### Provider list and provider page

The list shows one row per provider — `id  host · protocol · N models` plus the last test result of this session (`✓ 3/3 · 820ms · 2m ago`). Built-in providers routed through a relay show as `proxy → host`.

A provider's page lists its settings; Enter on a row edits it and writes the change immediately (Esc in the editor changes nothing):

- **Base URL**, **Protocol**, **Display name**
- **API key** — Enter replaces it (empty keeps the stored key); `x` removes it (asks first for a stored literal key)
- **Compat** (OpenAI protocols) — presets, or edit the flags as JSON
- **Models** — the combined model list (see below); **Add model ids manually**; **Sync metadata from pi's catalog**
- **Test connection**, **View JSON**, **Delete provider**

### `/provider add`

1. **Base URL** — the relay's API root; trailing slash stripped
2. **API key** — paste a key (stored in `models.json`, file mode `0600`), `$MY_RELAY_API_KEY` to reference an environment variable, or leave empty to use `/login` / `--api-key` later
3. **API protocol** — picked manually (never inferred): OpenAI Chat Completions (`openai-completions`, most relays), Anthropic Messages, OpenAI Responses, Google Generative AI
4. **Models** — the catalog is fetched automatically (OpenAI-style `{ data: [{ id }] }`, independent of the chat protocol; tries `{baseUrl}/v1/models`, `{baseUrl}/models`, `{baseUrl}/api/v1/models` in an order that depends on whether `baseUrl` already ends in `/v1`). Select at least one. If the relay can't list models, an editor opens with the reason so you can type ids instead
5. **Review** — every field on one page with the id suggested from the host (`api.relay-one.com` → `relay-one`). The suggestion never reuses an id in `models.json`, a provider pi already has (`deepseek`, `openai`, …) or a sub-command name; it appends `-2`, `-3` instead. Typing a built-in id on purpose shows a warning: pi merges the entry into its own provider, and that provider's built-in models also go to this base URL. Enter on a row edits it; **Models** goes back to the checklist. **Save and test** writes the provider and opens the test panel

Every selected model id is matched against the **official pi model catalog** (taken live from pi's model registry, so it works in every install mode and reflects pi's remote catalog refreshes): a match copies over the official `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` fields (the `id` itself always stays the relay's own), while a miss falls back to defaults (128k context, non-reasoning, zero cost). For Anthropic-API models, model-level `compat` flags that describe the model's own request quirks (e.g. `forceAdaptiveThinking`, `supportsStrictTools`) are copied too; gateway/session-routing flags are deliberately left out.

There is no compat question up front: pi's docs ask for compat flags to describe verified differences, so the test panel suggests the right flag when a relay actually rejects something.

### `/provider local`

Pick Ollama (`localhost:11434/v1`), LM Studio (`localhost:1234/v1`) or vLLM (`localhost:8000/v1`); the installed models are listed and pre-checked. Local providers get a dummy API key because pi only shows models whose provider has resolvable credentials. Change the port on the review page.

### `/provider models`

One checklist for the provider: configured models start checked; models the relay lists but the provider lacks start unchecked and are marked `new`; configured models the relay no longer lists are marked `not listed by relay`. Uncheck to remove, check to add, then confirm the `+`/`-` diff.

Additions are enriched from pi's official catalog; existing entries and hand-edited metadata are preserved exactly, and nothing is removed unless you uncheck it. Models a built-in provider already inherits never show up as new. The provider's saved key and headers are used for the catalog request. `baseUrl`-only proxy overrides can't add models without a protocol, but models already configured on them can still be removed.

**Sync metadata from pi's catalog** (on the provider page) re-enriches every configured model and shows a field-level diff (`model: field old → new`) before writing. Only catalog-managed fields are updated (`reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, `cost`, `compat`); ids, custom `name`s, `api` overrides and unknown keys are preserved, and models with no official match are kept as-is.

### `/provider test`

Runs every check live in one panel — spinners settle into ✓/✗ in place, Esc aborts, closing leaves nothing in the chat log:

- **Catalog probe** — tries the model-catalog endpoint (listing any models counts as healthy), falling back to a plain HTTP request judged by status code
- **Chat test (model-id)** — one row per model, sent through pi's own model registry: a one-word system prompt plus `"hi"`, 16 output tokens, reasoning on for reasoning models of OpenAI-style APIs. Passing rows show latency (amber from 6 s); failing rows show the HTTP status and the relay's error message. If the registry doesn't know a model yet, a hand-built minimal request with the same credentials is used instead

At most 4 chat requests are in flight at once (a burst of dozens comes back as 429s that look like real failures); waiting rows show `○ … queued`. Notes above the checks say when no API key resolves (for example a `$ENV_VAR` that isn't set in this shell) or when the key is a `!command`, which the catalog probe doesn't run. After the run:

| Key | Action |
|---|---|
| ↑↓ / Enter | Switch the session to a passing model |
| `c` | Apply the compat flag the errors point at, then re-test the failed models |
| `x` | Remove the failing models from `models.json` (asks first) |
| `s` | Choose which models to test |
| `r` | Run again |

`baseUrl`-only proxies get the catalog probe only — their chat goes through the built-in provider.

### `/provider proxy`

Use this when you just want a **built-in** provider (`anthropic`, `openai`, `google`, `openrouter`, `deepseek`, `xai`, `mistral`, `groq`, `minimax`, `minimax-cn`, `kimi-coding`, `zai`, `zai-coding-cn`, or any id you type) to route through a relay: pick the provider, enter the relay base URL, optionally a key (empty keeps `/login` or environment auth), review, **Save and test**. If the provider already has custom models, the review page lets you keep or drop them.

pi picks credentials in this order: `--api-key`, your `/login` credential (`auth.json`), the `apiKey` in `models.json`, environment variables. So if you are signed in to the provider with `/login`, the relay receives that credential and a key set here is not used. The review page, the provider page and the test panel say so; remove the credential with `/logout` if the relay issues its own keys.

### `/provider path`

Opens `models.json` in an editor. Invalid JSON reopens the editor with the error and your edits intact; valid edits are saved after a confirmation, comments and formatting included.

## Example config

After `/provider add`, `~/.pi/agent/models.json` looks roughly like this:

```json
{
  "providers": {
    "my-relay": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_RELAY_API_KEY",
      "models": [
        {
          "id": "claude-sonnet-4-6",
          "name": "Claude Sonnet 4.6",
          "reasoning": true,
          "contextWindow": 200000,
          "maxTokens": 64000,
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
        }
      ]
    }
  }
}
```

The following fields aren't generated by this extension but are supported by `models.json`, so feel free to add them by hand: `authHeader`, `headers`, `modelOverrides`, `oauth`.

Once saved, press Enter on a passing model in the test panel to switch to it, or pick one later with `/model`; no pi restart needed.

## Project layout

```
pi-provider/
├── index.ts                  # registers /provider: argument parsing, completion, routing
├── flows/
│   ├── home.ts                # provider list, provider picker, models.json editor
│   ├── provider.ts            # provider page: edit fields in place, delete
│   ├── add.ts                 # add relay / local server: wizard + review page
│   ├── proxy.ts               # route a built-in provider through a relay
│   ├── models.ts              # combined model list, manual ids, catalog metadata sync
│   ├── test.ts                # test panel orchestration: registry chat tests, compat fix, remove failed, switch model
│   ├── fields.ts              # one prompt per provider field (shared by add, review and provider page)
│   └── shared.ts              # auth resolution, registry refresh, enrichment, write helpers
└── lib/
    ├── types.ts               # ProviderApi / ModelEntry / ProviderConfig types & labels
    ├── models-json.ts         # read/write models.json (JSONC-tolerant, atomic write, 0600 tightening)
    ├── detect-api.ts          # GET /v1/models discovery, connectivity probe, fallback chat ping
    ├── official-catalog.ts    # snapshots pi's live model registry catalog, does id matching + enrichment
    ├── model-management.ts    # model diff/merge/refresh invariants
    ├── compat-hints.ts        # maps relay errors to the compat flag that fixes them
    ├── test-history.ts        # last test result per provider (session memory)
    ├── row-menu.ts            # row list for object screens: aligned columns, per-row shortcut keys, notes
    ├── loop-ui.ts             # wrap-around select/editor, prefilled input, wizard step machine, spinner
    ├── checks-panel.ts        # live ✓/✗ panel with latency, pick and post-run actions
    ├── checkbox-select.ts     # [x]/[ ] checklist built on pi-tui's SettingsList
    └── testing/tui-harness.ts # drives ui.custom screens with scripted keys in tests
```

Run the tests with `npm test` (Node 22+). They cover the components (checklist, row menu, input, test panel), the wizard step machine, model diff/merge invariants, compat hints, and whole flows in TUI mode with scripted keys (add → review → save → test → switch, compat fix and re-test, key edit on the provider page) and in RPC mode.

## Notes

- The models.json path honors `PI_CODING_AGENT_DIR` (same as pi itself); the default is `~/.pi/agent/models.json`
- Like pi, this extension accepts `//` comments and trailing commas in `models.json` — but they are dropped when it rewrites the file (screens that write show a warning when the file has them)
- Model metadata comes from pi's live model registry (`ctx.modelRegistry`), so enrichment works in every install mode; if the registry is somehow empty, models fall back to default metadata
- After each write the registry is reloaded (no network), so `/model` and model switching see the change at once
- Sub-commands need dialog-capable UI (`ctx.hasUI`: TUI or RPC hosts). In RPC mode lists become selects, the model checklist becomes an editor-based on/off list, the test panel reports through one notification, and the panel's keys (switch, compat fix, remove failed) aren't available. Fully non-interactive runs error out immediately and print the `models.json` path

## License

MIT (see [LICENSE](LICENSE))
