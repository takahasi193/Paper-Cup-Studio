# Paper Cup Studio (`v0.1.0-beta.1`)

> 面向视觉小说（Visual Novel）本地化工程的桌面与 Web Agent 工作台 —— 当前为公开测试版（Beta）。

Paper Cup 采用 **Node.js / TypeScript Agent 核心服务端 (`server/`) + React 19 Studio Web 客户端 (`web/`) + 纯 TypeScript 确定性 VN 核心 (`server/src/vn/`)** 分层架构，专为日本视觉小说的解包探测、术语校准、双轨分批翻译、确定性 QA、增量汉化补丁、运行时冒烟验证与发布说明生成设计。

---

## 核心特性

### 1. API Key 自动识别、本地持久存储与实时模型同步
- 打开顶部/输入栏/设置中的「API Key 与模型同步」，直接粘贴任意支持厂商的 API Key（默认处于 **自动识别** 模式）：
  - **多厂商支持与自动探测**：支持 Google AI Studio (Gemini)、Anthropic (Claude)、OpenAI、DeepSeek、OpenRouter、xAI (Grok)、ModelScope (魔搭)、火山方舟 (Volcengine Ark)、SiliconFlow (硅基流动)、Groq、Moonshot (Kimi)、MiniMax 及本地网关（如 Magpie，支持无密钥模式或访问令牌模式）。
  - **实时受支持模型拉取与过滤**：向官方 `/models` 端点拉取当前账号下真正可用的模型，自动排除非对话模态与已下线模型，并支持自动合成最新对话模型或手填自定义模型 / 接入点 ID。
  - **本地持久化与隔离防泄漏**：凭据持久化保存于本机 `~/.papercup/auth.json`（启动自动恢复，支持按厂商免密一键切换或随时清除）；鉴权探测全程在服务端执行，API Key 永不回显至前端响应或写入聊天历史，所有内置文件/命令行工具均严禁读取本地密钥文件。

### 2. 双模翻译路由与本机 Ollama 后台托管
- **云端 Subagent 批译**：由主模型同源的云端子代理分批翻译 JSONL，适合短篇或一步到位的高质量本地化。
- **本地翻译专用模型 + 确定性交接 (`local_mt`)**：支持 Ollama、LM Studio、llama.cpp、vLLM 等本地 OpenAI 兼容端点，程序侧剥离/还原控制符与引号、启用 TM 翻译记忆去重，仅将 QA 失败行按需升舱至云端主模型精准修复。
- **本机 Ollama 自动检测与后台托管**：支持自动检测本机 Ollama 可执行文件与运行状态、在受管子进程内应用并发与性能优化参数，且不修改宿主机全局环境变量。

### 3. 一键快捷启动体验
- 无需手动分步开启两个终端：支持 Windows 双击批处理、macOS/Linux Shell 脚本及根目录 npm 命令。
- 启动器会自动校验环境（Node.js >= 22.19）、检查依赖与构建产物新鲜度并在需要时自动构建，服务就绪后自动拉起默认浏览器打开工作台。

### 4. Paper Cup Studio 编辑室风交互界面 (`web/`)
- **纸与夜 OKLCH 双主题**：暖象牙「纸」与夜蓝「夜」双色阶浮层架构，支持顶栏一键双态快速切换、设置页三态偏好（跟随系统 / 纸 / 夜）与环境动效开关。
- **高效工作台能力**：
  - **OS 原生目录与文件选择器**：工作区切换及本地工具路径配置支持调起系统原生选择框。
  - **跨工作区会话浏览**：侧边栏底部默认折叠展示「其他工作区」，展开时只读懒加载对应历史对话，支持一键直达切换。
  - **统一实时插话与排队队列**：主会话与交互式子代理运行中均支持实时插话（Steer，`Enter`）与顺延排队（Follow-up，`Alt+Enter`），队列项支持模式切换、撤回编辑、删除与一键清空，中止或出错时未送达指令自动回填输入框。
  - **子代理独立对话与实时可观测视图**：侧边栏可随时切入 `reverser`、`role-checker`、`translator` 等子代理视图，实时追踪流式思考/回复、工具轨迹、落盘产物与热缓存续跑。
  - **完整 GFM Markdown 渲染**：支持围栏代码块高亮头部、一键复制、吸顶响应式表格与严格 URL 安全白名单。
  - **工程画像遥测面板**：实时呈现识别引擎、流水线阶段、CSS 环形批次完成率仪表、快捷工作流触发、实时 Token 消耗明细与本地 Git 检查点。

### 5. 确定性视觉小说引擎 (`server/src/vn/`) 与运行时冒烟测试
- 纯 TypeScript 与 Node 内置模块实现，覆盖：
  - 内置扫描与解包 / 回包：**Ren'Py RPA** (`2.0`/`3.0`/`3.2`)、**Kirikiri XP3** (`basic`/`extra`)、**PE+ZIP**（TyranoBuilder / 自解压等）、**NScripter NSA**；
  - 文本分轨分类（`scenario` / `ui`）、按模型家族预算规划批次、占位符/控制码/假名残留/称呼一致性确定性 QA；
  - 安全写入流（事前全检 → QA 门禁 → 原子替换 → `.bak` 保留）与 `vn_writeback` 增量汉化补丁包生成（附自动装卸脚本与 `patch_manifest.json`，永不覆盖原始游戏目录）；
  - 可选运行时冒烟测试（`vn_smoke_test`，支持在隔离副本沙箱内自动启动补丁后游戏、采集崩溃信息、Textractor 文本钩子乱码校验与多模态截图缺陷审查）、本地 Git 检查点 (`vn_checkpoint`)、验收门禁 (`vn_accept`) 与发布说明生成 (`vn_release`)。
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
# 1. 服务端类型检查、编译与全量离线集成测试
cd server
npm run typecheck
npm run build
npm test

# 2. Web 前端类型检查、测试与生产构建
cd ..\web
npm run typecheck
npm test
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
│   │   ├── agent/          # AgentService、System Prompt、模型探测、本地翻译/Ollama 托管、统一队列与工具
│   │   ├── api/            # Hono REST / SSE 路由及前后端一体静态托管
│   │   ├── security/       # 密钥路径防护、受保护文件回滚、日志脱敏与大容量工具输出转存
│   │   ├── subagents/      # translator / role-checker / reverser 角色、状态机与内置 VN 逆向方法论技能（vn-reverser）
│   │   └── vn/             # 纯 TypeScript 确定性 VN 核心 (archives/classify/qa/patch/smoke/tokens/workflow/core)
│   └── tests/              # 服务端离线集成与契约测试套件
└── web/                    # React 19 + Vite + Tailwind CSS + GSAP Studio Web 工作台
```

---

## 核心不变量与安全边界

1. **凭据隔离与脱敏**：所有内置文件/命令行工具严禁读取 `.env`、`~/.papercup/auth.json` 等本地密钥文件；所有密钥探测与调用在服务端隔离执行，绝不回显至接口响应或写入聊天历史，日志与工具输出自动脱敏。
2. **原始游戏目录只读保护**：解包、分轨翻译、增量补丁包生成 (`vn_writeback`) 与隔离沙箱冒烟测试 (`vn_smoke_test`) 均严禁就地覆盖用户原始游戏档案，注销工作区仅解除注册关联，绝不递归删除磁盘目录。
3. **测试版（Beta）说明**：当前 `v0.1.0-beta.1` 为公开测试版本，面向个人学习与本地化研究使用。如在特定自定义游戏引擎封包或第三方中转网关上遇到兼容问题，欢迎附带工程脱敏日志提交 Issue 反馈。
