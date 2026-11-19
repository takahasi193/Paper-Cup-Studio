# Paper Cup Studio (`v0.1.0-beta.1`)

> 面向视觉小说（Visual Novel）本地化工程的桌面与 Web Agent 工作台 —— 当前为公开测试版（Beta）。

Paper Cup 采用 **Node.js / TypeScript Agent 核心服务端 (`server/`) + React 19 Studio Web 客户端 (`web/`) + 纯 TypeScript 确定性 VN 核心 (`server/src/vn/`)** 分层架构，专为日本视觉小说的解包探测、术语校准、双轨分批翻译、确定性 QA、安全写回与独立发布设计。

---

## 核心特性

### 1. API Key 自动识别与实时受支持模型加载
- 打开顶部/输入栏/设置中的「API Key 与模型同步」，直接粘贴任意支持厂商的 API Key（默认处于 **自动识别** 模式）：
  - **前缀直认与校验**：`AIza...` (Google AI Studio)、`sk-ant-...` (Anthropic)、`sk-or-...` (OpenRouter)、`sk-proj-...` (OpenAI)、`xai-...` (xAI)、`gsk_...` (Groq)、`ms-...` (ModelScope 魔搭)、UUID (火山方舟 Ark)、`sk-api-` / JWT (MiniMax)。
  - **通用 `sk-` 并发探活**：针对共享 `sk-` 前缀的厂商（如 DeepSeek、OpenAI、SiliconFlow 硅基流动、Moonshot、ModelScope），并发探测各自鉴权/目录接口锁定唯一有效归属。
- **自动剔除过时与非对话模型**：向官方 `/models` 端点实时拉取账号下当前真正可用的模型，并结合服务端与规则库过滤掉已下线、旧代或非对话模态模型（如 `gpt-3.5-*`、`gpt-4` 早期快照、`gemini-1.5-*` / `gemini-2.0-*`、`claude-3-*` / `claude-2.*`、`deepseek-coder`、`moonshot-v1-*`、`embedding` / `rerank` / `tts` / `whisper` / `imagen` / `seedream` / `deep-research` 等）；若官方发布了新版对话模型，会按厂商协议自动合成并接入下拉列表。
- **零明文泄露保证**：鉴权探测全程在服务端完成（Google 使用 `x-goog-api-key` 请求头而非 URL 参数），API Key 永不写入会话记录或回显至前端响应。

### 2. 一键快捷启动体验
- 无需手动分步开启两个终端：支持 Windows 双击批处理、macOS/Linux Shell 脚本及根目录 npm 命令。
- 首次启动会自动检查环境（Node.js >= 22.19）、补齐缺失依赖与构建产物，并在服务就绪后自动拉起默认浏览器打开工作台。

### 3. Paper Cup Studio 编辑室风交互界面 (`web/`)
- **纸与夜 OKLCH 双主题**：暖象牙「纸」与夜蓝「夜」双色阶浮层架构，支持顶栏一键双态快速切换与设置页三态偏好（跟随系统 / 纸 / 夜），结合水彩纸杯电话视觉意象。
- **高效工作台能力**：
  - **OS 原生目录选择器**：工作区切换支持弹窗内点击「浏览…」调起系统原生文件夹选择框并自动切换。
  - **跨工作区会话浏览**：侧边栏底部默认折叠展示「其他工作区」，展开时只读懒加载对应历史对话，支持一键直达切换。
  - **全局命令面板 (`Ctrl+K` / `⌘K`)**：键盘检索工作流、快速打开系统目录浏览、跳转历史会话或控制面板与主题。
  - **完整 GFM Markdown 渲染**：助手流式输出与子代理结果支持围栏代码块高亮头部、一键复制、吸顶响应式表格与安全链接白名单。
  - **工程画像遥测面板 (`Ctrl+.`)**：实时呈现识别引擎、流水线阶段、CSS 环形批次完成率仪表、快捷工作流触发与本地 Git 检查点。

### 4. 确定性视觉小说引擎 (`server/src/vn/`) 与多子代理编排
- 纯 TypeScript 与 Node 内置模块实现，覆盖：
  - 内置扫描与解包 / 回包：**Ren'Py RPA** (`2.0`/`3.0`/`3.2`)、**Kirikiri XP3** (`basic`/`extra`)、**PE+ZIP**（TyranoBuilder / 自解压等）、**NScripter NSA**；
  - 文本分轨分类（`scenario` / `ui`）、按模型家族预算规划批次、占位符/控制码/假名残留/称呼一致性确定性 QA；
  - 安全写入流（事前全检 → QA 门禁 → 原子替换 → `.bak` 保留或 `vn_writeback` 导出独立可运行游戏副本，永不覆盖原始游戏目录）、本地 Git 检查点 (`vn_checkpoint`)、验收门禁 (`vn_accept`) 与发布说明生成 (`vn_release`)。
- 遇到未知加密/封包结构时，主 Agent 可调度 `reverser` 子代理结合逆向工程技能分析并经三重写回验证后沉淀为工作区可复用技能。

---

## 环境要求

- **Node.js**: `>= 22.19.0`（Pi Agent SDK 要求）
- **Python 3**（可选，仅在针对未知自定义引擎生成 Python 解包/回包技能脚本时需要）
- **Git**（推荐，用于本地文本检查点快照）

---

## 快速启动

### 方式一：一键快捷启动（推荐，适合直接试用体验）

- **Windows**：直接双击根目录 [`Start-PaperCup.bat`](Start-PaperCup.bat)，或在终端执行：
  ```powershell
  .\Start-PaperCup.bat
  ```
- **macOS / Linux**：
  ```bash
  chmod +x ./start-papercup.sh
  ./start-papercup.sh
  ```
- **任意平台 npm 命令**：
  ```bash
  npm start
  ```

> 常用启动参数：
> - `--dev`：以热更新开发模式同时拉起 `server`（默认端口 `3100`）与 Vite 前端（`http://localhost:5173`）
> - `--rebuild`：强制重新编译 `server` 与 `web` 后启动
> - `--no-open`：只启动服务，不自动弹出浏览器
> - `--port=3100` / `--workspace=E:\VisualNovels\MyGame`：指定监听端口或初始游戏目录

### 方式二：手动开发调试

```powershell
# 1. 安装 server 与 web 依赖（也可直接在根目录执行 npm run setup）
cd server && npm install
cd ..\web && npm install

# 2. 复制环境变量模板（可选，也可启动后在网页端粘贴 Key 自动识别）
copy .env.example .env

# 3. 并行启动服务端与前端（或直接根目录执行 npm run dev）
cd ..\server && npm run dev
cd ..\web && npm run dev
```

---

## 构建与测试验证

```powershell
# 1. 服务端类型检查、编译与全量离线集成测试（22 项测试，含 VN 引擎全链路与 API Key 自动识别）
cd server
npm run typecheck
npm run build
npx tsx tests/server.test.ts

# 2. Web 前端类型检查与生产构建
cd ..\web
npm run typecheck
npm run build
```

或直接在仓库根目录使用统一脚本：

```bash
npm run typecheck
npm run build
npm test
```

---

## 目录结构

```text
paper-cup/
├── Start-PaperCup.bat      # Windows 双击快捷启动入口
├── start-papercup.sh       # macOS / Linux 快捷启动入口
├── scripts/
│   └── start.mjs           # 跨平台统一启动、依赖检查与自动构建/打开浏览器脚本
├── server/                 # Node.js / TypeScript Agent 核心服务端
│   ├── src/
│   │   ├── agent/          # AgentService、System Prompt、provider-discovery、folder-picker、批处理与工具
│   │   ├── api/            # Hono REST / SSE 路由及前后端一体静态托管
│   │   ├── security/       # 密钥路径防护、日志脱敏与 >16KB 工具输出转存
│   │   ├── subagents/      # translator / role-checker / reverser 角色、状态机与 REA 技能
│   │   └── vn/             # 纯 TypeScript 确定性 VN 核心 (archives/classify/qa/tokens/workflow/core)
│   └── tests/
│       └── server.test.ts  # 22 步离线集成测试
└── web/                    # React 19 + Vite + Tailwind CSS + GSAP Studio Web 工作台
```

---

## 核心不变量与安全边界

1. **凭据隔离与脱敏**：所有内置文件/命令行工具严禁读取本地密钥文件；所有密钥探测与切换在服务端内存中隔离执行，不回显、不写入聊天历史。
2. **原始游戏目录只读**：解包、分轨翻译与独立副本导出 (`vn_writeback`) 均严禁就地覆盖用户原始游戏档案或代码仓库。
3. **测试版（Beta）说明**：当前 `v0.1.0-beta.1` 为公开测试版本，面向个人学习与本地化研究使用。如在特定自定义游戏引擎封包或第三方中转网关上遇到兼容问题，欢迎附带工程脱敏日志提交 Issue 反馈。
