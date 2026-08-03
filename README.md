# 时间管理助手（time）

面向管理者的时间管理助手。新版以参考前端为业务基准，用户登录后依次完成”事务填写 → AI 拆解确认 → 时间分布诊断 → 优先级排序 → 优化报告”；报告生成成功后会自动保存到当前账号的历史，并包含当次第三步时间分布诊断快照。

## 当前能力

- “昨天—今天—明天—后天”四栏整段输入；服务端先校验行数和输入边界，再执行“证据化教练诊断 → 基于证据生成任务”两阶段流水线，最后生成稳定 UUID 任务。
- 正式拆解入口使用严格 JSON Schema、证据 ID、提示词版本和 SHA256；每条任务都映射到原文证据。昨天未完成证据必须生成 `复盘` 来源任务，已完成事实不得生成任务；责任人和截止时间只能来自原文明示内容，缺失时使用”待确认”。
- AI 拆解后由用户编辑任务名称、类别、截止日期、预估工时、责任人和轻重缓急；截止日期仅保存到日级（`YYYY-MM-DD`），责任人仅从原文明示内容提取，缺失时显示”待确认”。服务端执行逐字段 SMART 门禁，任务具体、工时可解析且轻重缓急完整即可继续。工作台显示只读的今日任务卡片，展示完成状态、任务名称、截止日期和责任人，不触发自动保存。
- 时间分布诊断是正式后端节点：只解析明确的小时/分钟工时，按分钟汇总四类占比，以最大余数法保证显示合计为 100.0%，并返回未参与计算的任务。
- 支持手动新增、编辑和删除任务；任务变化会使时间分布、矩阵和报告失效，必须按新数据重新计算。
- 重要/紧急矩阵只有“高”映射为“是”，任务按稳定 `taskId` 守恒，精力比例由服务端固定为 55/25/15/5。
- 优化报告同时读取当前任务、时间分布诊断和四象限结果；只按当前 `taskId` 引用任务，叙述字段通过安全 Markdown 渲染。
- 工作台、每日跟踪和历史记录复刻参考稿的信息架构；每日清单按账号和上海业务日期持久化，未勾选且未删除的任务跨日保留；工作台只读，不因 GET 自动写库；已完成报告历史继续按账号持久化。
- 用户名密码注册、登录、退出和 7 天 SQLite Session；登录成功后会换发新 Session。
- 恢复码是唯一自助找回方式，注册、重置或轮换成功后只展示一次。用户同时丢失密码和恢复码后无法自助找回账号。
- 已完成的报告以稳定 `clientRunId` 幂等保存，支持游标分页、只读详情和二次确认删除；用户数据严格隔离。
- 新写入历史（Schema 2）同时保存第三步时间分布诊断快照，并在可空 `decomposition_json` 中保存两阶段提示词版本、哈希、中间 JSON 和任务—证据映射；历史详情提供折叠审计视图。Schema 1 旧历史仍返回 `distribution: null`，旧 Schema 2 历史没有拆解轨迹时继续正常读取。

旧兼容节点继续从 `prompts/system.md` 加载提示词；正式拆解流水线从 `prompts/decomposition/*.md` 加载独立版本化提示词。整体设计、职责边界和依据见 `knowledge/PROMPT_DECOMPOSITION_PIPELINE.md`。

## 环境要求

- Windows PowerShell
- Anaconda 或 Miniconda
- Node.js 20.20.2（精确版本；安装与 CI 均会拒绝其他版本）
- Chromium（由 Playwright 安装）

仓库通过 `.nvmrc`、`.node-version`、`package.json#engines`、Volta 和 `.npmrc` 统一固定 Node.js `20.20.2`。推荐在 Windows 使用 Volta；进入项目目录后会自动选择正确版本：

```powershell
volta install node@20.20.2
node --version
npm.cmd run check:node
npm.cmd ci
```

使用 NVM/NVM for Windows 时：

```powershell
nvm install 20.20.2
nvm use 20.20.2
npm.cmd run check:node
npm.cmd ci
```

也可继续使用项目目录内的专用 Anaconda 环境 `.conda`：

```powershell
conda create --prefix .\.conda -c conda-forge python=3.12 nodejs=20.20.2 -y
conda activate .\.conda
npm.cmd run check:node
npm.cmd ci
$env:PLAYWRIGHT_BROWSERS_PATH = '0'
npx.cmd playwright install chromium
```

Node 版本不匹配时，`npm install`/`npm ci` 会直接失败，不会在错误运行时下重建原生依赖。`.conda/`、`.conda-pkgs/`、`.npm-cache/`、`node_modules/` 和测试产物均已加入 `.gitignore`。

## 服务端配置

`npm.cmd run dev` 通过 `scripts/start-dev.js` 启动：项目根目录存在 `.env` 时使用 Node.js 原生 `process.loadEnvFile()` 安全加载，不存在时使用调用进程已注入的环境变量。一键启动脚本继续显式加载 `.env`。变量名和假占位值见 `.env.example`：

| 变量 | 必填 | 说明 |
|---|---:|---|
| `PORT` | 否 | 本地端口，默认 `4174` |
| `MODEL_API_BASE_URL` | 是 | OpenAI 兼容接口的基础 URL，服务端会请求 `/chat/completions` |
| `MODEL_API_KEY` | 是 | 只允许注入服务端进程，不得写入前端 |
| `MODEL_NAME` | 是 | 模型名称 |
| `MODEL_TIMEOUT_MS` | 否 | 单次模型请求超时，默认 `30000` |
| `MODEL_TASK_ROUTE_BUDGET_MS` | 否 | 拆解与教练路由预算，默认 `12000`；DeepSeek 模板使用 `30000` |
| `MODEL_THINKING_MODE` | 否 | `default/enabled/disabled`；不支持该字段的供应商保持 `default` |
| `DATABASE_PATH` | 是 | SQLite 数据库路径；本地默认放在已忽略的 `data/` |
| `SESSION_SECRET` | 是 | 至少 48 字节的随机会话签名密钥，不得提交 |
| `SESSION_COOKIE_SECURE` | 是 | 当前 HTTP 部署固定为 `false` |
| `SESSION_MAX_AGE_MS` | 是 | 固定 `604800000`（7 天） |

获得真实供应商配置并确认费用与数据政策后，在当前 PowerShell 会话中安全注入这些变量，再启动：

```powershell
conda activate .\.conda
npm.cmd run dev
```

访问 `http://127.0.0.1:4174/`。不要把真实 key 写入 `.env.example`、源码、测试或文档。

### DeepSeek API 配置

仓库提供 `.env.deepseek.example`。该模板使用 DeepSeek OpenAI 兼容地址、`deepseek-v4-flash`、`json_object` 响应模式、关闭思考模式并设置 30 秒任务路由预算；真实密钥只写入已忽略的 `.env.deepseek` 或 `.env`：

```powershell
Copy-Item .env.deepseek.example .env.deepseek
# 编辑 .env.deepseek，只替换 MODEL_API_KEY 和本机会话密钥
```

DeepSeek 真实测试按 `DEEPSEEK_ENV_FILE`、`.env.deepseek`、`.env` 的顺序选择配置文件，并校验供应商地址、模型名、JSON 输出模式和占位密钥，不会输出 API key。

应用启动时会按版本在事务中运行 migration（迁移）：migration 001 创建认证与历史表，002 大小写用户名，003 每日跟踪，004 新增可空 `distribution_json TEXT`，005 新增可空 `decomposition_json TEXT`。也可在启动前显式执行：

```powershell
$env:DATABASE_PATH = '.\data\time-management.sqlite'
npm.cmd run migrate
```

本地验证一致性备份时，显式把目标放入已忽略的 `backups/`：

```powershell
$env:DATABASE_PATH = '.\data\time-management.sqlite'
npm.cmd run backup:database -- .\backups\time-management-latest.sqlite
```

备份脚本使用 SQLite Backup API，先生成同目录临时文件，通过 `PRAGMA integrity_check` 后再原子替换唯一最新备份。

### Windows 一键启动

首次使用时，在项目根目录复制配置模板：

```powershell
Copy-Item .env.example .env
```

只在本机 `.env` 中填写真实模型配置，然后双击项目根目录的 `start.bat`。脚本会使用项目专用 `.conda` 环境，通过 Node.js 原生 `--env-file=.env` 加载配置；服务健康后会自动打开浏览器。

`.env` 已加入 `.gitignore`。不要提交、分享或把 `.env` 中的 API key 复制到源码、测试及文档中。

## API

`GET /api/health` 保持公开。除预登录 CSRF 辅助接口外，时间管理与历史接口均要求已登录；所有改变状态的请求还需同源 `Origin` 和 `X-CSRF-Token`。

### 认证接口

| 方法与接口 | 用途 |
|---|---|
| `GET /api/auth/csrf` | 获取短时有效的预登录 CSRF token |
| `POST /api/auth/register` | 注册，成功时只返回一次恢复码 |
| `POST /api/auth/login` | 登录并重新生成 Session |
| `POST /api/auth/logout` | 只撤销当前 Session |
| `GET /api/auth/me` | 恢复当前登录身份和 Session CSRF token |
| `POST /api/auth/password/reset-with-recovery` | 使用恢复码重置密码，撤销该用户全部旧 Session |
| `POST /api/auth/recovery-code/rotate` | 登录后用当前密码轮换恢复码 |

### 五步业务接口

新版主流程接口均为 `POST`、`application/json`。模型节点的格式或语义错误最多自动重试一次；输入校验、SMART 和时间分布为确定性服务端节点。

| 节点与接口 | 请求核心字段 | 响应核心字段 |
|---|---|---|
| 1. `/api/time-management/intake/check` | `entries` 四栏字符串 | `lineCounts`、`warnings`、`totalLines` |
| 2. `/api/time-management/tasks/decompose` | 已校验的 `entries` | `intake`、标准化 `tasks`、初始 `smart`、可审计 `decomposition` |
| 2. `/api/time-management/tasks/smart-check` | 用户确认后的 `tasks` | 逐任务 `results`、`overall`、`summary` |
| 3. `/api/time-management/distribution/diagnose` | SMART 通过的 `tasks` | `categories`、`percentages`、`diagnosis`、`recommendations` |
| 4. `/api/time-management/matrix/classify` | 当前 `tasks` | `classifications`、`quadrants`、`note` |
| 5. `/api/time-management/report/generate` | `tasks`、`distribution`、`matrix`、`goals` | `order`、`energyRules`、`adjustments` |

旧 `/goals/check` 和 `/tasks/extract` 仍保留为兼容接口，但新版页面不再以旧四步流程作为主路径。

### 历史接口

| 方法与接口 | 用途 |
|---|---|
| `POST /api/time-management/history` | 以 `(user_id, client_run_id)` 幂等保存已完成快照（新请求必须包含 `distribution`） |
| `GET /api/time-management/history` | 默认 20、最大 50 条的游标分页列表 |
| `GET /api/time-management/history/:id` | 读取当前用户的只读详情 |
| `DELETE /api/time-management/history/:id` | 删除当前用户指定历史 |

API 响应包含安全头和 `X-Request-Id`；请求日志只记录 requestId、路径、状态和耗时，不记录用户名、凭据、Cookie、目标或历史正文。报告格式最终失败时额外记录固定规则码和尝试次数，仍不记录用户正文、模型原文或凭据。

## 测试

全部测试使用假模型或 Playwright 路由，不需要真实 API key，也不会访问付费模型：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = '0'
npm.cmd test
```

也可分阶段运行：

```powershell
npm.cmd run test:server
npm.cmd run test:smoke
npm.cmd run test:e2e
```

`test:smoke` 使用确定性假模型，真实启动认证、五步 API、历史落库和每日跟踪，在一个测试中验证完整业务闭环，但不会访问外部供应商。

配置 DeepSeek 密钥后，可显式执行真实全流程测试：

```powershell
npm.cmd run test:live:deepseek
```

该命令会产生四类真实模型请求：证据与任务拆解、教练分析、矩阵分类和报告生成，并继续验证历史保存、历史读取与每日跟踪。真实测试文件命名为 `.live.js`，不会被普通 `npm test` 自动发现。

拆解流水线已有固定模拟评测集 `tests/evals/decomposition-cases.jsonl`。离线黄金回放不会访问外部模型，可直接执行：

```powershell
npm.cmd run eval:decomposition
```

配置真实模型后，可将同一批虚构输入发送给当前模型并计算任务精确率、召回率、证据状态准确率、昨天遗留覆盖率以及责任人/期限幻觉：

```powershell
npm.cmd run eval:decomposition:live
```

可用 `--case=D001` 只运行指定案例。`live` 模式会产生真实供应商请求；离线模式不会访问外部 API。自然语言质量仍应结合 `tests/prompt-cases.md` 的人工评测流程，记录模型名、提示词哈希、日期、通过项和失败样例。

## 数据与范围边界

用户、密码哈希、恢复码哈希、Session 哈希和已完成历史保存在 SQLite。密码、恢复码和原始 Session ID 不明文落库；`user_id` 只来自服务端验证后的 Session。

五步未提交草稿仍只在浏览器内存；每日任务编辑、勾选和删除写入 SQLite 的账号日快照；勾选是既有任务完成状态的唯一来源。页面继续提醒不要填写客户隐私、密码或商业秘密。

当前版本不包含邮箱、SMTP、短信、社交登录、管理员后台、团队权限、草稿恢复、教练助手依赖或外部平台集成。真实模型的供应商数据用途、保留期限与删除机制需在生产接入前另行确认。

`due` 和 `owner` 作为可选兼容字段继续保存在任务和历史 JSON 中；缺失、空白或 `null` 会标准化为"待确认"；新写入的 `due` 仅接受 `YYYY-MM-DD` 或"待确认"，`owner` 仅从原文明示内容提取。拆解轨迹通过 migration 005 写入可空 `decomposition_json`，不会要求重写旧历史。

## 目录

```text
frontend/                         # 参考稿视觉、五步状态树、每日跟踪、历史与安全 Markdown
server/                           # Express、认证/历史、SQLite、模型网关与五步工作流
scripts/start-dev.js              # 可选加载本地 .env 的开发启动器
scripts/                          # migration 与 SQLite 一致性备份 CLI
prompts/system.md                 # 旧兼容节点与矩阵/报告提示词
prompts/decomposition/            # 正式两阶段拆解提示词
tests/server/                     # Node 单元、API、安全、评测器与验收契约测试
tests/evals/decomposition-cases.jsonl # 拆解流水线固定模拟业务样本
server/evals/                     # 模拟/真实模型评测指标计算器
tests/reference-auth-history.spec.js # 新版认证、历史、退出与移动端回归
tests/reference-five-step.spec.js    # 新版五步、导航与响应式回归
tests/frontend.spec.js           # 旧四步界面历史回归资料，不在当前 Playwright testMatch 中
tests/auth-history.spec.js       # 旧四步账号界面历史回归资料，不在当前 Playwright testMatch 中
tests/prompt-cases.md        # 自动化边界与人工/模型质量评测
docs/acceptance/             # 甲方验收清单
docs/adversarial-review.md   # 对抗审查复核
knowledge/PROMPT_DECOMPOSITION_PIPELINE.md # 拆解流水线、证据链和工程依据
```

新版五步与参考界面验收见 `docs/acceptance/reference-five-step-v2.md`；旧四步业务验收和账号历史验收仍分别保存在 `docs/acceptance/time-management-v1.md`、`docs/acceptance/account-auth-history-v1.md`，剩余风险见 `docs/adversarial-review.md`。
