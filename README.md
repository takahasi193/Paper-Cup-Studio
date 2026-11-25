# Paper Cup Studio

> [!IMPORTANT]
> **开发中（Active Development / Work in Progress）**：本项目目前仍处于积极开发与架构演进阶段，**暂不提供面向终端用户的预编译发行版（Releases 已暂缓发布）**。当前源码主要用于开发者本地调试、个人学习与视觉小说本地化工程研究，配置项、工具契约与工作区内部结构仍可能随后续迭代调整。

**Paper Cup Studio** 是面向视觉小说（Visual Novel）本地化工程设计的多 Agent 协作桌面与 Web 工作台。它采用 **Node.js / TypeScript Agent 核心服务端 (`server/`) + React 19 Studio Web 工作台 (`web/`) + 纯 TypeScript 确定性 VN 领域引擎 (`server/src/vn/`)** 的分层架构，将“确定性的工程计算”与“智能体的推理编排”清晰解耦，覆盖封包探测与解包、双轨文本分类、角色译名锁定、分批翻译、确定性 QA、字库补字与字符集适配、增量汉化补丁组装、隔离沙箱冒烟测试及发布说明生成的完整本地化工作流。

---

## 设计理念

- **确定性核心与智能体分离**：归档解析、轨道分类、占位符/控制符 QA、原子写回、增量补丁组装、字体缺字审计与冒烟沙箱均由纯 TypeScript 确定性模块执行，保证可重复性与安全性；智能体只负责调度工作流、语境翻译、术语校准、未知封包逆向分析与多模态截图缺陷审查。
- **最小侵入与原件保护**：默认输出轻量化增量补丁包（`<workspace>/patch/` 与独立装卸脚本），所有测试与写回验证均在隔离沙箱或副本中执行，绝不擅自覆写用户原始游戏目录。
- **可扩展的社区技能生态**：遇到未内置加密、保护标志或特殊脚本封装的引擎时，可通过逆向子代理沉淀经过闭环验证的自包含引擎技能包，按标准规范复用与共享。

---

## 核心功能特点

### 1. 确定性视觉小说工程管线 (`server/src/vn/`)
- **内置容器扫描与解包 / 回封**：内置支持 **Ren'Py RPA**（`2.0`/`3.0`/`3.2`）、**Kirikiri XP3**（`basic`/`extra`）、**PE+ZIP**（自解压/复合资源包）与 **NScripter NSA**。
- **剧情 / 界面双轨分类与批次规划**：严格区分 `scenario`（对白/旁白/选项）与 `ui`（系统界面/菜单/按钮）文本轨；结合活跃模型上下文窗口预算自动切分批次并管理本地检查点（`vn_checkpoint`）。
- **交互式角色译名锁定**：自动抽取候选人名并推送可视化确认表单，锁定角色译名、称呼与人设后注入后续批译与校验链路，避免全篇人称与译名漂移。
- **确定性 QA 与原子增量补丁 (`vn_writeback`)**：
  - 自动校对控制符/标签、Ruby 注音结构、占位符、假名残留与术语表一致性。
  - 写回前执行全检与 QA 门禁，默认在工作区 `<workspace>/patch/` 生成增量补丁、`patch_manifest.json`、使用说明及跨命令行一键装卸批处理（`install_patch.bat` / `uninstall_patch.bat`）。
  - 内置**防缩水替换硬拦截**：当 `action="replace"` 覆盖原始大封包且新封包体积异常缩水时直接阻断，防止部分解包导致游戏媒体资源丢失。

### 2. 逆向工程子代理与社区引擎技能生态 (`reverser` + `skills/`)
- **四阶段逆向漏斗与专用工具链 (`vn-reverser`)**：
  - `vn_re_inspect`：静态分诊、PE IAT（含字体与编码相关 Win32 API）、RTTI、交叉引用与邻域反汇编。
  - `vn_re_lookup`：受控白名单只读检索开源逆向仓库与技术规格文档。
  - `vn_re_trace`：在隔离只读硬链接沙箱中通过 Win32 Debug API 执行 `io_trace` 与 `DR0` 硬件读观察点追踪。
- **受保护变体覆盖与闭环学习 (`vn_learn_skill`)**：
  - 支持对内置格式受保护/加密变体注册项目级覆盖技能（`override_builtin`），并支持针对超大封包（`> 64 MiB`）使用同后缀同魔数的真实子集样本进行头部魔数锚定与往返校验。
  - 学习验证按文本文件后缀分组执行变长微改写回与二次重抽闭环检查，防止辅助脚本通过而主剧本存在等长写回锁的问题。
- **三层技能发现与安全审计 (`skills/README.md`)**：
  - 支持 `workspace > global > repo` 三层优先级发现；对用户全局与仓库内置技能的 `SKILL.md` 及 `.py` 脚本强制执行 LF 规范化 SHA-256 完整性校验。
  - 提供 `scripts/validate-skills.mjs` 进行包结构、Schema、敏感路径及 Python AST 静态安全审计，并支持通过 `vn_promote_skill` 脱敏导出可共享技能包（仓库已内置示例 [`skills/engine-nexas-pacf`](./skills/engine-nexas-pacf/)）。

### 3. CJK 字库原位补字、GBK 字符集适配与通用 Win32 Proxy DLL (`server/native/win32-proxy/`)
- **随附字库缺字审计与原位补字 (`vn_patch_font`)**：自动扫描游戏随附字体（`.ttf`/`.otf`/`.ttc`）对目标译文的覆盖度，并通过隔离 `fontTools` 管线原位补齐缺失中文字形；支持无 DLL 场景下的全角码位重映射兜底模式。
- **Phase 2 通用 Win32 代理 DLL（`version.dll` / `winmm.dll`）**：
  - 零外部 C 运行库（CRT）依赖的纯 Win32 实现，同时支持 `x86`（PE32）与 `x64`（PE32+）。
  - 由 `papercup_patch.ini` 驱动在运行时安全拦截并转换 `CP932 -> CP936 (GBK)` 与 `SHIFTJIS_CHARSET (0x80) -> GB2312_CHARSET (0x86)`，解决非 Shift-JIS 汉字在日文引擎中的宽度重叠与乱码问题，并在无预编译 DLL 时平滑回退。

### 4. 隔离沙箱运行时冒烟测试与前置探针 (`vn_smoke_test`)
- **批译前微改冒烟门禁**：在全量批译前自动注入单条/多行可控中文探针并隔离运行，验证自定义技能的“写回 -> 重封包 -> 游戏实际加载”链路是否真正跑通。
- **多维度自动化巡检**：在隔离硬链接副本沙箱中自动拉起游戏主程序（智能降权排除安装器、启动器与卸载器，并避开模板测试脚本），采集 Win32 错误弹窗、进程异常退出、D3D9 截图（含纯黑静帧检测）、Textractor 文本钩子乱码核验以及多模态视觉模型缺陷审查。

### 5. 多厂商模型适配、双模翻译路由与上下文工程
- **多厂商支持与自动探测**：支持 Google AI Studio (Gemini)、Anthropic (Claude)、OpenAI、DeepSeek、OpenRouter、xAI (Grok)、ModelScope、火山方舟（Volcengine Ark）、SiliconFlow、Groq、Moonshot、MiniMax 及本地 OpenAI 兼容网关，支持 API Key 自动识别、实况 `/models` 拉取与按模型分档降思兼容。
- **云端批译 / 本地 `local_mt` 双模路由**：
  - 云端高并发 Subagent 批译与译后并行语义校对（`role-checker`）。
  - 本地翻译路由支持 Ollama、LM Studio、llama.cpp、vLLM 等本地兼容端点，程序侧自动剥离/还原控制符、启用 TM 翻译记忆去重，仅将 QA 失败条目按需升舱至云端模型精准修复，并支持本机 Ollama 后台受管运行。
- **三层上下文压缩与跨会话交接**：内置 `/compact`（工具输出批折叠 + 领域定制摘要与检查点留档）与工作区持久化交接日志（`.papercup/data/logs/`），支持长流程中断续跑与工作区进度的跨会话延续。

### 6. Paper Cup Studio Web 工作台 (`web/`)
- 基于 React 19 + Vite + Tailwind CSS + Lucide Icons + GSAP 打造的「纸 / 夜」OKLCH 双主题编辑室风交互界面。
- 支持主会话与交互式子代理的多模态图片附件（粘贴、拖拽、选图、模态预警与 Lightbox 放大预览）、运行中实时插话（Steer）与排队队列（Follow-up）、子代理实时思维与工具轨迹可观测面板、工程画像遥测仪表盘以及跨工作区历史浏览。

---

## 环境要求

- **Node.js**：`>= 22.19.0`
- **Python 3**（可选）：执行自定义引擎技能脚本（`unpack.py` / `repack.py` / `extract.py` / `apply.py`）、`vn-reverser` 静态/动态辅助工具及 `fontTools` 字体补字时需要。
- **Git**（推荐）：用于工作区文本检查点快照。
- **MSVC 或 MinGW-w64**（可选）：仅在需要自行本地编译 `server/native/win32-proxy/` 下的 `x86` / `x64` 代理 DLL 时需要。

---

## 从源码运行与构建

### 快速启动

```powershell
# Windows（也可直接双击根目录 Start-PaperCup.bat）
.\Start-PaperCup.bat
```

```bash
# macOS / Linux
chmod +x ./start-papercup.sh
./start-papercup.sh
```

```bash
# 或直接使用根目录 npm 脚本
npm start          # 自动检查依赖与构建产物并启动服务
npm run dev        # 以热更新开发模式同时启动 server (3100) 与 web (5173)
```

> 常用启动参数：`--dev`（开发热更新）、`--rebuild`（强制重编译）、`--no-open`（不自动打开浏览器）、`--port=3100`、`--workspace=E:\VisualNovels\MyGame`。

### 手动安装依赖与测试验证

```powershell
# 1. 安装服务端与前端依赖
npm run setup

# 2. 复制环境变量模板（可选，也可启动后在 Web 设置页粘贴 Key）
copy .env.example .env

# 3. 类型检查、构建与全量离线测试
npm run typecheck
npm run build
npm test

# 4. 校验内置社区技能包结构、SHA-256 与 Python AST 安全规范
node scripts/validate-skills.mjs

# 5.（可选）在 Windows 下编译 Win32 Proxy DLL（需 MSVC 或 MinGW-w64）
node server/native/win32-proxy/build.mjs --arch=all
```

---

## 目录结构

```text
paper-cup/
├── Start-PaperCup.bat          # Windows 一键启动入口
├── start-papercup.sh           # macOS / Linux 一键启动入口
├── package.json                # 根目录统一构建、测试与启动脚本
├── scripts/
│   ├── start.mjs               # 跨平台统一启动器与构建新鲜度检查
│   └── validate-skills.mjs     # 社区技能包 Schema、完整性与 Python AST 安全校验器
├── skills/                     # 仓库内置自包含引擎技能包（含规范说明与示例技能）
├── server/
│   ├── native/win32-proxy/     # 零 CRT 依赖的通用 Win32 代理 DLL 源码与构建脚本
│   ├── bench/reverser/         # Reverser 子代理合成基准评测套件
│   ├── src/
│   │   ├── agent/              # AgentService、System Prompt、批次编排、上下文压缩与工具集
│   │   ├── api/                # Hono REST / SSE 服务与静态托管
│   │   ├── security/           # 凭据隔离、工作区与技能白名单、脚本静态扫描与自动回滚
│   │   ├── subagents/          # 子代理管理器、角色定义与内置 vn-reverser 逆向技能
│   │   └── vn/                 # 纯 TypeScript 确定性 VN 引擎核心与沙箱冒烟/补丁管线
│   └── tests/                  # 服务端集成、契约与安全不变量测试套件
└── web/                        # React 19 + Vite + Tailwind CSS + GSAP Web 工作台
```

---

## 安全边界与使用声明

1. **凭据隔离与输出脱敏**：本地 API Key 保存在本机 `~/.papercup/auth.json`，所有内置工具严禁读取 `.env`、`~/.papercup/auth.json` 等凭据文件；接口响应、聊天记录与落盘日志均执行脱敏与大容量转存。
2. **工具级纵深沙箱守卫**：`read` / `edit` / `write` / `ls` / `find` 均受活跃工作区（及显式授权的只读技能目录）边界约束；`bash` 在执行内联脚本或工作区本地脚本（`.py` / `.ps1` / `.js` / `.vbs` / `.bat` / `.cmd`）前执行静态扫描，拦截越界写删、宿主机进程操控及宿主机目录/进程探测。
3. **原始游戏资产只读保护**：工作区内的原始游戏归档、可执行文件与原始字库均受快照保护与自动回滚防线约束。
4. **个人学习用途声明**：本仓库不包含任何受版权保护的游戏文件、商用字库或破解工具。所有本地化流程、补丁输出与逆向技能研究仅限于个人学习与技术研究用途。

---

## 致谢与开源参考（Acknowledgements）

Paper Cup Studio 的构建离不开以下优秀的开源项目与视觉小说逆向工程社区贡献：

### 核心 Agent 运行时
- **[Pi (`earendil-works/pi`)](https://github.com/earendil-works/pi)**（`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`，作者 Mario Zechner，MIT License）—— 为本项目提供了底层 Agent 事件循环、多模型统一接入、会话状态管理及上下文压缩扩展机制。

### 视觉小说逆向工程与本地化开源贡献
- **[Dir-A](https://github.com/Dir-A)** — **[`Dir-A/Dir-A_Essays_MD`](https://github.com/Dir-A/Dir-A_Essays_MD)** 与 **[`Dir-A/ReVN`](https://github.com/Dir-A/ReVN)** —— 衷心感谢 Dir-A 在视觉小说 / Galgame 逆向工程方法论（Win32 API 断点、硬件写观察点追踪、封包分层分诊与指令/文本分离写回架构）以及多引擎解包/回封、VFS Hook 实践上的系统化开源贡献，直接启发了 Paper Cup 内置 `vn-reverser` 逆向漏斗与方法论规范。
- **[`morkt/GARbro`](https://github.com/morkt/GARbro)** & **[`crskycode/GARbro`](https://github.com/crskycode/GARbro)** —— 经典的视觉小说归档与资源格式开源解析库，为常见容器结构核验提供了重要的格式参考。
- **[`arcusmaximus/VNTranslationTools`](https://github.com/arcusmaximus/VNTranslationTools)** —— 多引擎视觉小说脚本提取与文本写回工具的重要开源参考。
- **[`regomne/chinesize`](https://github.com/regomne/chinesize)** —— 在视觉小说中文化补丁、Win32 Hook 与字符集适配领域提供了宝贵的工程实践参考。
- **[`YuriSizuku/GalgameReverse`](https://github.com/YuriSizuku/GalgameReverse)** —— 视觉小说逆向脚本、字库处理与引擎分析的社区开源参考集合。

### 核心框架与可选辅助工具生态
- **服务端与前端基础设施**：[Hono](https://github.com/honojs/hono)、[TypeBox](https://github.com/sinclairzx81/typebox)、[React](https://github.com/facebook/react)、[Vite](https://github.com/vitejs/vite)、[Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)、[GSAP](https://github.com/greensock/GSAP)、[Lucide Icons](https://github.com/lucide-icons/lucide)。
- **可选本地推理与运行时工具链**：[Ollama](https://github.com/ollama/ollama)、[fontTools](https://github.com/fonttools/fonttools)、[Textractor](https://github.com/Artikash/Textractor)、[Locale Emulator](https://github.com/xupefei/Locale-Emulator)。

---

## 开源协议

本项目基于 [LICENSE](LICENSE) 协议开源。
