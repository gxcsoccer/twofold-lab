# 数据接入与模型成本方案

状态：M1 部分实现，2026-08-25。数据供应商价格和能力会变化，正式赛季启动前必须重新抓取官方来源并冻结快照。

## 结论

Twofold 不把“最新行情缓存”当真相源。所有外部数据都走同一条可审计证据链：

```text
Provider API / 用户文件
  -> private raw artifact
  -> immutable normalized fact
  -> sealed point-in-time snapshot
  -> frozen decision packet
  -> Arena root Session + descendant Session tree
  -> immutable business event / disposable projection
```

MVP 私有 dogfood 推荐：

- 美股主行情、交易日历、资产与公司行动：Alpaca Basic；决策行情显式请求 `feed=sip&timeframe=1Day&adjustment=raw`，并把决策时间从 16:15 ET 推迟到至少 16:20 ET，避开免费 SIP 最近 15 分钟限制。
- USD/CNY：CFETS 中间价只做人工核验，自动抓取需先取得网站授权。无需 key 的自动链路可用 ECB 官方 USD、CNY 对 EUR 参考汇率做交叉，但必须标记为 `ECB_REFERENCE_CROSS`，不能冒充 CFETS 中间价。
- 初始持仓与费用：导入 Futu 日/月结单原文件，加人工 tax-lot CSV；v1 不保存券商登录或交易凭证。
- ETF：首季使用人工审核并冻结的小型 allowlist，不依靠 ticker 名称自动猜测杠杆、反向、ETN 或税务分类。

这套 MVP 的**市场数据订阅固定成本可以为 0 美元/月**，但 DeepSeek 用量仍按请求产生变量成本。

正式 13 周私有赛季可升级为 Alpaca Algo Trader Plus（当前 99 美元/月）。Massive Basic/Starter 技术上可作为二次数据源，但其个人市场数据条款限制 non-display、衍生作品和投资策略用途，因此在取得书面许可前不接入 Twofold。任何公开、多用户或再分发场景都必须单独确认商业授权。

## 当前已实现的真实切片

- `202608230003_market_data_pipeline.sql`：private Raw bucket、不可变 raw artifact、source version、delivery observation、canonical daily-bar fact、delivery/fact 关联、sealed snapshot 与 member，以及三组 service-role-only RPC。
- Worker `pnpm ingest:market`：真实调用 Alpaca multi-symbol bars API；默认 `LULU,SPY,QQQ`、`1Day`、`sip`、`raw`，免费档按当前时间减 16 分钟设置 end，并完整跟随 `next_page_token`。
- Provider JSON 使用 lossless parser；金融数值不经过 JavaScript float，规范化后以 canonical decimal string 持久化。
- Snapshot 显式锁定同一个 `target_session_date`；默认选择所有标的最新共同日期，同日 16:20 America/New_York 前拒绝封存，避免把盘中聚合日线冒充收盘数据。
- `/data` 只读取真实 Supabase 证据链；从 sealed snapshot member 逐项反查 fact、cutoff 前的 delivery/fact 关联、delivery observation 与 raw artifact，不把无关的最新 delivery 拼成快照来源。缺 Provider key、完整标的或 snapshot 时显示不可用，不存在 runtime fixture fallback。
- 已在独立 Supabase 项目完成迁移与真实凭证注入，并封存 2026-08-21 的 LULU/QQQ/SPY Alpaca SIP 快照；Raw 对象、三名成员和 cutoff provenance 已远端核验。
- 尚未完成：定时 work queue、交易日历、公司行动、FX 与初始 Futu tax lots。
- 初始组合的纯函数契约和只读校验 CLI 已完成：规范化 JSON 必须使用整数股与
  decimal string，并通过原始 Futu 文件字节的 SHA-256 绑定；当前仍缺用户真实
  结单/tax-lot 文件，因此没有导入任何持仓，也不会生成替代数据。
- 会计 Core 已有 exact decimal、balanced/no-margin replay、Futu 费用、FIFO
  shadow tax、三层 NAV、Round/Season、S1/S2 计划与纯模拟；费用执行从计划内冻结
  的 exact terms 恢复，不依赖后来变化的内存 registry。
- Worker 已能把 Core order plan 转成数据库契约要求的 canonical envelope，绑定
  run/decision/accepted submission、执行规则、费用条款 SHA 和 engine plan 指纹。
- 数据库已部署 ledger-head-backed 原子 S2 BUY 结算：由数据库重算可用现金、冻结
  上限、成交量、费用、journal、lot、acquisition FX 与新 head；Worker 具备严格
  exact RPC 客户端。该能力尚未接入 durable scheduler，且远端没有官方开盘/FX
  evidence、ledger head 或 settlement 行，因此当前不会产生真实 paper fill。

## 不能模糊的价格语义

Alpaca/Massive 的日线 OHLC 是基于 SIP qualifying trades 聚合的未复权 bar，不等于每个标的主上市交易所的官方开盘/收盘竞价价。MVP 建议把协议字段冻结为：

```text
SIP regular-session unadjusted daily-bar open / close
```

如果实验坚持使用字面意义的交易所 official auction price，则需要单独采购 Nasdaq NOOP/NOCP、NYSE TAQ 等交易所产品，并重新评估授权、到达时间和预算；这不是当前免费方案能可靠提供的能力。

## 四层数据契约

### 1. Raw delivery

Worker 先保存供应商响应或用户文件的原始字节到 private、content-addressed Storage：

```text
raw/{sha256-prefix}/{sha256}
```

数据库只登记证据元数据：

- source/version、endpoint、规范化 request fingerprint；
- provider record/revision/request ID；
- `provider_published_at`、`first_observed_at`、`retrieved_at`、`available_at`；
- HTTP ETag/Last-Modified、content type、byte size、SHA-256；
- parser/normalizer commit；
- sensitivity、license/use scope。

原始 JSON 可以含 JSON number，因此不直接放进当前 number-free 业务事件；事件只引用 artifact ID 和 hash。`available_at` 至少取 provider release/embargo 与 `first_observed_at` 的较晚者，防止供应商后来回填历史发布时间造成前视。

### 2. Normalized fact

版本化纯函数把 raw 转为不可变事实：

- `fact_type`、稳定 `fact_key`、稳定 instrument ID 与当日 symbol；
- `effective_at/effective_date`、`available_at`；
- provider revision、raw delivery ID/row locator；
- canonical decimal-string payload；
- normalizer version/hash、fact SHA-256；
- `supersedes_fact_id`。

修订只追加新 fact，不覆盖旧事实；缺失价格、FX、费用规则或税务分类绝不默认成 0。

### 3. Sealed snapshot

在固定 cutoff 通过一个事务 RPC 封存：

1. 只选 `available_at <= cutoff_at` 的事实；
2. 每个 `fact_key` 选当时已可见的最新合法 revision；
3. 只允许 Season manifest 中冻结的 source versions；
4. 检查必要价格、FX、公司行动和分类是否齐全；
5. 成员稳定排序、canonicalize，生成 snapshot SHA-256；
6. header/member 均 append-only。

D 决策、S1 open、S1 close、S2 open 和 daily valuation 使用不同 `snapshot_kind`。S1/S2 后验事实不能进入 D 的决策包。

### 4. Decision packet

Packet builder 组合：

- sealed snapshot ID/hash；
- run ledger head event/sequence/hash；
- `decision_at`、`data_cutoff_at`、trigger reasons；
- universe/risk/ruleset/fee/tax versions；
- Skill、prompt、model 和代码 manifest。

输出 canonical JSON artifact，再追加 `decision.packet_sealed`。Arena 将 packet
绑定到一次 Bundle invocation 的 root Session；所有 descendant Session 继承同一
`decision_packet_id`、snapshot/cutoff 和只读数据能力，不能获取更晚数据。Bundle
不能直接访问 raw provider、Twofold 数据库、Worker 文件系统或密钥。完整 Bundle
可以在 Arena 内使用自己的规划、工具和 descendant orchestration，但数据、预算、
提交与确定性执行边界始终由 Arena 掌握。

主赛的参赛制品是 commit/hash 固定的完整 DSH Agent Bundle。`Controlled Lab`
另行把 No Skill、UZI、ai-berkshire 等 instruction-only 输入装入标准 runner，
用于回答“只改变 instructions 会怎样”，不替代完整 Bundle 的主赛结果。

## Worker 与队列

定时抓取、normalize、seal、packet、valuation 和模型运行不复用 `control_command`。后者是操作员意图；系统任务需要独立 `work_item`：

- stable idempotency key；
- dependency/available time；
- claim token、lease renewal、attempt/backoff；
- max attempts 与 dead letter；
- result artifact/event references。

推荐幂等键：

```text
raw       = source_version + request_fingerprint + response_sha256
fact      = source_version + fact_key + provider_revision_or_payload_hash
snapshot  = scope + cutoff + selection_policy + manifest_sha256
packet    = decision_id + builder_version + snapshot_hash + state_head_hash
work      = job_kind + scope + scheduled_slot + manifest_hash
model     = harness_session_id + turn + step + physical_attempt
submit    = harness_session_id + accepted_submission
```

## Token、成本与预算

必须区分三层计数：

- `decision invocation`：一次 Bundle 业务决策，对应一个 root Session tree；PRD 的“每个收盘时点一次”按这个口径约束。
- `Agent Session`：root 或任一层 descendant。Session 数量不是额外的业务决策，但必须记录 parent/root lineage、Agent identity、Bundle hash、开始/结束和退出状态。
- `provider request`：任一 Session 中每次实际调用模型。现有受限 host preset 的 `read_decision_packet -> submit_portfolio_targets` 正常路径会有两个 provider step；未来 Controlled Lab 可复用这条标准路径。完整 Bundle 的请求数由自身 orchestration 决定，但受同一 tree budget 限制。

Worker 按 `(session, turn, step, physical_attempt)` 缓冲 usage，直到 `step/end` 才登记一次：优先使用 finalized `assistant/message`，若请求失败且没有 final message，则退回该 attempt 最后的 usage chunk；完全没有 usage 时明确记录 `provider_unreported`。当前 DeepSeek adapter 已开启 streaming usage，并映射为互斥分桶：

- `uncached_input_tokens`：DeepSeek cache miss；
- `cache_read_tokens`：cache hit；
- `cache_write_tokens`：当前 DeepSeek 适配器不单列；
- `output_tokens`；
- `reasoning_tokens`：`output_tokens` 的子集，只展示，不再加一次费用。

数据库 migration `202608230002_model_usage.sql` 已加入不可变 `model_pricing_version` 与 `model_usage_record`，并用 `(harness_session_id, turn_index, step_index, attempt_index)` 和幂等键防重。记录还保留 request start/completion、Harness artifact/event sequence 与 usage source。未知 usage、pricing 或 request ID 保持显式状态/NULL，不伪造 0 或 actual。

主赛还需要新增不可变的 Bundle invocation / Session lineage 事实，把每条
`model_usage_record` 关联到 `root_harness_session_id`、`parent_session_id`、
Bundle identity 和 Agent path。树聚合只求和每个 physical attempt 一次；父
Session 收到的 child summary 不重新计费。聚合至少按 root decision、Bundle、
Run、Season 和 Agent path 输出，并同时展示 descendant 数、并发峰值、预算预留、
已用与剩余额度。当前 Arena thin slice 已用 migration 005、Worker 和按 decision UUID
读取的 GUI 投影接通 lineage 与 tree aggregate；完整赛季调度和确定性执行仍未接入。

本 Season 将官方页面上的 `DeepSeek-V4-Pro-0813` USD 费率冻结为
`deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1`，从
`2026-08-23T00:00:00Z` 起生效（每 100 万 Token）：

| 分桶 | Off-peak | Peak |
|---|---:|---:|
| Cache hit input | $0.022 | $0.044 |
| Cache miss input | $0.66 | $1.32 |
| Output | $1.98 | $3.96 |

Peak 为周一至周五 UTC 01:00–04:00、06:00–10:00，其余为 off-peak。
Migration `202608230006_deepseek_v4_pro_0813_pricing.sql` 通过不可变注册 RPC
写入两个 band、同一个 pricing version、官方 `source_url` 和 Season 冻结起点；
它不覆盖旧价卡。Worker 只能通过版本化选择器
`deepseek-weekday-utc-v1` 按 request start 选价，估算器会再次核对 band，
不接受调用方手工传入的错误峰谷价。

DeepSeek 官方账单没有独立的 cache-write 单价，且当前 adapter 报告的
`cache_write_tokens` 为 `0`。价卡仍将 cache write 保守映射到对应 band 的
cache-miss 单价（off-peak `$0.66`、peak `$1.32`），避免未来 adapter 开始
上报该分桶时被静默按零成本计算。

估算公式：

```text
estimated_cost =
  (uncached_input * cache_miss_rate
  + cache_read * cache_hit_rate
  + cache_write * provider_specific_rate
  + output * output_rate) / 1,000,000
```

`reasoning_tokens` 不重复加入。`estimated_cost` 永远标记为估算；DeepSeek Usage 页按月 Export 的 amount CSV 作为 API Key 级账单事实另行导入和聚合对账，不能虚构逐请求 actual cost。

每个 Season 冻结三类模型预算并应用于每个完整 Session tree：

- 每个 decision 最大 provider requests；
- 每个 decision 最大 billable tokens；
- 每个 decision 最大 estimated USD cost。

当前 Worker 在创建 descendant 和发起 provider request 前从同一个 root budget
预留额度。模型请求的输入上界按完整请求 UTF-8 字节、消息/工具 framing 余量保守
计算，输出按 `maxTokens` 全额预留；价格从 request start 对应的冻结 band 查询，按
全 cache-miss 输入加最大输出计算最坏 estimated USD cost。并发中的请求保留其
reservation，完成后才以 Provider 实际 usage 结算。价格缺失、usage 未上报、实际
用量超过 reservation 或共享额度不足都会阻止后续请求并写入
`BUDGET_EXHAUSTED` 证据；Bundle 不能临时提高预算。

提交只经过 root-only Arena broker，并受 packet hash、eligible symbols、精确
10000 bps、唯一 accepted submission 和数据库 `clock_timestamp()` deadline
约束。当前 Arena runtime 仍只到 accepted paper targets；frozen-plan admission
和原子 S2 BUY RPC 是独立、已验证但未调度的 Worker/DB primitives。S1 与正式
CNY FIFO 税务结算仍 fail closed。报告按
decision/root tree、Bundle、Run、Season 和 Agent path 聚合请求数、
各 Token 分桶、缓存命中率、估算成本、未定价/未报告覆盖率与单位决策成本。

外部不可信 Bundle 的 transcript、usage 与提交证据仍要完整归档，但执行本身必须
位于独立进程或容器中；只注入 packet-scoped capability token，不继承 Worker、
Provider、Supabase 或宿主文件系统密钥。当前仓库尚无该隔离运行时。

## Volta 的取舍

从 `/Users/bytedance/projj/github.com/gxcsoccer/volta` 复用概念：

- 批量拉取所有 symbols，再把同一冻结映射分发给所有运行；
- provider adapter 和可替换测试 seam；
- trade/cash/position 的原子 Postgres RPC 模式。

不复制：

- `feed=iex` 的 latest snapshot；
- 按 symbol upsert 覆盖历史；
- 缺价回退 `0`；
- 静态硬编码基本面；
- Vercel cron 同时充当 scheduler 和 executor；
- tool loop 只读 choices、丢弃 `usage`；
- JavaScript float、随机滑点和公开读策略。

## 分阶段落地

1. **M1 real evidence chain**：Alpaca raw/fact/snapshot、独立 Supabase 与真实 key 已接通；下一步补交易日历、FX 与 durable work queue，并继续验证相同 delivery/cutoff 得到相同 hash。
2. **M2 Arena decision thin slice**：trusted-host packet builder、完整 Bundle manifest、root/descendant Session binding、Arena data/budget/submission gateway、Session lineage、descendant usage aggregate 与实时 Agent tree/预算投影已接通并完成真实 DeepSeek dogfood。下一步是独立的 Controlled Lab instruction-only 消融轨道。
3. **M3 forward provider**：Alpaca + Massive/CFETS/Futu 文件导入、公司行动修订、租约续期、告警、restatement、月度账单对账。
4. **M4 untrusted entrants**：外部 Bundle 验证、进程/容器隔离、网络与文件系统 policy、resource limit、超时终止和隔离逃逸测试。

## 主要官方来源

- DeepSeek pricing: <https://api-docs.deepseek.com/quick_start/pricing/>
- DeepSeek usage schema: <https://api-docs.deepseek.com/api/create-chat-completion/>
- DeepSeek monthly usage export: <https://api-docs.deepseek.com/faq>
- Alpaca plans: <https://docs.alpaca.markets/us/docs/about-market-data-api>
- Alpaca IEX/SIP and 15-minute rules: <https://docs.alpaca.markets/us/docs/market-data-faq>
- Massive stocks pricing: <https://massive.com/pricing?product=stocks>
- Massive market-data terms: <https://massive.com/legal/market-data-terms-of-service>
- CFETS USD/CNY central parity: <https://www.chinamoney.com.cn/english/bmkcpr/>
- CFETS legal declaration: <https://www.chinamoney.com.cn/chinese/legaldeclaration/>
- ECB data API: <https://data.ecb.europa.eu/help/api/data>
- ECB reuse terms: <https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html>
- Futu statements: <https://www.futuhk.com/en/support/topic2_332from_platform%3D4%26lang%3Den-us>
- Futu OpenAPI trade overview: <https://openapi.futunn.com/futu-api-doc/en/trade/overview.html>
