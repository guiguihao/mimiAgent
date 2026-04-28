# SmartHomeClaw Agent

基于 Node.js 开发的智能家居 AI 管家，由先进的语言模型驱动，具备自主感知、决策、记忆、工作流编排及多端通信能力。

## 🌟 核心特性

- **🔌 内置 MCP 支持**：内置悠瑞智能家居 MCP、小度 DuerOS MCP、米家 MCP，可无缝扩展任意 MCP Server。支持每个 Server 独立启用/禁用，配置文件支持 `${ENV_VAR}` 环境变量引用。
- **🚀 多平台接入**：通过 `MessengerBridge` 实现飞书（Feishu）等平台的无缝集成，支持流式输出与消息去重。
- **🧩 技能系统 (Skills)**：动态加载 `skills/` 目录下的技能，自动映射为 AI 可直接调用的顶级工具。
  - **知识技能（MD Skill）**：标准 `SKILL.md` 格式（带 YAML 前置参数），AI 读取手册后通过 `cmd_exec` 执行脚本。
  - **内置技能**：`baidu-search`（百度 AI 搜索）、`weather`（天气查询）、`agent-browser`（自动化浏览器）。
- **🔄 工作流引擎 (Workflow)**：AI 可自主编排、持久化管理工作流，工作流定义保存在 `config/workflows/` 目录下的 YAML 文件中，支持：
  - `decide`：AI 自主决策步骤
  - `skill`：直接调用技能
  - `mcp`：直接调用 MCP 工具
  - `condition`：条件分支（if/else）
  - `parallel`：并行执行多个步骤
  - `notify`：广播消息到飞书
  - `wait`：等待指定时间
  - 步骤间变量传递（`${varName}` 模板）
- **🗂️ 工作目录 (Workspace)**：AI 生成的文件（图片、报告、数据）统一保存到 `workspace/` 目录，路径可在 `agent.yaml` 中配置。
- **🧠 长期记忆 (Memory)**：基于本地 Markdown 的结构化记忆。
  - `USER_PROFILE.md`：用户偏好与习惯
  - `FACTS.md`：重要事实记录
  - `ENVIRONMENT.md`：自动同步的环境快照（天气、设备状态）
- **💓 智能巡检 (Heartbeat)**：每个检查项独立定时，支持全局默认间隔与单项自定义间隔。
- **📅 定时任务 (Cron)**：灵活的定时任务管理，支持 AI 自主增删改查。

---

## 📂 目录结构

```text
.
├── config/
│   ├── agent.yaml          # Agent 基础配置、工作目录、系统提示词
│   ├── heartbeat.yaml      # 心跳巡检任务配置（支持单项 interval）
│   ├── cron.yaml           # 定时任务配置
│   ├── plugin.yaml         # 插件参数（飞书、MCPorter 等）
│   ├── mcporter.json       # MCP Server 配置（支持 enabled 和 ${ENV_VAR}）
│   └── workflows/          # 工作流定义目录（每个 .yaml 文件独立加载）
│       └── morning.yaml    # 示例工作流
├── memory/                 # 长期记忆存储（Markdown）
│   ├── USER_PROFILE.md
│   ├── HABITS.md
│   ├── FACTS.md
│   └── ENVIRONMENT.md
├── skills/                 # 技能库
│   ├── baidu-search/       # 百度 AI 搜索技能
│   └── weather/            # 天气查询技能
├── plugin/
│   ├── feishu.js           # 飞书平台适配器
│   └── mcporter.js         # MCP Server 客户端
├── src/
│   ├── agent.js            # 系统主入口
│   └── services/
│       ├── coreagent.js    # 核心 AI 引擎（工具调度、会话管理）
│       ├── workflow.js     # 工作流引擎（含持久化管理）
│       ├── skill.js        # 技能服务
│       ├── memory.js       # 记忆服务
│       ├── scheduler.js    # 定时任务调度器
│       ├── heartbeat.js    # 心跳巡检服务
│       └── messenger.js    # 消息桥接器
├── workspace/              # AI 工作目录（生成的文件、报告等，已 .gitignore）
├── sessions/               # 会话历史与去重缓存（已 .gitignore）
└── .env.example            # 环境变量模板
```

---

## 🛠️ 快速开始

### 1. 安装依赖
```bash
npm install
pip install -r requirements.txt  # 技能脚本依赖内置mcp依赖
```

### 2. 配置环境变量
复制 `.env.example` 到 `.env` 并填写：
```env
NVIDIA_API_KEY=your_key       # 语言模型 API Key
FEISHU_APP_ID=cli_xxxxxxxx    # 飞书应用 ID
FEISHU_APP_SECRET=xxxxxxxx    # 飞书应用密钥
BAIDU_API_KEY=xxxx            # 百度 AI 搜索 Key
XIAODU_ACCESS_TOKEN=xxxx      # 小度 DuerOS Token（可选）
```

### 3. 配置 MCP Server
编辑 `config/mcporter.json`，支持每个 Server 独立控制和 `.env` 变量引用：
```json
{
  "mcpServers": {
    "my-server": {
      "enabled": true,
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "${MY_TOKEN}"
      }
    }
  }
}
```

### 4. 启动 Agent
```bash
npm run dev    # 开发模式（热重载）
npm start      # 生产模式
```

---

## 🔄 工作流系统

工作流定义保存在 `config/workflows/` 目录，**每个 `.yaml` 文件独立加载**，支持多文件管理。

### AI 工作流管理工具

| 工具 | 说明 |
|------|------|
| `workflow_list` | 列出所有已定义的工作流 |
| `workflow_get` | 读取某个工作流的完整定义 |
| `workflow_save` | 创建或更新工作流，**持久化写入 YAML 文件** |
| `workflow_delete` | 从 YAML 文件中删除工作流 |
| `workflow_reload` | 手动编辑 YAML 后重新热加载 |
| `workflow_run` | 执行工作流 |

> **AI 可以自主编排工作流**：告诉 AI 你需要的流程，它会调用 `workflow_save` 生成 YAML 文件并立即可用。

### 手动定义工作流

```yaml
# config/workflows/my_workflow.yaml
workflows:
  - id: "evening_check"
    name: "晚间设备检查"
    steps:
      - id: "query_ac"
        type: "mcp"
        tool: "mcp_ureal-mcp_smarthome_query_device_status"
        params:
          sn: "G042408000066"
          did: 1002
        output: "ac_status"

      - id: "auto_off"
        type: "condition"
        condition: "{{ac_status.Switch}} == 'on'"
        if_true:
          - id: "turn_off"
            type: "mcp"
            tool: "mcp_ureal-mcp_smarthome_control_device"
            params:
              sn: "G042408000066"
              did: 1002
              node: "Switch"
              value: "off"
          - id: "notify"
            type: "notify"
            message: "🌙 晚间巡检：空调已自动关闭。"
        if_false:
          - id: "notify_ok"
            type: "notify"
            message: "✅ 晚间巡检：设备状态正常。"
```

### 步骤类型速查

| type | 说明 | 关键字段 |
|------|------|----------|
| `decide` | AI 自主决策 | `prompt`, `output` |
| `skill` | 调用技能 | `skill`, `params`, `output` |
| `mcp` | 调用 MCP 工具 | `tool`, `params`, `output` |
| `condition` | 条件分支 | `condition`, `if_true[]`, `if_false[]` |
| `parallel` | 并行执行 | `steps[]` |
| `notify` | 飞书广播 | `message` |
| `wait` | 等待 | `ms` |

---

## 💡 常用指令

### 会话管理
| 指令 | 说明 |
|------|------|
| `/new` 或 `/新会话` | 备份并清空当前会话，开启新对话 |
| `/context` 或 `/上下文` | 查看当前会话统计与摘要 |
| `/compress` 或 `/压缩` | 压缩会话历史，节省 Token |

### AI 能力示例
- `"列出当前所有工作流"`
- `"帮我创建一个晚间关灯工作流"`（AI 自动调用 `workflow_save`）
- `"执行工作流 morning_workflow"`
- `"查看 morning_workflow 的详细步骤"`
- `"列出当前所有技能"`
- `"创建一个每天早上 8 点发送新闻的定时任务"`
- `"查询所有设备状态"`

---

## 📡 智能巡检 (Heartbeat)

每个检查项拥有**独立定时器**，支持全局默认间隔与单项自定义间隔：

```yaml
# config/heartbeat.yaml
heartbeat:
  enabled: true
  interval: "*/10 * * * *"   # 全局默认：每10分钟

  checks:
    - name: "环境检查"
      interval: "*/15 * * * *"   # 单独设置（优先级更高）：每15分钟
      prompt: "查询杭州的天气，检查当前智能设备状态数据，并使用 memory_update_environment 更新环境状态记忆。"

    - name: "安全巡检"
      # 未设置 interval，使用全局 */10 * * * *
      prompt: "安全检查：门窗、烟雾、燃气等是否正常？"
```

- 每个 check 的 `interval` 字段**可选**，未设置时使用顶层 `interval`。
- 发现异常时，AI 设置 `"is_warning": true`，系统自动推送告警到飞书。

---

## 🤝 扩展开发

- **添加技能**：在 `skills/` 下新建目录，包含 `SKILL.md` 和执行脚本。
- **添加工作流**：在 `config/workflows/` 下新建 `.yaml` 文件，或直接让 AI 创建。
- **接入 MCP**：在 `config/mcporter.json` 中添加 Server 配置（支持 `enabled`）。
- **添加新平台**：在 `plugin/` 下实现适配器，注册到 `MessengerBridge`。

## 📄 许可证
MIT
