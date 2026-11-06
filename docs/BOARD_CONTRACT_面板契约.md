# 面板契约：单项目看自带面板，总看板走 W3

> 这份文档管两块：每个实例的单项目详情，和跨项目的总看板。总看板在 `Javey-Li/OpenClaudeDesktop` 的 W3，是另一条线。

## 一句话

单项目详情先用 superagent 自带面板。

跨项目总看板只做三栏：要我定的、做完的、卡住的。

总看板只读聚合，不建第二份状态。

丢东西只有两个入口：写目标仓库 Issue，或交给 superagent Trigger。

## 1. 两块面板

| 面板 | 在哪 | 回答什么问题 | 能不能写 |
| --- | --- | --- | --- |
| 单项目面板 | 每个实例的 `127.0.0.1:<port>` | 这个项目现在怎么样 | 能，按 superagent 自带面板的权限 |
| 总看板 | `Javey-Li/OpenClaudeDesktop` 的 W3 | 所有项目里什么要我定、什么做完了、什么卡住了 | 不能，只读 |

第一版不自己写单项目面板。

自带面板已经有 Overview、Source、Trigger、Eval、Execution、Settings。单项目的细节都去那里看。总看板只做汇总和跳转。

## 2. 三栏

### 要我定的

定义：这件事现在停在主人这里。没有主人的回答、确认或处理，它不会往下走。

来源：每个实例的 `/orchestrator/api/overview` 里的 `person` 列表。

`person` 下面的 `stage.action` 对应：

| action | 卡片上写什么 | 意思 |
| --- | --- | --- |
| `answer` | 等你回答 | 执行器提了问题 |
| `review` | 等你确认 | 结果好了，等人看 |
| `delivery` | 消息没送到 | Input 没到执行器，要人处理 |
| `blocked` | 卡住，等你决定 | 执行器明确说被挡住 |
| `failed` | 失败，等你恢复 | 执行器明确说失败 |

注意：`ready` 不是“做完”。在底座里，`ready` 会进 `person/review`，意思是等人看结果。所以它归“要我定的”，不归“做完的”。

### 做完的

定义：Ticket 已经结束，而且有结果。

来源：每个实例的 `/orchestrator/api/tickets?state=ended`。

只收最近 7 天。超过 7 天的归档，不占三栏。

请求带 `limit=1000`，再按 `ended.at` 过滤最近 7 天。不要只拿默认的 20 条。

`ended.outcome` 对应：

| outcome | 卡片上写什么 |
| --- | --- |
| `merged` | PR 已合并 |
| `closed` | 已关闭 |
| `completed` | 已完成 |
| `dropped` | 无需处理 |
| `stopped` | 你停掉了 |

卡片必须带结果链接：PR、commit、文档或 Issue。看 `threads[].url` 和 `summary` 里的链接。

`completed`、`merged`、`closed` 没有链接，降级成“待确认”，放“要我定的”。`stopped` 和 `dropped` 不需要链接。

### 卡住的

定义：没有人要回答的问题，但事情也动不了。原因是系统或环境，不是主人的决定。

来源：

- `/orchestrator/api/state` 的 `health`、`load`、`paused`。
- `/orchestrator/api/overview` 的 `problems`、`executor`。
- T3 线程状态。
- 实例是否连得上。

典型情况：

| 情况 | 卡片上写什么 |
| --- | --- |
| 实例连不上 | 实例没响应 |
| setup 没完成 | 还差配置 |
| Source 报错 | 来源坏了 |
| runtime 报错 | 服务坏了 |
| 执行器被暂停 | 执行器暂停了 |
| 写线排队超过 30 分钟 | 写线排满了 |
| Assignment 跑了 30 分钟没有任何 Report | 工单没动静 |
| T3 线程断了 | T3 线程断了 |
| Eval 超时 | 评估超时了 |

`/orchestrator/api/overview` 里的 `problems` 这样归：

| `kind` | 卡片上写什么 | 归到 |
| --- | --- | --- |
| `setup` | 还差配置 | 卡住的 |
| `no-source` | 没有启用的来源 | 卡住的 |
| `no-allowed` | 没人能派活 | 卡住的 |
| `source-error` | 来源坏了 | 卡住的 |
| `executor-paused` | 执行器暂停了 | 卡住的 |
| `runtime-error` | 服务坏了 | 卡住的 |
| `eval-overdue` | 评估超时了 | 卡住的 |
| `eval-unavailable` | 评估没跑完 | 卡住的 |
| `outgoing` | 回复没发出去 | 卡住的 |

判定用 `GET tickets/:id` 里的 `assignments`：

- 先读 `mandate.line`。只有 `line=write`，工单在 `working/queued`，且 `updatedAt` 超过 30 分钟没变，才算“写线排满了”。
- Assignment 是 `running`，`startedAt` 超过 30 分钟，且没有 `report.at >= startedAt`，算“工单没动静”。

`blocked` 和 `failed` 的 Report 已经在“要我定的”，不要再放进“卡住的”。同一张工单只进一栏。

### 归属顺序

同一条工作只进一栏。顺序是：

1. 要我定的
2. 卡住的
3. 做完的

不同的系统问题可以各自成卡。比如某张工单在等人看结果，同时 Source 又报错，这是两张卡，不是一张卡进两栏。

## 3. 数据从哪来

总看板只读三个来源。

### 3.1 各实例的 `/orchestrator/api`

用到的接口：

| 接口 | 用来做什么 |
| --- | --- |
| `GET state` | 实例健康、执行器负载、是否暂停 |
| `GET overview` | 要人处理的工单、系统问题、24 小时流量 |
| `GET tickets?state=ended` | 最近做完的工单 |
| `GET tickets/:id` | 单张工单的 Assignment、Report、Channel、Thread |

访问约束：

- 只监听 loopback。
- 请求带 `x-orchestrator-request: 1`。
- Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。
- 浏览器不能从一个端口直接读另一个端口。总看板必须有自己的本地只读服务端代取。
- 前端只和总看板自己的服务端说话。不要让浏览器直连五个实例。

总看板只发 `GET`。需要改状态时，跳到实例自带面板，让面板去发 `POST`。

### 3.2 T3 线程

用 T3 的 `thread list --json` 和 `thread show <id> --json` 读。

规则：

- 对应关系只认 Assignment 上的 `t3ThreadId`。
- 没有 `t3ThreadId` 的线程，只进对话列表，不进三栏，也不挂到工单卡。
- 不按时间猜。不按标题猜。不从 `evidence` 反推。
- `t3ThreadId` 由 W2 的 T3 执行器写入。没写就是 W2 的问题，不是看板的猜测题。
- T3 线程是执行现场，不是状态源。状态仍以实例的 Assignment/Report 为准。

### 3.3 `~/.codex/sessions`

只读。用来补对话和出处链接。

规则：

- 不写这些文件。
- 不把 Codex 会话单独变成“做完”卡片。
- 只有 Report 或 Ticket 里明确带了会话 id 或路径，才把会话挂到卡片上。
- 读不到就显示“没有对话链接”，不要报错挡住整页。

## 4. 卡片长什么样

一张卡片只回答一件事。

```json
{
  "key": "fretsense:ticket:tkt_01",
  "project": "FretSense",
  "column": "person",
  "title": "补上第 115 号 Issue 的回归测试",
  "why": "T3 说测试命令找不到，需要你选新的命令",
  "stateLabel": "等你回答",
  "since": "2026-11-07T10:20:00Z",
  "owner": "你",
  "links": {
    "panel": "http://127.0.0.1:3082/...",
    "t3": "t3://thread/...",
    "codex": "/Users/javeyli/.codex/sessions/...",
    "external": "https://github.com/Javey-Li/FretSense/issues/115"
  },
  "actions": [
    "去回答",
    "打开工单"
  ]
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `key` | `项目:ticket:id` 或 `项目:system:类型`。同一 key 只出现一次 |
| `project` | 显示项目名，不显示 profile 名 |
| `column` | `person`、`done`、`stuck` |
| `title` | 用人能看懂的事，不贴内部 id |
| `why` | 一句话。来自 question、Report summary 或 health detail |
| `stateLabel` | 用上面的白话标签 |
| `since` | 从什么时候开始等 |
| `owner` | `你` 或 `系统` |
| `links` | 能点开的出处。没有就省略 |
| `actions` | 只做跳转，不改状态 |

去重：

- 同一张 Ticket 只出一张卡。
- T3 线程、Codex 会话、GitHub PR 都挂到这张卡上，不单独出卡。
- 同一个系统问题重复报，按 `项目 + 问题类型 + 对象` 去重。

## 5. 顶部白话汇报

顶部只写一句到三句白话，不写形容词。

例子：

> 现在 3 件要你定，2 件卡住。今天做完 4 件。

规则：

- 数字从三栏实时算，不单独存。
- 不用 AI 自由发挥。
- 没有要人处理的，就写“现在没有要你定的事”。
- 有实例连不上，单独写一句“FretSense 实例没响应”。

## 6. 对话列表

三栏下面按项目分组，列最近的对话。

每一项：

- 项目名。
- 对话标题。
- 最后活动时间。
- 来源：T3 线程或 Codex 会话。
- 链接。

对话列表只帮人找现场。它不参与三栏判定。

## 7. 丢东西的入口

只做两个入口。

### 入口一：写目标仓库 Issue

默认走这个。

行为：

1. 选项目。
2. 打开目标仓库的 `issues/new`。
3. 标题和正文预填。
4. 人确认后提交。

标题格式：

```text
[board] <一句话>
```

正文至少写：

- 想做什么。
- 为什么现在要做。
- 从总看板的哪张卡过来的。
- 提出人。

不写 secret，不写 token，不写本机路径。

GitHub Source 会把 Issue 变成 Trigger。总看板自己不存这条 Issue。

### 入口二：交给 superagent Trigger

目标：不经过 GitHub，直接把一条东西丢给某个实例。

接口契约：

```http
POST /orchestrator/api/intake
Content-Type: application/json
x-orchestrator-request: 1
```

```json
{
  "project": "fretsense",
  "source": "board",
  "kind": "manual",
  "title": "看一下这个回归",
  "body": "S05 的第四个 CMaj7 又丢了",
  "actor": "owner",
  "clientRequestId": "board_01"
}
```

返回：

```json
{
  "triggerId": "trg_01",
  "threadKey": "board:fretsense:01",
  "ticketId": null
}
```

规则：

- 这个接口必须走正常 intake，再进 Eval。不能绕过 Eval 直接建 Ticket。
- 同一个 `clientRequestId` 重复提交，只建一个 Trigger。
- `ticketId` 可以为空。要不要建 Ticket，由 Eval 决定。
- 这个接口现在底座还没有。W1/W2 落地前，总看板只开 Issue 入口，第二个按钮置灰。
- 接口一旦存在，总看板也不存结果。只显示返回的 `triggerId`，然后刷新。

### 入口不做的事

- 不在总看板里存草稿工单。
- 不在总看板里建本地待办。
- 不复制一份 Issue 内容到浏览器数据库。
- 不自动重试提交。

## 8. 刷新和故障

- 每 30 秒拉一次。
- 单个实例超时 3 秒，不挡住其他实例。
- 连续两次拉不到，卡片标“数据旧了”，并保留最后一次内容。
- 实例恢复后，下一次拉取自动恢复，不需要手动清缓存。
- 总看板自己的缓存只在内存里。刷新页面可以重来。
- 浏览器 `localStorage` 只存界面偏好，比如收起的项目。不存工单状态。

## 9. 视觉

总看板是整页，不是侧栏。

要求：

- 顶部白话汇报。
- 三栏并排。窄屏改成纵向堆叠。
- 每栏按项目分组。
- 卡片之间留白，不卡片套卡片。
- 不用紫蓝渐变。
- 不做 SaaS 仪表盘。
- 不用颜色当唯一状态。标签要写字。
- 每张卡最多两个动作。
- 键盘能走完三栏。

## 10. 检查

必须做到：

- 五个实例都能显示。
- 停掉一个实例，它进“卡住的”，其他项目照常显示。
- 有 `answer` 的工单进“要我定的”。
- 有 `review` 的工单进“要我定的”，不进“做完的”。
- 合并的 PR 进“做完的”。
- Source 报错进“卡住的”。
- 同一张 Ticket 只出现一次。
- T3 线程能按 Assignment 的 `t3ThreadId` 对上，不靠猜。
- Codex 会话链接能打开。
- Issue 入口能打开正确仓库。
- 总看板只发 `GET`。只有人点“交给 superagent”时，才发一次 `POST /intake`。
- 页面能跑起来，并留下截图。

## 11. 非目标

- 不做第二套 Ticket/Assignment 状态。
- 不在总看板里改 Policy、Prompt、Source。
- 不在总看板里重试或停止 Ticket。要改就跳回实例面板。
- 不在总看板里启动或停止实例。实例管理走 `scripts/instances.mjs`。
- 不跨项目合并工单。
- 不用 AI 猜状态。
- 不自动关闭工单。
