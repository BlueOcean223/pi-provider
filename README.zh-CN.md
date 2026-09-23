# pi-provider

[English](README.md) | **简体中文**

Pi（[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）扩展：提供交互式 `/provider` 命令，一步步问答即可管理自定义供应商（中转站 / 代理 / 本地 OpenAI 兼容服务），直接读写 `~/.pi/agent/models.json`，不用手写 JSON。

## 特性

- **以供应商为主界面**：`/provider` 打开供应商列表，回车进入某个供应商的页面，每项设置都是一行、就地编辑（base URL、协议、API key、显示名、compat、模型）；在列表上按 `t` 直接测试
- **五步新增流程**：base URL → API key → 协议 → 模型 → 汇总页。按 Esc 回退时已填的值都保留；汇总页可以直接改任意字段，改个拼写错误不用从头走一遍
- API 协议手动四选一，不做猜测：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses、Google Generative AI
- API key 只有一个输入框：粘贴 key 即明文保存，输入 `$NAME` 引用环境变量，留空则之后用 `/login`。明文 key 不会再显示出来（显示为 `sk-…abcd`）
- 自动请求中转站 `GET /v1/models`，打开模型清单，每行带上下文长度 / 是否 thinking（输入即搜索，Space 切换，Ctrl+A 切换当前可见的全部行）
- 自动对齐 **pi 官方模型目录**，为选中模型补全 `contextWindow`、`maxTokens`、`reasoning`、`thinkingLevelMap`、`cost` 等元数据；匹配不到则回退默认值（128k 上下文）
- 转发 Anthropic 模型级 `compat` 标记（如 Claude Opus/Sonnet 4.6 的 `forceAdaptiveThinking`），让中转副本与官方端点以相同方式协商 thinking
- **保存即测试**：保存后直接打开测试面板；在通过的模型上按回车即把当前会话切到该模型
- **测试走 pi 自己的请求路径**（`modelRegistry.streamSimple`）：凭据（含 `/login` 与供应商 `headers`）、URL 拼接、compat 标记、请求结构都与真实会话一致——reasoning 模型的系统提示以 `developer` role 发送，并带 `reasoning_effort`
- **compat 按实际报错设置，不靠猜**：中转站拒绝某个请求字段（`developer` role、`reasoning_effort`、`max_tokens` 与 `max_completion_tokens`、`stream_options`、`store`）时，面板会指出是哪个字段，按 `c` 写入对应 compat 标记并重测失败的模型
- 测试面板显示每个模型的延迟，`x` 移除失败的模型，`s` 选择要测哪些模型；供应商列表显示本次会话里每个供应商最近一次测试结果
- **每个供应商一张模型清单**：已配置的模型默认勾选，中转站有但尚未添加的标 `new`，已配置但中转站不再列出的会标出来；勾选变化生成 `+`/`-` 差异，确认后一次写入
- 本地服务预设：Ollama、LM Studio、vLLM
- 支持只改内置供应商的 `baseUrl`，让它走中转站，不动它的模型列表
- 可将已配置模型与 pi 官方目录重新对齐——同步上游修复（如新增 `compat` 标记），不影响 id、自定义名称和手动修改的字段
- 写入 `models.json` 采用原子写入（临时文件 + rename），并尽量收紧权限到 `0600`；每次写入前重新读取文件，保留期间其他地方做的修改
- 无生产依赖：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 由 pi 运行时提供，装好 pi 即可用

## 安装

以 pi package 方式安装发布版本（无需克隆）：

```bash
pi install git:github.com/BlueOcean223/pi-provider@v0.2.0
```

pi 会固定在这个 tag 上；升级时安装更新的 tag。npm 上名为 `pi-provider` 的包是另一个项目，不要安装 `npm:pi-provider`。

**从克隆的仓库安装（开发用）**

```bash
git clone https://github.com/BlueOcean223/pi-provider.git
cd pi-provider
```

然后软链到全局 extensions 目录：

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)" ~/.pi/agent/extensions/pi-provider
```

再重启 pi（或在会话里执行 `/reload`）；也可以只在本次运行中加载：

```bash
pi -e "$(pwd)/index.ts"
```

## 用法

在 pi 会话里输入（子命令和供应商 id 都支持 Tab 补全）：

| 命令 | 作用 |
|------|------|
| `/provider` | 供应商列表——回车进入供应商页面，`t` 测试；新增和编辑 `models.json` 在列表底部（别名 `list`） |
| `/provider <id>` | 直接进入该供应商的页面 |
| `/provider add` | 新增中转站，或任何兼容 OpenAI / Anthropic / Google 协议的端点 |
| `/provider local` | 新增本地服务（Ollama、LM Studio、vLLM） |
| `/provider models [id]` | 为供应商添加或移除模型（别名 `add-models`） |
| `/provider proxy` | 让内置供应商走中转站（只覆盖 `baseUrl`） |
| `/provider test [id]` | 测试连通性，并对每个模型做 chat 测试（别名 `probe`） |
| `/provider remove [id]` | 删除供应商（别名 `rm`） |
| `/provider path` | 直接编辑 `models.json`（别名 `edit`） |

在各个界面里，操作结果（已保存、已删除、已切换到 …）显示为下一个界面顶部的一行提示。直接回到聊天的子命令只用一条通知报告结果。

### 供应商列表与供应商页面

列表每个供应商一行——`id  host · 协议 · N models`，再加本次会话里最近一次测试结果（`✓ 3/3 · 820ms · 2m ago`）。只改了 `baseUrl` 的内置供应商显示为 `proxy → host`。

供应商页面列出各项设置；在某行上回车即编辑，改动立即写入（编辑时按 Esc 不做任何修改）：

- **Base URL**、**Protocol**、**Display name**
- **API key**——回车替换（留空保留已存的 key）；`x` 删除 key（明文 key 会先确认）
- **Compat**（OpenAI 系协议）——预设，或以 JSON 编辑
- **Models**——合并后的模型清单（见下文）；**Add model ids manually** 手动添加；**Sync metadata from pi's catalog** 同步元数据
- **Test connection**、**View JSON**、**Delete provider**

### `/provider add`

1. **Base URL**——中转站 API 根地址，自动去掉结尾斜杠
2. **API key**——粘贴 key（保存在 `models.json`，文件权限 `0600`）；输入 `$MY_RELAY_API_KEY` 引用环境变量；留空则之后用 `/login` / `--api-key`
3. **API protocol**——手动选择（不自动推断）：OpenAI Chat Completions（`openai-completions`，绝大多数中转站）、Anthropic Messages、OpenAI Responses、Google Generative AI
4. **Models**——自动拉取模型目录（OpenAI 风格 `{ data: [{ id }] }`，与聊天协议无关；按 `baseUrl` 是否已含 `/v1` 决定 `{baseUrl}/v1/models`、`{baseUrl}/models`、`{baseUrl}/api/v1/models` 的尝试顺序），至少选一个。中转站列不出模型时，会打开编辑器并写明原因，可以手动输入 model id
5. **汇总页**——所有字段在一页上，provider id 按域名自动建议（`api.relay-one.com` → `relay-one`）。建议的 id 不会与 `models.json` 里已有的 id、pi 已有的供应商（`deepseek`、`openai` 等）或子命令名重复，重复时依次加 `-2`、`-3`。手动填了内置供应商的 id 会显示警告：pi 会把这条配置并入它自己的供应商，该供应商的内置模型也会改发到这个 base URL。在某行上回车即编辑，**Models** 回到模型清单。**Save and test** 写入并打开测试面板

每个选中的 model id 都会匹配 **pi 官方模型目录**（直接取自 pi 运行中的模型注册表，因此各种安装方式都能用，且包含 pi 的远程目录刷新结果）：匹配到则复制官方的 `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` 等字段（`id` 仍然用中转站自己的），匹配不到则用默认值（128k 上下文、非 reasoning、零成本）。对于 Anthropic 协议的模型，描述模型自身请求特性的 `compat` 标记（如 `forceAdaptiveThinking`、`supportsStrictTools`）也会一并复制；网关/会话路由类标记则有意不复制。

新增流程不再预先询问 compat：pi 文档要求 compat 标记描述已验证的差异，所以改为在中转站确实拒绝某个字段时，由测试面板给出对应的标记。

### `/provider local`

选择 Ollama（`localhost:11434/v1`）、LM Studio（`localhost:1234/v1`）或 vLLM（`localhost:8000/v1`），已安装的模型会列出并默认勾选。本地供应商会写入一个占位 API key，因为 pi 只显示凭据可解析的供应商的模型。端口可在汇总页修改。

### `/provider models`

每个供应商一张清单：已配置的模型默认勾选；中转站列出但尚未配置的模型默认不勾选，标 `new`；已配置但中转站不再列出的模型标 `not listed by relay`。取消勾选即移除，勾选即添加，最后确认 `+`/`-` 差异。

新增的模型从 pi 官方目录补全元数据；已有条目和手动修改过的元数据原样保留，不取消勾选的模型不会被删除。内置供应商本身已有的模型不会显示为 new。请求目录时使用该供应商已保存的 key 和请求头。仅覆盖 `baseUrl` 的代理在没有 API 协议时不能添加模型，但已经配置的自定义模型仍然可以移除。

供应商页面上的 **Sync metadata from pi's catalog** 会将所有已配置模型重新与官方目录匹配，写入前展示字段级 diff（`model: field 旧值 → 新值`）。只更新目录管理的字段（`reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`cost`、`compat`）；id、自定义 `name`、`api` 和未知字段都会保留，匹配不到官方目录的模型原样保留。

### `/provider test`

所有检查在同一个实时面板里进行——spinner 原地变成 ✓/✗，Esc 中断请求，关闭面板后聊天记录中不留痕迹：

- **Catalog 探测**——尝试模型目录端点，能列出模型即视为健康；拿不到列表则回退成普通 HTTP 请求按状态码判断
- **Chat 测试（模型 id）**——每个模型一行，通过 pi 自己的模型注册表发送：一句要求只回一个词的系统提示加 `"hi"`，最多 16 个输出 token，OpenAI 系协议的 reasoning 模型开启 reasoning。通过的行显示延迟（6 秒起标为警告色）；失败的行显示 HTTP 状态码和中转站返回的错误信息。注册表里还找不到的模型，改用相同凭据手工构造的最小请求

同时最多发 4 个 chat 请求（几十个请求一起打过去，中转站只会回 429，看着像真的失败）；排队中的行显示为 `○ … queued`。检查上方的提示会说明没有解析到 API key 的情况（例如当前 shell 没有设置 `$ENV_VAR`），或 key 是 `!command`（catalog 探测不会执行它）。测试结束后：

| 按键 | 作用 |
|---|---|
| ↑↓ / 回车 | 把当前会话切换到一个通过的模型 |
| `c` | 写入报错指向的 compat 标记，并重测失败的模型 |
| `x` | 从 `models.json` 移除失败的模型（先确认） |
| `s` | 选择要测试的模型 |
| `r` | 重新运行 |

仅覆盖 `baseUrl` 的代理只做 catalog 探测——它们的对话走内置供应商。

### `/provider proxy`

只想让某个**内置**供应商（`anthropic`、`openai`、`google`、`openrouter`、`deepseek`、`xai`、`mistral`、`groq`、`minimax`、`minimax-cn`、`kimi-coding`、`zai`、`zai-coding-cn`，或自行输入其他 id）改走中转站时用这个：选择供应商，填中转站 base URL，可选填 key（留空继续用 `/login` 或环境变量鉴权），在汇总页确认后 **Save and test**。如果该供应商已有自定义模型，汇总页可以选择保留或删除。

pi 取凭据的顺序是：`--api-key`、`/login` 存的凭据（`auth.json`）、`models.json` 里的 `apiKey`、环境变量。所以如果你对该供应商做过 `/login`，中转站收到的是那个凭据，这里填的 key 不会被使用。汇总页、供应商页面和测试面板都会提示这一点；中转站有自己的 key 时，用 `/logout` 删除该凭据。

### `/provider path`

在编辑器中打开 `models.json`。JSON 无效时会带着错误信息和你的修改重新打开编辑器；有效的修改确认后原样保存，注释和格式都保留。

## 配置文件示例

`/provider add` 保存后，`~/.pi/agent/models.json` 大致长这样：

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

以下字段命令本身不会生成，但 `models.json` 支持，可按需手动补充：`authHeader`、`headers`、`modelOverrides`、`oauth`。

保存后在测试面板里对通过的模型按回车即可切换，也可以之后用 `/model` 选择；无需重启 pi。

## 文件结构

```
pi-provider/
├── index.ts                  # 注册 /provider：参数解析、补全、路由
├── flows/
│   ├── home.ts                # 供应商列表、供应商选择器、models.json 编辑器
│   ├── provider.ts            # 供应商页面：就地编辑字段、删除
│   ├── add.ts                 # 新增中转站 / 本地服务：向导 + 汇总页
│   ├── proxy.ts               # 让内置供应商走中转站
│   ├── models.ts              # 合并模型清单、手动添加 id、目录元数据同步
│   ├── test.ts                # 测试面板流程：注册表 chat 测试、compat 修复、移除失败模型、切换模型
│   ├── fields.ts              # 每个供应商字段一个输入界面（新增、汇总页、供应商页面共用）
│   └── shared.ts              # 鉴权解析、注册表刷新、元数据补全、写入助手
└── lib/
    ├── types.ts               # ProviderApi / ModelEntry / ProviderConfig 等类型与文案
    ├── models-json.ts         # 读写 models.json（兼容 JSONC、原子写入、0600 权限收紧）
    ├── detect-api.ts          # GET /v1/models 探测、连通性测试、备用 chat ping
    ├── official-catalog.ts    # 从 pi 运行中的模型注册表取官方目录，做 id 匹配与元数据补全
    ├── model-management.ts    # 模型 diff/merge/refresh 不变量
    ├── compat-hints.ts        # 把中转站报错映射到能修复它的 compat 标记
    ├── test-history.ts        # 每个供应商最近一次测试结果（仅本次会话）
    ├── row-menu.ts            # 对象页面的行列表：列对齐、按行生效的快捷键、提示行
    ├── loop-ui.ts             # 循环滚动 select/editor、带预填的输入框、向导步骤机、spinner
    ├── checks-panel.ts        # ✓/✗ 实时检查面板，含延迟、选择模型与测试后操作
    ├── checkbox-select.ts     # 基于 pi-tui SettingsList 的 [x]/[ ] checklist 多选
    └── testing/tui-harness.ts # 测试中用脚本按键驱动 ui.custom 界面
```

运行 `npm test`（Node 22+）执行测试：覆盖各组件（checklist、行列表、输入框、测试面板）、向导步骤机、模型 diff/merge 不变量、compat 提示，以及 TUI 模式下用脚本按键跑完整流程（新增 → 汇总 → 保存 → 测试 → 切换模型、compat 修复后重测、在供应商页面修改 key）和 RPC 模式下的流程。

## 注意事项

- models.json 路径与 pi 本体一致，尊重 `PI_CODING_AGENT_DIR` 环境变量；默认为 `~/.pi/agent/models.json`
- 与 pi 一致，本扩展接受 `models.json` 中的 `//` 注释与尾逗号——但重写文件时它们会被移除（会写入的界面在文件含注释时会提示）
- 模型元数据直接取自 pi 运行中的模型注册表（`ctx.modelRegistry`），任何安装方式都能补全；万一注册表为空，所有模型回退默认元数据，不影响正常使用，只是展示的上下文 / 价格不准确
- 每次写入后会重新加载注册表（不联网），`/model` 和模型切换立即能看到改动
- 各子命令需要可弹对话框的 UI（`ctx.hasUI`：TUI 或 RPC 宿主均可）。RPC 模式下列表退化为 select，模型清单退化为编辑器版 on/off 列表，测试面板以一条通知报告结果，面板按键（切换模型、compat 修复、移除失败模型）不可用。完全非交互环境会直接报错并打印 `models.json` 路径

## License

MIT（见 [LICENSE](LICENSE)）
