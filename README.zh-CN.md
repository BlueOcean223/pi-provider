# pi-provider

[English](README.md) | **简体中文**

Pi（[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）扩展：提供交互式 `/provider` 命令，一步步问答即可管理自定义供应商（中转站 / 代理 / 本地 OpenAI 兼容服务），直接读写 `~/.pi/agent/models.json`，不用手写 JSON。

## 特性

- 全程问答式交互（选择 / 输入 / 编辑器 / 确认框），不用记参数
- API 协议手动四选一，不做猜测：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses、Google Generative AI
- 可从中转站 `GET /v1/models` 拉取模型列表并多选（与 pi 内置设置列表同款 UI：`→` 光标、`on`/`off`、输入即搜索、Enter/Space 切换）
- 自动对齐 **pi 官方模型目录**，为选中模型补全 `contextWindow`、`maxTokens`、`reasoning`、`thinkingLevelMap`、`cost` 等元数据；匹配不到则回退默认值（128k 上下文）
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

   每个选中的 model id 都会尝试匹配 **pi 官方模型目录**（直接取自 pi 运行中的模型注册表，因此 npm / pi-node / bun 二进制等各种安装方式都能用，且包含 pi 的远程目录刷新结果）：匹配到则复制官方的 `contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` 等字段（`id` 仍然用中转站自己的），匹配不到则用默认值（128k 上下文、非 reasoning、零成本）。
6. **Compat preset**（仅 OpenAI 系协议出现）：
   - 无（默认）
   - Local / strict OpenAI-compat（关闭 `developer` role 与 `reasoning_effort`）
   - 国内中转安全默认（关闭 `developer` role）
7. **Display name**（可选）
8. 预览即将写入的 JSON，确认后落盘到 `~/.pi/agent/models.json`

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
    ├── loop-ui.ts             # 循环滚动 select/editor、向导步骤机、spinner 助手
    ├── checks-panel.ts        # /provider test 使用的 ✓/✗ 实时检查面板
    └── checkbox-select.ts     # 与 pi SettingsList 一致的多选 UI
```

运行 `npm test`（Node 22+）执行测试（向导步骤机、chat ping 的 URL/协议逻辑）。

## 注意事项

- models.json 路径与 pi 本体一致，尊重 `PI_CODING_AGENT_DIR` 环境变量；默认为 `~/.pi/agent/models.json`
- 与 pi 一致，本扩展接受 `models.json` 中的 `//` 注释与尾逗号——但重写文件时它们会被移除（确认框里会提示）
- 模型元数据直接取自 pi 运行中的模型注册表（`ctx.modelRegistry`），任何安装方式都能补全；万一注册表为空，所有模型回退默认元数据，不影响正常使用，只是展示的上下文 / 价格不准确
- 各子命令需要可弹对话框的 UI（`ctx.hasUI`：TUI 或 RPC 宿主均可）；RPC 模式下模型多选会退化为编辑器版 on/off 列表。完全非交互环境会直接报错并打印 `models.json` 路径

## License

MIT（见 `package.json`）
