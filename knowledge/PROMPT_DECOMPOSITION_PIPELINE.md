# 时间管理教练拆解流水线

## 1. 改造目标

旧实现将“事实识别、完成状态判断、管理诊断、任务拆分、重要性和紧急度判断”放在一次模型调用中。该设计存在三个主要问题：

1. 无法区分模型从原文提取的事实和模型生成的管理判断。
2. 任务无法追溯到原文证据，遗漏和幻觉只能依赖最终结果人工发现。
3. 仅使用 `json_object`，只能约束为合法 JSON，不能保证字段和枚举契约。

新实现把前端正式使用的 `/api/time-management/tasks/decompose` 改为三阶段多智能体流水线（`PIPELINE_VERSION = 'multi-agent-v2-phase3'`）；旧 `/tasks/extract` 继续保留，避免一次性破坏兼容接口。

## 2. 注入位置

```text
prompts/decomposition/*.md
        ↓ loadVersionedPrompt
server/workflows/decompose-tasks.js
        ↓ completeJson(responseSchema)
server/model/model-client.js
        ↓ POST /chat/completions
模型供应商
```

旧步骤提示词仍由：

```text
prompts/system.md
        ↓ loadStepPrompt
check-goals / extract-tasks / classify-matrix / generate-report
```

加载。当前只有正式“拆解”入口切换到新流水线。

## 3. 新流水线

正式拆解入口为三阶段多智能体流水线：并行证据抽取 → 跨维度整合 → 任务编译与并行审查。所有阶段模型调用点均使用独立的版本化提示词和 JSON Schema。

### 阶段 1：证据抽取（evidence-agents，4 路并行）

输入：四栏原文和服务端计算的上海业务日期。

四个维度（昨天/今天/明天/后天）各运行一个 evidence agent，互不依赖、并行执行，空维度直接跳过。每个 agent 只抽取自己维度的证据原子（FactAtom）：

- `quote` 原文连续引用、所属维度、规范化观察、状态、原文明示责任人和期限、验收标准、下一步动作；
- 各并行模型无法协调全局 ID，跨 agent 的原子 ID 冲突由服务端统一改写（`rewriteCrossAgentAtomIdCollisions`）。

合并后的服务端校验：

- `quote` 必须真实存在于对应栏位原文（行级 trace 校验）；
- `owner` 和 `due` 非“待确认”时必须能在原文中找到；
- 证据 ID 不重复（含跨维度）；
- 随后经 `hardenFactAtoms` 确定性归一化，修正未完成信号等状态初判。

### 阶段 2：跨维度整合（reconciliation-agent）

输入：阶段 1 合并后的全部证据原子（含按维度分组）、四栏原文、业务日期。

输出：`clusters`（跨维度聚类、去重、归并关系）和 `conflicts`（冲突原子对及字段）。

服务端对聚类结果做确定性规范化（`normalizeReconciliationClusters`）：

- 范围冲突（如前端/后端、线上/线下）、伞形上下文、同维度内无归并关系的 cluster 会被拆分；
- 关联的非 work 原子（上下文、期限）跟随主 work 原子归属；
- reconciliation 失败不阻塞主流程，降级为 1:1 编译回退（`one-to-one`）。

### 阶段 3：任务编译与并行审查（compile → critic-agent）

编译阶段是确定性代码（`compileTasksFromClusters`）：

- 每个 cluster 产生一条规范任务（多对一归并），未聚类的 work 原子按 1:1 回退编译；
- 跨来源语义合并（复盘/今天）和跨来源去重；
- 无任务产出时返回“没有识别出可执行任务”。

随后 5 路 critic 并行审查（owner / due / coverage / dedupe / source），每路只拿自己需要的输入子集：

- 去重（dedupe）：跨来源重复任务；
- 责任人（owner）：责任人幻觉和语义角色错误；
- 期限（due）：期限污染、期限无原文依据；
- 来源（source）：任务来源与主要证据维度不一致；
- 覆盖（coverage）：证据未被任何任务覆盖、孤儿任务。

服务端先对 findings 做接地过滤（`filterGroundedCriticFindings`），再应用：

- blocker 发现把对应字段置为“待确认”并标记 `reviewRequired`；
- 治理状态按发现级别转为 `review_recommended` 或 `needs_confirmation`；
- 单路 critic 失败不阻塞其他路，全部失败时降级为无审查输出。

模型结果通过后，服务端继续确定性执行：

- UUID 生成与日期标准化；
- SMART 校验；
- 每日跟踪合并（复盘/今天）与跨日未完成任务滚动（由每日跟踪服务处理）。

旧两阶段流水线（coaching-analysis → task-generation）不再用于正式入口，仅作为兼容回退路径保留。

## 4. 模型与硬编码职责边界

| 职责 | 执行位置 | 原因 |
|---|---|---|
| 原文语义分段、事实类型、状态初判 | 模型阶段 1 | 需要自然语言理解 |
| 跨维度聚类、去重、冲突识别 | 模型阶段 2 | 属于开放式语义判断 |
| 任务级审查（去重/责任人/期限/来源/覆盖） | 模型阶段 3 | 需要语义归纳和任务命名 |
| JSON 字段、枚举、长度、数量 | JSON Schema + AJV | 可确定性验证，不应交给模型自律 |
| quote 是否存在于原文 | 服务端 | 可直接复核 |
| owner/due 是否有原文依据 | 服务端 | 防止模型推断 |
| 昨天未完成证据是否被覆盖 | 服务端 | 产品强规则，必须硬保证 |
| 日期归一化、紧急度期限规则 | 服务端 | 时间规则应一致且可复算 |
| UUID、任务守恒、每日滚动 | 服务端 | 数据完整性规则 |

## 5. Structured Outputs 与兼容策略

模型客户端在传入 Schema 时优先发送：

```json
{
  "type": "json_schema",
  "json_schema": {
    "name": "...",
    "strict": true,
    "schema": {}
  }
}
```

如果 OpenAI-compatible 供应商对该能力返回 400、404 或 422，客户端仅回退一次到 `json_object`；回退结果仍必须通过本地 AJV Schema 和语义校验。

这避免把供应商兼容性等同于降低应用层校验强度。

## 6. 重试策略

每个阶段最多两次模型输出：

1. 首次输出先经过 JSON Schema 和语义规则校验；
2. 失败时只把固定失败规则码和修正方向注入第二次请求；
3. 不把用户原文、模型原始错误正文或内部堆栈写入错误响应；
4. 超时和上游不可用不自动重试，避免隐藏延迟和重复计费。

## 7. 版本和审计留存

每个提示词文件有独立：

- `prompt.id`
- `prompt.version`
- `prompt.sha256`

当前版本化提示词清单（定义于 `server/prompts/load-versioned-prompt.js`）：

| prompt.id | version | 文件 |
|---|---|---|
| decomposition.evidence-agent | v1.0.0 | evidence-agent.v1.md |
| decomposition.reconciliation | v1.0.0 | reconciliation.v1.md |
| decomposition.critic-owner | v1.0.0 | critic-owner.v1.md |
| decomposition.critic-due | v1.0.0 | critic-due.v1.md |
| decomposition.critic-coverage | v1.0.0 | critic-coverage.v1.md |
| decomposition.critic-dedupe | v1.0.0 | critic-dedupe.v1.md |
| decomposition.critic-source | v1.0.0 | critic-source.v1.md |
| decomposition.coaching-analysis | v2.0.0 | coaching-analysis.v2.md |
| decomposition.evidence-task-generation | v2.1.0 | evidence-task-generation.v2.1.md |

前 7 个构成当前三阶段流水线；最后 2 个（coaching-analysis 和 task-generation 系列）是旧两阶段流水线的提示词，不再用于正式入口，仅作为兼容回退路径保留。

历史快照新增可空 `decomposition_json`，保留：

- 流水线版本；
- 业务日期；
- 各阶段提示词版本和哈希；
- 各阶段完整 JSON 输出；
- 任务到证据原子 ID 的映射。

用户在“AI 拆解确认”页编辑、删除模型任务或新增手动任务时，原始拆解轨迹不会被覆盖；最终任务继续单独保存在 `tasks_json`。因此可以比较“模型原始候选”和“最终采用版本”。

旧历史仍使用 `schema_version=2`，`decomposition_json` 为 NULL 时可以正常读取。历史详情页提供折叠的审计 JSON 查看入口。

## 8. “昨天”与每日跟踪

两类规则相互独立：

1. 本次输入的“昨天”栏：阶段 1 把未完成事项标成 `unfinished` 后，编译阶段生成 `source=复盘` 的任务（昨天未聚类的原子按 1:1 编译，来源固定为复盘），评测门槛强制昨天可行动证据必须被任务覆盖；生成报告后，该任务会进入当天每日跟踪。
2. 前一业务日每日跟踪：服务端 `daily-tracking/service.js` 会读取最近一次日快照，只把未勾选且未删除的任务滚入新的上海业务日；已完成或已删除任务不会滚入。

因此任务可以保持“昨天/复盘”这一来源类别，同时出现在今天的执行清单中，不需要篡改来源来实现滚动。

## 9. 评测和发布门槛

固定评测数据位于 `tests/evals/decomposition-cases.jsonl`。首批 16 个虚构案例覆盖：

- 昨天明确完成、明确未完成和混合状态；
- 昨天无完成标志但仍可执行的模糊状态；
- 无标点动作链；
- 多责任主体、接收人和抄送人；
- 相对期限、当天期限和长期期限；
- 临时突发事项；
- SMART 多交付物；
- 超过 8 小时的长期任务；
- 四维混合输入；
- 空泛愿望和无可执行内容；
- 原因未知时的根因证据不足。

离线黄金回放：

```text
npm run eval:decomposition
```

该模式把固定标注编译成三阶段模拟模型输出，验证流水线、Schema、语义门禁和指标计算，不访问外部 API。当前基线为 16/16 通过。

真实模型评测：

```text
npm run eval:decomposition:live
```

该模式把同一批虚构输入发送给当前配置的模型，计算：

- 案例通过率；
- 任务 precision、recall 和 F1；
- 证据状态、类型、责任人和期限准确率；
- 昨天未完成事项覆盖率；
- 完成事项进入待办的泄漏数；
- 责任人和期限幻觉数；
- 根因未知时是否明确标记证据不足。

当前自动化门槛：

- 证据 quote 必须可回查；
- 昨天未完成证据遗漏时必须失败并定向重试；
- 昨天已完成证据不能生成任务；
- Structured Outputs 请求和兼容回退均有测试；
- 中间 JSON 可通过历史契约往返；
- 每日跟踪跨日仅滚动未完成任务；
- 评测器对额外任务、虚构证据和指标口径错误能够报警。

每次变更提示词、模型版本或供应商前，应先运行离线回放，再运行固定模型评测并保存失败案例。离线 100% 只说明工程契约没有回归，不代表真实模型语义质量达到 100%。

## 10. 依据

- OpenAI Prompt Engineering：明确、分层的指令和输入边界。
  - https://developers.openai.com/api/docs/guides/prompt-engineering
- OpenAI Structured Outputs：优先使用严格 JSON Schema，而不是仅保证合法 JSON 的 JSON mode。
  - https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI API backward compatibility：模型行为可能随版本变化，建议固定模型版本并实施 evals。
  - https://platform.openai.com/docs/api-reference/backward-compatibility
- OpenAI Evals：使用可重复评测集持续验证模型和提示词变化。
  - https://developers.openai.com/api/docs/guides/evals
- Anthropic Prompt Engineering：复杂任务采用 prompt chaining，将中间结果传给后续步骤并在节点间设置检查。
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#chain-complex-prompts
