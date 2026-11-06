# 文档登记表 Document Registry

状态：Active
日期：2026-11-07
负责人：Knowledge Curator
权威来源：`README.md`、`docs/` 当前目录、`tests/docs.spec.ts`
读者：Maintainer、Operator、Reviewer、所有执行 agent
复审：每次文档增删、每次上游同步、每季度；最迟 2026-12-07
取代：无。本文补统一目录树的 80 协作槽位，不取代 `docs/007-architecture.md` 的模块/测试索引。

## 这是什么

这是 `dsh-superagent` fork 的文档登记表，回答“每个文档谁负责、给谁看、什么时候复审、现在是什么权威级别”。它补的是统一目录树的 80 协作槽位，不建空模板。

2026-11-07 实际清点：`docs/` 下有 15 个 Markdown 文件（13 个原有文件加本次新增两页），根目录有 `README.md`、`SETUP.md`，`prompts/` 有 15 个 Markdown，`skills/` 有 2 个 `SKILL.md`。复现命令：

```bash
rg --files docs -g '*.md' | wc -l
rg --files prompts -g '*.md' | wc -l
rg --files skills -g 'SKILL.md' | wc -l
```

## 状态与权威级别

| 标记 | 含义 |
| --- | --- |
| `authority` | 当前文档权威；冲突时优先读它 |
| `current-evidence` | 当前证据；证明范围内的事实，不自动变成权威 |
| `reference` | 参考、示例或说明；执行前核对当前代码 |
| `generated` | 由构建生成；从源重建，不手改 |
| `missing` | 统一目录树要求但当前没有；继续标缺 |

## 根目录

| 路径 | 负责人 | 读者 | 复审触发 | 状态 |
| --- | --- | --- | --- | --- |
| `README.md` | Maintainer | Operator、Contributor、Agent | 产品身份、安装或目录变化时；每个发布候选 | `authority`（入口和身份声明） |
| `SETUP.md` | Deployment Owner | Operator、负责安装的 Agent | 安装问题、账号或默认值变化时 | `authority`（setup 流程） |
| `LICENSE` | Maintainer | 所有使用者 | 许可证变化时；每次分发 | `authority`（MIT） |

## 编号文档

| 路径 | 负责人 | 读者 | 复审触发 | 状态 |
| --- | --- | --- | --- | --- |
| `docs/000-philosophy.md` | Maintainer | 所有使用者、Agent | 产品原则变化时 | `authority` |
| `docs/001-domain.md` | Domain Owner | 实现、Agent、Reviewer | 领域对象或术语变化时 | `authority`（领域术语） |
| `docs/002-authorization.md` | Policy Owner | 实现、Operator、Agent | 允许名单、admission 或 accept mode 变化时 | `authority` |
| `docs/003-execution.md` | Runtime Owner | 实现、Executor、Reviewer | Ticket 阶段、执行或合并规则变化时 | `authority` |
| `docs/004-prompts.md` | Prompt Owner | Maintainer、Agent、Reviewer | prompt 部件、默认文本或版本规则变化时 | `authority` |
| `docs/005-panel.md` | Panel Owner | Operator、Frontend、Reviewer | 面板页、设置组或交互变化时 | `authority` |
| `docs/006-deployment.md` | Deployment Owner | Operator、Deployer、Agent | 安装、配置、升级或故障排查变化时 | `authority` |
| `docs/007-architecture.md` | Architecture Owner | 实现、Reviewer、Agent | 模块、测试或架构变化时 | `authority`（模块/测试索引） |
| `docs/008-cookbook.md` | Maintainer | Source 作者、实现 | 新增 Source 或扩展方式变化时 | `reference` |
| `docs/009-pilot-guard.md` | Pilot Owner | Operator、Security、Reviewer | 真实仓库试点前；安全边界变化时 | `authority`（试点安全签收） |

## Fork 增量契约

| 路径 | 负责人 | 读者 | 复审触发 | 状态 |
| --- | --- | --- | --- | --- |
| `docs/ARCHITECTURE_架构.md` | Fork Architecture Owner | Deployer、W1/W2/W3 执行线 | 实例、端口、stateDir、写线/读线变化时 | `authority`（仅 fork 增量） |
| `docs/DOMAIN_CONTRACT_域契约.md` | Fork Domain Owner | 实现、Reviewer | T3、`psa-report`、`whoSaid` 增量变化时 | `authority`（仅 fork 增量） |
| `docs/BOARD_CONTRACT_面板契约.md` | Board Owner | W3、维护者 | 总看板接口或三栏规则变化时 | `authority`（仅 W3 契约） |

## 本次补的两页

| 路径 | 负责人 | 读者 | 复审触发 | 状态 |
| --- | --- | --- | --- | --- |
| `docs/50_完成标准/RELEASE_CONDITIONS_发布条件.md` | Release Engineer | Maintainer、Operator、Deployer、Reviewer | 每个发布候选；上游同步；依赖或 schema 变化 | `authority`（发布条件） |
| `docs/80_协作/DOCUMENT_REGISTRY_文档登记表.md` | Knowledge Curator | 所有 agent、Maintainer、Reviewer | 文档增删；上游同步；每季度 | `authority`（登记规则） |

## Prompts、skills、代码与生成物

| 路径族 | 负责人 | 读者 | 复审触发 | 状态 |
| --- | --- | --- | --- | --- |
| `prompts/*.md`、`prompts/team/*.md` | Prompt Owner | Router、Worker、Reviewer | prompt 行为或默认文本变化时 | `authority`（prompt 文本） |
| `skills/*/SKILL.md` | Skill Owner | Agent、Reviewer | skill 行为变化时 | `authority`（skill 指令） |
| `src/**` | Code Owner | 实现、Reviewer | 每次代码变更 | 代码权威；不属于文档登记 |
| `tests/**` | Test Owner | 实现、Reviewer、Release Engineer | 每次行为或证据变化 | 测试证据；`tests/docs.spec.ts` 管文档检查 |
| `scripts/**` | Ops Owner | Operator、Deployer | 启停、状态或部署脚本变化时 | 运维权威 |
| `lib/**` | Build Owner | 使用者、Deployer | 每次 `pnpm build` | `generated`；不要手改 |

## 统一目录树缺口

按 2026-11-07 的 gap 清单核对，本次只补两页；其余缺的继续标 `缺`，不建空模板。

| 槽位 | 当前状态 | 说明 |
| --- | --- | --- |
| 根目录六件 | 缺 | 有 `README.md`、`SETUP.md`、`LICENSE`；缺 `AGENTS.md`、`AGENT_STARTUP.md`、`DECISIONS.md`、`PROJECT_STATUS.md`、`EVIDENCE_INDEX.md` |
| `docs/00_定义` | 部分 | 有 `000`、`001` 和域契约；缺独立 PRD、术语表 |
| `docs/10_产品` | 部分 | 有 `005` 和面板契约；缺体验页、路线图 |
| `docs/20_系统` | 部分 | 有 `002`、`003`、`006`、`007` 和三份契约；缺独立数据模型页、接口约定页；安全与试点边界在 `009` |
| `docs/30_设计` | 部分 | 有 `005` 的界面原则和面板契约；缺设计系统页、文案与语气页 |
| `docs/40_执行` | 缺 | 缺当前状态页、阶段约定、交接目录、工作单目录 |
| `docs/50_完成标准` | 部分 | 发布条件已补；产品级完成标准页仍缺；`009` 是试点检查单，不是完成标准 |
| `docs/60_研究` | 缺 | 缺技术雷达、参考项目研究 |
| `docs/70_历史` | 缺 | 缺 `_history/`、`_archive/`、归档说明 |
| `docs/80_协作` | 部分 | 本表补文档登记；`README`/`SETUP`/`000`/`004` 承担部分工作流说明；缺独立 agent 工作流页 |

## 登记与复审规则

1. 先匹配最具体的路径族。族内文件默认继承该行的负责人、读者和复审触发。
2. 新增 durable 文档，先在本表加行，再让它成为 authority。没有登记的文件只能当草稿或证据。
3. 一个文档只能有一个负责人；可以有多个读者。负责人不变，具体聊天可以换。
4. `generated` 和 `current-evidence` 不能靠反复引用变成权威。要升级，先走对应文档或发布决定。
5. `tests/docs.spec.ts` 只检查根目录入口、顶层编号文档和顶层文档的冲突标记；新增子目录文档仍要自己检查链接和冲突标记。
6. 文档与当前代码冲突时，以当前代码和最新维护者决定为准；修正在本表或对应文档记录。
7. 生成物、构建输出和测试 artifacts 不逐个登记；`lib/` 继承 `src/` 的 Build Owner，测试继承 Test Owner。
8. `node_modules/`、`.artifacts/`、`stateDir` 和本机配置不在本表范围。

## 复审记录

| 日期 | 复审人 | 结果 | 下一步 |
| --- | --- | --- | --- |
| 2026-11-07 | Knowledge Curator | 首次登记；覆盖当前 15 个 `docs/` Markdown、2 个根文档、15 个 prompt 和 2 个 skill；补发布条件页和本表 | 2026-12-07 前复查；上游同步或真实试点前重查发布条件和 `009` |

## 相关

`README.md`、`SETUP.md`、`docs/007-architecture.md`、`docs/009-pilot-guard.md`、`docs/50_完成标准/RELEASE_CONDITIONS_发布条件.md`
