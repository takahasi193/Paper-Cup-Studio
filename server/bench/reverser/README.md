# Paper Cup Reverser Benchmark (`L1` → `L6`)

针对 Paper Cup `reverser` 子 Agent 的由简到难确定性逆向基准评测套件。  
所有题目均为纯程序生成的合成视觉小说二进制样例（零版权素材、零额外依赖），所有评分均为**可执行的硬约束程序化校验（8 项 Gate 全过才算 PASS，零 LLM 主观打分）**。

## 难度梯度（6 题）

| 难度 | 题目 ID | 流水线 | 源编码 | 核心考点 |
|------|---------|--------|--------|----------|
| **L1** | `L1-plain-archive` | `skill` | `utf-8` | 未加密自定义封包 (`VP1\0`)、剧本/JSON UI 分离、注释/命令过滤、栅格 PNG 资产保真 |
| **L2** | `L2-cp932-xor-archive` | `skill` | `cp932` | 双段流式 XOR 封包 (`XPK2`)、`xpk_player.exe` 反汇编、CP932→GBK 变长写回、`<C#RRGGBB>` 自定义控制符注册 |
| **L3** | `L3-halfwidth-kana-direct` | `direct` | `cp932` | 单文件 zlib 二进制剧本 (`BSCR`)、CP932 半角片假名压缩还原全角、`kind_code=9` 内部查找键过滤 |
| **L4** | `L4-obfuscated-msg-trap` | `direct` | `cp932` | 明文诱饵区段 `STR0`（50 条编辑器控件键 + 4 条真 UI）vs 字节混淆真剧情 `MSG1`（40 条），需反汇编 `trial.exe` 找到解码循环 |
| **L5** | `L5-pointer-relocation-vm` | `direct` | `cp932` | `SCRIPT.VM` (`VM01`) 按字节偏移寻址 `TEXT.DAT`；`0x20..0x22` 非文本指令故意携带与真实偏移相等的整数，禁止盲目全局 u32 替换 |
| **L6** | `L6-full-gauntlet` | `skill` | `cp932` | 综合地狱关：双封包 LCG+Zlib (`GPK3`)、`SCB1` (`BCOD` 偏移重定位 + `0x09` 陷阱 + 按索引混淆 `MSGB` + `DBG0` 诱饵)、`UIS1` 键值表、`<ruby .../>` 自定义控制符与栅格 PNG |

## 8 项硬约束门禁（全部 PASS 才算通过）

1. **`G1_SKILL_ADOPTED`**：必须通过 `vn_learn_skill` 采纳并落盘 `engine.json`、`SKILL.md` 及全部脚本，且 `pipeline`、`writeback.verified` 与全部 SHA-256 摘要一致。
2. **`G2_ORIGINAL_UNTOUCHED`**：原始游戏目录下全部文件 SHA-256 100% 未被篡改且无多余文件遗留。
3. **`G3_RESEARCH_ARTIFACTS`**：`.papercup/research/<engine>/` 三阶段研究文档（`01-layout.md`、`02-hypotheses.md`、`03-text-mapping.json`）完整有效。
4. **`G4_EXTRACTION_ACCURACY`**：剧情（`say`）召回率 100%、UI/人名高召回率，且 **0 噪声泄漏**（不得抽出诱饵控件键、内部查找键、注释、资源路径或未还原的半角片假名）。
5. **`G5_IDENTITY_ROUNDTRIP`**：原样写回（+ 回包）并通过对应题目真实的**引擎 / VM 消费端模拟器**逐条核验。
6. **`G6_VARIABLE_LENGTH_ZH_WRITEBACK`**：注入特意加长（2x+）与缩短的简体中文译文（`gbk` / `utf-8`），执行变长写回（+ 回包），经消费端 / VM 模拟器逐条解引用校验，且验证非文本指令操作数与未翻译资源零破坏。
7. **`G7_CONTROL_PATTERN_QA`**：校验全部中文译文通过 `qaReport`，且含自定义标签的题目（`L2`、`L6`）必须正确注册 `writeback.control_pattern` 并能正向放行 + 负向拦截缺失标签。
8. **`G8_HYGIENE_AND_SANDBOX`**：工作区根目录无残留临时文件，含栅格 UI 图片资产的题目（`L1`、`L6`）已在 `rasterUiAssets` 或 `SKILL.md` 中明确记录。

## 快速使用

在 `server/` 目录下执行：

### 1. 查看题库列表
```powershell
cd server
npm run bench:reverser -- --list
```

### 2. 离线自检（0 Token：验证 6 道参考 Oracle 全过 + 5 项反作弊负向拦截）
```powershell
cd server
npm run bench:reverser -- --mode oracle
```

### 3. 直接接入本地 Magpie（默认 `http://127.0.0.1:3425/v1`）
```powershell
cd server
# 自动探测本地 Magpie 首个可用模型并跑全套 L1-L6
npm run bench:reverser -- --provider magpie

# 指定模型与子集题目（如先测 L1,L2 或单测 L4,L5）
npm run bench:reverser -- --provider magpie --model <your-model-id> --tasks L1,L2,L4,L5

# 自定义 Magpie 端口/地址（或带 Key）
npm run bench:reverser -- --provider magpie --base-url http://127.0.0.1:3425/v1 --model <id> --api-key-env MAGPIE_API_KEY
```

### 4. 接入任意 OpenAI-Compatible API 或内置 Provider
```powershell
cd server
# OpenAI 兼容接口（如 OneAPI / NewAPI / Ollama / vLLM / DeepSeek 等）
$env:BENCH_API_KEY = "sk-..."
npm run bench:reverser -- --provider openai-compat --base-url https://api.example.com/v1 --model <model-id> --api-key-env BENCH_API_KEY

# Pi SDK 内置 Provider（如 openai / anthropic / google / deepseek）
npm run bench:reverser -- --provider anthropic --model claude-sonnet-4-5 --api-key-env ANTHROPIC_API_KEY
```

### 5. 接入自定义 Adapter 模块
复制 [`custom-provider.example.ts`](./custom-provider.example.ts) 并按需修改，然后通过 `--adapter` 加载：
```powershell
cd server
npm run bench:reverser -- --adapter ./bench/reverser/my-provider.ts --model <id>
```

## 输出产物与复查方式

每次运行会自动将完整诊断结果保存到 `server/bench/reverser/runs/<mode>-<YYYYMMDD-HHMMSS>/`（已在 `.gitignore` 中忽略，不会污染 Git，也不改动个人 `~/.papercup`）：
- `report.md` / `report.json`：总分、分题通过率、耗时、Token 消耗及逐项门禁失败详情
- `<taskId>/gates.json`：8 项硬约束详细断言结果
- `<taskId>/snapshot.json`：已自动脱敏的 reverser 完整工具调用轨迹与推理过程
- `<taskId>/research/`、`<taskId>/skills/`、`<taskId>/engine.json`：reverser 生成的研究文档、脚本与技能定义

跑完后只需把该次运行的目录路径（例如 `server/bench/reverser/runs/live-20261122-210000/`）提供给审查方，即可逐题精确定位 reverser 的成败根因。
