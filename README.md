# pi-provider

**English** | [简体中文](README.zh-CN.md)

A [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that adds an interactive `/provider` command for managing custom providers (relays / proxies / local OpenAI-compatible servers) in `~/.pi/agent/models.json` — a step-by-step Q&A flow instead of hand-editing JSON.

## Features

- Fully interactive (select / input / editor / confirm prompts) — no flags to remember
- API protocol is always picked manually, never guessed: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, Google Generative AI
- Can fetch the model catalog from a relay's `GET /v1/models` and multi-select from it (same UX as pi's built-in settings list: `→` cursor, `on`/`off`, type-to-search, Enter/Space to toggle)
- Auto-enriches selected models against the **official pi model catalog** — fills in `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `cost`, etc.; falls back to sane defaults (128k context) when no match is found
- Can scan an existing relay for newly available models, add all or selected additions, and remove configured custom models (`/provider models`)
- Can proxy a built-in provider by overriding just its `baseUrl`, without touching its model list
- Built-in connectivity probe (`/provider test`)
- Writes `models.json` atomically (temp file + rename) with permissions tightened to `0600` where possible
- No runtime dependencies of its own: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are provided by your pi install

## Installation

Clone this repo first (all methods below assume your current directory is the cloned `pi-provider/`):

```bash
git clone https://github.com/BlueOcean223/pi-provider.git
cd pi-provider
```

**Option A — Symlink into global extensions (recommended for development)**

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)" ~/.pi/agent/extensions/pi-provider
```

Then restart pi, or run `/reload` inside a session.

**Option B — Load ad-hoc**

```bash
pi -e "$(pwd)/index.ts"
```

**Option C — pi package (optional)**

```bash
pi install file:"$(pwd)"
# or once published: pi install npm:pi-provider
```

## Usage

Inside a pi session (sub-commands support Tab completion):

| Command | What it does |
|---|---|
| `/provider` | Open the main menu listing all sub-commands |
| `/provider add` | Add a new custom provider |
| `/provider models [provider-id]` | Discover, manually add, or remove models on an existing provider (alias `add-models`) |
| `/provider proxy` | Override only a built-in provider's `baseUrl` (route it through a relay) |
| `/provider list` | List saved custom providers; select one to view its full JSON |
| `/provider remove` | Remove a provider (alias `rm`) |
| `/provider test` | Probe a provider endpoint's connectivity (alias `probe`) |
| `/provider path` | Show the `models.json` path and a content preview |

### `/provider add` walkthrough

1. **Provider id** — e.g. `my-relay`; auto-lowercased and restricted to `[a-z0-9_-]`; asks before overwriting an existing id
2. **Base URL** — the relay's root URL, trailing slash stripped automatically
3. **API protocol** — pick one manually (never inferred):
   1. **OpenAI Chat Completions** (`openai-completions`) — most relays
   2. **Anthropic Messages** (`anthropic-messages`)
   3. **OpenAI Responses** (`openai-responses`)
   4. **Google Generative AI** (`google-generative-ai`)
4. **API key** — one of:
   - Store the literal key in `models.json`
   - Reference an environment variable (e.g. `$MY_RELAY_API_KEY`, resolved at runtime, never written to disk as plaintext)
   - Skip for now, and use `/login` or `--api-key` later
5. **Models** — one of:
   - **Fetch from GET /v1/models then multi-select**: queries the relay's model catalog (OpenAI-style `{ data: [{ id }] }`, independent of the chosen chat protocol; tries `{baseUrl}/v1/models`, `{baseUrl}/models`, `{baseUrl}/api/v1/models` in order depending on whether `baseUrl` already ends in `/v1`), then opens a multi-select list
   - Enter model ids manually (comma- or newline-separated; more than one id also opens the multi-select preview)
   - Minimal placeholder (writes `default-model`, to be edited into `models.json` later)

   Every selected model id is matched against the **official pi model catalog** (taken live from pi's model registry, so it works in every install mode — npm, pi-node, bun binary — and reflects pi's remote catalog refreshes): a match copies over the official `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` fields (the `id` itself always stays the relay's own), while a miss falls back to defaults (128k context, non-reasoning, zero cost).
6. **Compat preset** (only shown for OpenAI-family protocols):
   - None (defaults)
   - Local / strict OpenAI-compat (disables the `developer` role and `reasoning_effort`)
   - Chinese-relay safe defaults (disables the `developer` role)
7. **Display name** (optional)
8. Previews the JSON about to be written, then saves it to `~/.pi/agent/models.json` on confirmation

### `/provider models`

Use this after a configured relay starts offering more models. Run `/provider models` and pick a provider, or jump straight to one with `/provider models my-relay`:

1. Choose **Discover and add new models** to fetch the relay catalog, enter model ids manually, or choose **Remove configured models**
2. The fetched catalog is compared exactly by model id with the provider's configured `models`
3. If new ids are found, either add all of them in one step or open the searchable multi-select list
4. New entries are enriched from pi's official catalog, then a `+ model-id` diff is shown before writing
5. Removal also uses a searchable multi-select and shows an explicit `- model-id` confirmation; it only removes entries from that provider's configured `models`

Discovery is additive: existing model entries and hand-edited metadata are preserved exactly, duplicate ids are skipped, and models missing from the latest relay response are never removed automatically. It reuses the provider's resolved API key and request headers when available. Removal happens only when explicitly selected. The file is read again immediately before either write so unrelated edits made while the dialogs were open are retained. `baseUrl`-only proxy overrides cannot add models without an explicit API protocol, but providers that already have custom model entries can still remove them.

### `/provider proxy`

Use this when you just want a **built-in** provider (`anthropic`, `openai`, `google`, `openrouter`, `deepseek`, `xai`, `mistral`, `groq`, `minimax`, `minimax-cn`, `kimi-coding`, `zai`, `zai-coding-cn`, or any other id you type in) to route through a relay, without touching its model list:

1. Pick a built-in provider id (or "Other" to type your own)
2. Enter the relay `baseUrl`
3. Optionally set an `apiKey` too (otherwise it keeps using `/login` or environment-based auth)
4. If that provider already has custom `models`, you'll be asked whether to keep them

### `/provider test`

Pick a saved provider (and a model, when several are configured) and both checks run live in one panel — spinners settle into ✓/✗ in place, Esc aborts the in-flight requests, and closing the panel leaves nothing behind in the chat log:

- **Catalog probe** — tries the model-catalog endpoint (listing any models counts as healthy), falling back to a plain HTTP request judged by status code
- **Chat test** — a real minimal `"hi"` request through the provider's configured protocol, the same way relay panels (one-api / new-api) test channels; skipped for baseUrl-only proxies and providers without custom models

If `apiKey` is a `$ENV_VAR` reference that isn't set (or a `!command`, which is never executed here), the panel notes it and tests without auth. Press `r` inside the panel to run the checks again.

### `/provider list` / `/provider remove` / `/provider path`

- `list`: shows a summary line per provider (`id · baseUrl · api · N model(s)`); select one to view its read-only JSON
- `remove`: same summary list; deletes after a confirmation
- `path`: shows the absolute `models.json` path and a content preview (up to 2000 characters; shows the error if the file is missing or fails to parse)

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

Once saved, just run `/model` to pick a model (opening `/model` re-reads the config, no pi restart needed).

## Project layout

```
pi-provider/
├── index.ts                  # registers /provider and its sub-command flows
└── lib/
    ├── types.ts               # ProviderApi / ModelEntry / ProviderConfig types & labels
    ├── models-json.ts         # read/write models.json (JSONC-tolerant, atomic write, 0600 tightening)
    ├── detect-api.ts          # GET /v1/models discovery and connectivity probing
    ├── official-catalog.ts    # snapshots pi's live model registry catalog, does id matching + enrichment
    ├── model-management.ts    # computes additions and applies explicit model add/remove updates
    ├── loop-ui.ts             # wrap-around select/editor, wizard step machine, spinner helper
    ├── checks-panel.ts        # live ✓/✗ checklist panel used by /provider test
    └── checkbox-select.ts     # multi-select UI matching pi's SettingsList
```

Run the tests (wizard step machine, model diff/merge invariants, chat-ping URL/protocol logic) with `npm test` (Node 22+).

## Notes

- The models.json path honors `PI_CODING_AGENT_DIR` (same as pi itself); the default is `~/.pi/agent/models.json`
- Like pi, this extension accepts `//` comments and trailing commas in `models.json` — but they are dropped when it rewrites the file (you'll be reminded in the confirm dialog)
- Model metadata comes from pi's live model registry (`ctx.modelRegistry`), so enrichment works in every install mode; if the registry is somehow empty, models fall back to default metadata — everything still works, just with less accurate context/pricing shown
- Sub-commands need dialog-capable UI (`ctx.hasUI`: TUI or RPC hosts); in RPC mode the model multi-select falls back to an editor-based on/off list. Fully non-interactive runs error out immediately and print the `models.json` path

## License

MIT (see [LICENSE](LICENSE))
