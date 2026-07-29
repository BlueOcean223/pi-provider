# pi-provider

[English](README.md) | **简体中文**

Pi（[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）扩展：提供交互式 `/provider` 命令，一步步问答即可管理自定义供应商（中转站 / 代理 / 本地 OpenAI 兼容服务），直接读写 `~/.pi/agent/models.json`，不用手写 JSON。

## 特性

- 全程问答式交互（选择 / 输入 / 编辑器 / 确认框），不用记参数
- API 协议手动四选一，不做猜测：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses、Google Generative AI
- 可从中转站 `GET /v1/models` 拉取模型列表并多选（与 pi 内置设置列表同款 UI：`→` 光标、`on`/`off`、输入即搜索、Enter/Space 切换）
- 自动对齐 **pi 官方模型目录**，为选中模型补全 `contextWindow`、`maxTokens`、`reasoning`、`thinkingLevelMap`、`cost` 等元数据；匹配不到则回退默认值（128k 上下文）
- 转发 Anthropic 模型级 `compat` 标记（如 Claude Opus/Sonnet 4.6 的 `forceAdaptiveThinking`），让中转副本与官方端点以相同方式协商 thinking
- 可扫描已有中转站后来新增的模型，一键全部添加或多选添加，也可移除已配置的自定义模型（`/provider models`）
- 可将已配置模型与 pi 官方目录重新对齐（`/provider models` → **Refresh metadata**）——同步上游修复（如新增 `compat` 标记），不影响 id、自定义名称和手动添加的字段
- 支持只改内置供应商的 `baseUrl`（代理模式），无需重建整份配置
- 内置连通性探测（`/provider test`）
- 写入的 `models.json` 采用原子写入（临时文件 + rename），并尽量收紧权限到 `0600`
- 无生产依赖：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 由 pi 运行时提供，装好 pi 即可用

## 安装

先克隆本仓库（下面各方式都假定当前目录就是克隆下来的 `pi-provider/`）：

```bash
git clone https://github.com/BlueOcean223/pi-provider.git
cd pi-provider
```

**方式 A — 软链到全局 extensions（开发推荐）**

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)" ~/.pi/agent/extensions/pi-provider
```

然后重启 pi，或在会话里执行 `/reload`。

**方式 B — 临时加载**

```bash
pi -e "$(pwd)/index.ts"
```

**方式 C — pi package（可选）**

```bash
pi install file:"$(pwd)"
# 或以后发布后: pi install npm:pi-provider
```

## 用法

在 pi 会话里输入（子命令支持 Tab 补全）：

| 命令 | 作用 |
|------|------|
| `/provider` | 打开主菜单，列出全部子命令 |
| `/provider add` | 新增一个自定义供应商 |
| `/provider models [provider-id]` | 为已有供应商发现、手动添加或移除模型（别名 `add-models`） |
| `/provider proxy` | 只改内置供应商的 `baseUrl`（中转已有供应商） |
| `/provider list` | 列出已保存的自定义供应商，选中可查看完整 JSON |
| `/provider remove` | 删除一个供应商（别名 `rm`） |
| `/provider test` | 探测供应商端点连通性（别名 `probe`） |
| `/provider path` | 查看 `models.json` 的路径与内容预览 |

### `/provider add` 交互流程

1. **Provider id** — 如 `my-relay`；自动转小写并只保留 `[a-z0-9_-]`，已存在时会询问是否覆盖
2. **Base URL** — 中转站根地址，自动去掉结尾斜杠
3. **API protocol** — 手动四选一（不自动推断）：
   1. **OpenAI Chat Completions**（`openai-completions`）— 绝大多数中转站
   2. **Anthropic Messages**（`anthropic-messages`）
   3. **OpenAI Responses**（`openai-responses`）
   4. **Google Generative AI**（`google-generative-ai`）
4. **API key** — 三选一：
   - 明文写入 `models.json`
   - 引用环境变量（如 `$MY_RELAY_API_KEY`，运行时读取，不落盘明文）
   - 跳过，之后用 `/login` 或 `--api-key`
5. **Models** — 三选一：
   - **Fetch from GET /v1/models then multi-select**：请求中转站的模型 catalog（OpenAI 风格 `{ data: [{ id }] }`，与聊天协议无关；会按 `baseUrl` 是否已含 `/v1` 依次尝试 `{baseUrl}/v1/models`、`{baseUrl}/models`、`{baseUrl}/api/v1/models`），拉到后进入多选列表
   - 手动输入 model id（逗号或换行分隔；输入多个时同样会进入多选预览）
   - 留空占位（写入 `default-model`，之后手动编辑 `models.json`）

   每个选中的 model id 都会尝试匹配 **pi 官方模型目录**（直接取自 pi 运行中的模型注册表，因此 npm / pi-node / bun 二进制等各种安装方式都能用，且包含 pi 的远程目录刷新结果）：匹配到则复制官方的 `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` 等字段（`id` 仍然用中转站自己的），匹配不到则用默认值（128k 上下文、非 reasoning、零成本）。对于 Anthropic 协议的模型，描述模型自身请求特性的 `compat` 标记（如 `forceAdaptiveThinking`、`supportsStrictTools`）也会一并复制；网关/会话路由类标记则有意不复制。
6. **Compat preset**（仅 OpenAI 系协议出现）：
   - 无（默认）
   - Local / strict OpenAI-compat（关闭 `developer` role 与 `reasoning_effort`）
   - 国内中转安全默认（关闭 `developer` role）
7. **Display name**（可选）
8. 预览即将写入的 JSON，确认后落盘到 `~/.pi/agent/models.json`

### `/provider models`

中转站后来支持了更多模型时使用。执行 `/provider models` 后选择供应商，也可以用 `/provider models my-relay` 直接进入：

1. 选择 **Discover and add new models** 拉取中转站目录、手动输入 model id、选择 **Refresh metadata from official catalog** 刷新元数据，或选择 **Remove configured models** 移除模型
2. 按 model id 精确比较远端目录和该供应商当前配置
3. 发现新模型后，可一键全部添加，也可以进入支持搜索的多选列表
4. 新条目继续从 pi 官方目录补全元数据，写入前显示 `+ model-id` 增量预览
5. 移除同样使用支持搜索的多选列表，并显示明确的 `- model-id` 二次确认；只删除该供应商 `models` 中的自定义条目

模型发现仍然只增不删：已有模型条目及手动修改过的元数据会原样保留，重复 id 会跳过，本次远端没有返回的模型绝不会自动删除；请求目录时会尽量复用供应商已解析的 API key 与请求头。只有显式选择移除时才会删除条目。每次确认后都会重新读取文件，以保留交互期间产生的其他配置修改。仅覆盖 `baseUrl` 的代理在没有明确 API 协议时不能添加模型，但如果已经存在自定义模型条目，仍然可以移除。

**Refresh metadata** 将该供应商下所有已配置模型与 pi 运行的官方目录重新匹配，写入前展示字段级 diff（`model: field 旧值 → 新值`）。只更新目录管理的字段（`reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`cost`、`compat`）；id、自定义 `name`、`api` 和未知字段都会保留，匹配不到官方目录的模型原样保留。适合同步上游目录修复——例如早期添加、缺少 `compat` 转发的 Claude 模型可以借此补上 `forceAdaptiveThinking`，无需重新添加。

### `/provider proxy`

只想让某个**内置**供应商（`anthropic`、`openai`、`google`、`openrouter`、`deepseek`、`xai`、`mistral`、`groq`、`minimax`、`minimax-cn`、`kimi-coding`、`zai`、`zai-coding-cn`，或自行输入其他 id）改走中转站、又不想动它模型列表时用这个：

1. 选内置供应商 id（或选 "Other" 手动输入）
2. 填中转站 `baseUrl`
3. 可选是否顺便设置 `apiKey`（否则继续用 `/login` 或环境变量鉴权）
4. 若该供应商已有自定义 `models`，会询问是否保留

### `/provider test`

选择一个已保存的供应商（配置了多个模型时再选一个模型），两项检查会在同一个实时面板里并发进行——spinner 原地变成 ✓/✗，Esc 可中断请求，关闭面板后聊天记录中不留任何痕迹：

- **Catalog 探测**——尝试模型 catalog 端点，能列出模型即视为健康；拿不到列表则回退成普通 HTTP 请求按状态码判断
- **Chat 测试**——用该供应商配置的协议真实发送一条最小的 `"hi"` 请求，与中转站面板（one-api / new-api）测试渠道的方式一致；仅 baseUrl 代理或没有自定义模型的供应商会跳过

若 `apiKey` 是 `$ENV_VAR` 引用但对应环境变量未设置（或是 `!command` 形式——这里不会执行命令），面板内会标注并以无鉴权方式测试。面板内按 `r` 可重新运行检查。

### `/provider list` / `/provider remove` / `/provider path`

- `list`：按 `id · baseUrl · api · N model(s)` 摘要列出，选中查看只读 JSON
- `remove`：同样从摘要列表中选择，二次确认后删除
- `path`：显示 `models.json` 的绝对路径及内容预览（最多 2000 字符；文件不存在或解析失败会显示原因）

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

写完后执行 `/model` 选择模型即可（打开 `/model` 会重新读取配置，无需重启 pi）。

## 文件结构

```
pi-provider/
├── index.ts                  # 注册 /provider 命令与各子命令交互流程
└── lib/
    ├── types.ts               # ProviderApi / ModelEntry / ProviderConfig 等类型与文案
    ├── models-json.ts         # 读写 models.json（兼容 JSONC、原子写入、0600 权限收紧）
    ├── detect-api.ts          # GET /v1/models 探测与连通性测试
    ├── official-catalog.ts    # 从 pi 运行中的模型注册表取官方目录，做 id 匹配与元数据补全
    ├── model-management.ts    # 计算新增模型并执行显式的模型增删更新
    ├── loop-ui.ts             # 循环滚动 select/editor、向导步骤机、spinner 助手
    ├── checks-panel.ts        # /provider test 使用的 ✓/✗ 实时检查面板
    └── checkbox-select.ts     # 与 pi SettingsList 一致的多选 UI
```

运行 `npm test`（Node 22+）执行测试（向导步骤机、模型 diff/merge 不变量、chat ping 的 URL/协议逻辑）。

## 注意事项

- models.json 路径与 pi 本体一致，尊重 `PI_CODING_AGENT_DIR` 环境变量；默认为 `~/.pi/agent/models.json`
- 与 pi 一致，本扩展接受 `models.json` 中的 `//` 注释与尾逗号——但重写文件时它们会被移除（确认框里会提示）
- 模型元数据直接取自 pi 运行中的模型注册表（`ctx.modelRegistry`），任何安装方式都能补全；万一注册表为空，所有模型回退默认元数据，不影响正常使用，只是展示的上下文 / 价格不准确
- 各子命令需要可弹对话框的 UI（`ctx.hasUI`：TUI 或 RPC 宿主均可）；RPC 模式下模型多选会退化为编辑器版 on/off 列表。完全非交互环境会直接报错并打印 `models.json` 路径

## License

MIT（见 [LICENSE](LICENSE)）
