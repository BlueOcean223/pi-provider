# pi-provider

**English** | [简体中文](README.zh-CN.md)

A [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that adds an interactive `/provider` command for managing custom providers (relays / proxies / local OpenAI-compatible servers) in `~/.pi/agent/models.json` — a step-by-step Q&A flow instead of hand-editing JSON.

## Features

- Fully interactive (select / input / editor / confirm prompts) — no flags to remember
- API protocol is always picked manually, never guessed: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, Google Generative AI
- Can fetch the model catalog from a relay's `GET /v1/models` and multi-select from it (same UX as pi's built-in settings list: `→` cursor, `on`/`off`, type-to-search, Enter/Space to toggle)
- Auto-enriches selected models against the **official pi model catalog** — fills in `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `cost`, etc.; falls back to sane defaults (128k context) when no match is found
- Can proxy a built-in provider by overriding just its `baseUrl`, without touching its model list
- Built-in connectivity probe (`/provider test`)
- Writes `models.json` with permissions tightened to `0600` where possible
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

   Every selected model id is matched against the **official pi model catalog** (read from your installed pi's `@earendil-works/pi-ai` data files): a match copies over the official `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` fields (the `id` itself always stays the relay's own), while a miss falls back to defaults (128k context, non-reasoning, zero cost).
6. **Compat preset** (only shown for OpenAI-family protocols):
   - None (defaults)
   - Local / strict OpenAI-compat (disables the `developer` role and `reasoning_effort`)
   - Chinese-relay safe defaults (disables the `developer` role)
7. **Display name** (optional)
8. Previews the JSON about to be written, then saves it to `~/.pi/agent/models.json` on confirmation

### `/provider proxy`

Use this when you just want a **built-in** provider (`anthropic`, `openai`, `google`, `openrouter`, `deepseek`, `xai`, `mistral`, `groq`, `minimax`, `minimax-cn`, `kimi-coding`, `zai`, `zai-coding-cn`, or any other id you type in) to route through a relay, without touching its model list:

1. Pick a built-in provider id (or "Other" to type your own)
2. Enter the relay `baseUrl`
3. Optionally set an `apiKey` too (otherwise it keeps using `/login` or environment-based auth)
4. If that provider already has custom `models`, you'll be asked whether to keep them

### `/provider test`

Pick a saved provider and probe its `baseUrl`: it first tries the model-catalog endpoint — listing any models counts as healthy — then falls back to a plain HTTP request judged by status code. If `apiKey` is a `$ENV_VAR` reference that isn't set, it warns first and then probes without auth.

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
    ├── models-json.ts         # read/write ~/.pi/agent/models.json (incl. 0600 permission tightening)
    ├── detect-api.ts          # GET /v1/models discovery and connectivity probing
    ├── official-catalog.ts    # locates & parses the installed pi's official model catalog, does id matching + enrichment
    └── checkbox-select.ts     # multi-select UI matching pi's SettingsList
```

## Notes

- Locating the official model catalog depends on finding an installed `pi` executable or a local `~/.local/share/pi-node` install; if neither is found, all models fall back to default metadata — everything still works, just with less accurate context/pricing shown
- Every sub-command requires a TUI (`ctx.hasUI`); running in a non-interactive environment errors out immediately and prints the `models.json` path

## License

MIT (see `package.json`)
