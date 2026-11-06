# 发布条件 Release Conditions

状态：Active
日期：2026-11-07
负责人：Release Engineer / Maintainer
权威来源：`README.md`、`package.json`、`docs/006-deployment.md`、`docs/009-pilot-guard.md`、`docs/007-architecture.md`、`tests/docs.spec.ts`
读者：Maintainer、Operator、Deployer、Reviewer、所有执行 agent
复审：每个发布候选、每次上游同步、每次依赖或数据库 schema 变化；最迟 2026-12-07
取代：无。本文补统一目录树的发布条件页；试点前的安全检查仍以 `docs/009-pilot-guard.md` 为准。

## 这是什么

这是 `dsh-superagent` fork 的发布条件页，回答“什么条件可以发”。它只覆盖这个仓库自己的发布判断，不把 DeepSeek Harness、上游 dsh-superagent 或 OpenClaude Desktop 的发布混进来。

README 已经写明：这是研究原型，不是 DeepSeek 官方产品，也不是 production-ready 软件。本页不改变这个身份；它只是把“什么时候可以切一个 fork 快照、什么时候可以在一个真实仓库上跑实例”写成可检查的条件。

## 发布对象

| 对象 | 含义 | 是否由本页判定 |
| --- | --- | --- |
| 源码快照 / 内部 tag | 这个 fork 的一个可复现提交，带版本号、检查和已知限制 | 是 |
| 单实例内部部署 | 一个 DSH profile、一个端口、一个 stateDir、一个业务仓库 | 是；另需 `docs/009-pilot-guard.md` 的试点签收 |
| 公开 fork 分发 | 把这个研究原型作为 MIT 代码公开给其他团队参考 | 是；仍按研究原型声明，不按产品发布 |
| DeepSeek 官方发布 | 上游官方产品 | 否；本仓库无权代表 |
| 多租户 / SaaS / 生产安全边界 | 多人共用、托管服务或生产级隔离 | 否；当前设计不是这个目标 |

## 硬条件

以下条件全部满足，才可以切源码快照或开始单实例内部部署。任何一项为 `blocked`，都不能用“本地能跑”替代。

| # | 条件 | 判定标准 | 必要证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| 1 | 研究原型身份 | README 的“research prototype / not an official DeepSeek product / not production-ready”声明保留；不得改写成官方产品或生产可用 | `README.md` | `pass` |
| 2 | 工具链 | Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、DSH 在 `engines.dsh` 范围内、git `2.32+`、tmux、Python `3.8+`、GitHub CLI `2.48+` | `package.json`、`SETUP.md`、`docs/006-deployment.md` | `pass`（文档已写明） |
| 3 | 锁定安装 | `pnpm install --frozen-lockfile` 成功，锁文件不漂移 | 安装输出、`pnpm-lock.yaml` | `pass`：2026-11-07 通过 |
| 4 | 自动检查 | `pnpm check` 全绿：`pnpm typecheck`、`pnpm test`、`pnpm build` | 命令输出、提交 SHA | `pass`：2026-11-07 通过；63 个测试文件 / 1240 个测试 |
| 5 | 文档完整性 | `tests/docs.spec.ts` 随测试通过：编号文档连续、编号文档只链接更早文档、入口/编号文档本地链接可解析、顶层文档无冲突标记、`007` 的模块和测试表覆盖实际文件 | `pnpm test` 输出、`tests/docs.spec.ts` | `pass`：属于 `pnpm check` |
| 6 | 构建产物 | `lib/` 由 `src/` 构建生成，已 gitignore；发布产物包含构建后的 `lib/`，源码提交不手改 `lib/` | `pnpm build` 输出、`.gitignore`、`package.json#files` | `pass` |
| 7 | 秘密与凭据 | 仓库内无 `.env`、token、API key、cookie、SSH key、许可证秘密；stateDir 和 CLI 配置不进仓库；Feishu secret 通过 stdin 输入 | `git status`、`.gitignore`、`docs/006-deployment.md` | `pass as rule`；每次发布前复查 |
| 8 | 安全边界 | 明确记录 `danger-full-access`、operator OS user、wrapper 不是隔离边界；真实仓库试点按 `009` 使用独立 agent 账号、分支保护、人工合并，优先独立 OS 用户/容器/VM | `docs/009-pilot-guard.md` 签收记录 | `blocked`：真实试点尚未在本仓库留下签收 |
| 9 | 授权默认值 | 允许名单非空；accept mode 默认 `observe`；auto-merge 默认关闭；分支前缀默认 `agent/`；人合并 PR | `SETUP.md`、`docs/002-authorization.md`、`docs/006-deployment.md` | `pass as default` |
| 10 | 数据与迁移 | `stateDir` 备份；SQLite 当前 schema 11；旧 schema 10 只迁移一次；更新版本数据库拒绝启动；`tests/migration.spec.ts` 通过 | `docs/007-architecture.md`、`tests/migration.spec.ts` | `pass`：属于 `pnpm check` |
| 11 | 部署冒烟 | `scripts/dsh-superagent status` 退出 0；setup 无遗留项；面板可打开；目标 Source 正常；hourly check 已建 | `status` 输出、面板 URL、Source 状态 | `pending`：本仓库只验证源码，没有目标机部署状态 |
| 12 | Fork 增量边界 | 三份 fork 契约 `ARCHITECTURE_架构.md`、`DOMAIN_CONTRACT_域契约.md`、`BOARD_CONTRACT_面板契约.md` 只写 fork 增量；领域术语仍以 `001` 为准；总看板仍属 W3，不塞进单项目实例 | 三份契约、`README.md` | `pass as rule` |
| 13 | 发布证据包 | 至少包含提交 SHA、`package.json` 版本、Node/pnpm/DSH 版本、`pnpm check` 输出、构建产物哈希、部署 `status` 输出、已知限制 | 发布记录或 PR | `pending` |
| 14 | Owner 验收 | Maintainer 记录“发的是源码快照还是单实例部署”、接受的风险和未完成项；不把研究原型说成生产发布 | 发布记录、`DECISIONS.md`（当前缺） | `pending` |

## 当前结论

源码快照可以进入候选，但还不能宣称已经发布或可生产使用。

2026-11-07 在当前 `origin/main` 的干净工作树上验证过：

- `pnpm install --frozen-lockfile` 通过；
- `pnpm typecheck` 通过；
- `pnpm test`：63 个测试文件、1240 个测试通过；
- `pnpm build`：`tsdown` 构建完成，输出 `lib/`。

同时确认：

- 仓库没有 GitHub Actions 工作流，发布检查目前靠本地 `pnpm check`；
- 没有 git tag，也没有 GitHub Release；
- 没有目标机的 `scripts/dsh-superagent status` 结果；
- 没有真实仓库试点的 `009` 签收记录。

因此：

- **可以**：在 owner 接受已知限制后切一个研究原型源码快照，或在一个隔离环境里按 `SETUP.md` 做部署演练。
- **不可以**：对外说它是 DeepSeek 官方产品、production-ready、多租户安全边界或已经通过真实试点。

## 发布候选检查单

- [ ] 这次发的是源码快照、单实例部署，还是公开 fork 分发？
- [ ] README 的研究原型声明是否还在？
- [ ] `pnpm install --frozen-lockfile` 和 `pnpm check` 是否在同一个提交上通过？
- [ ] 测试数、构建输出和 Node/pnpm/DSH 版本是否记录？
- [ ] `git status` 是否干净，`lib/`、stateDir、`.env`、凭据是否没有混进提交？
- [ ] 目标机 `scripts/dsh-superagent status` 是否退出 0？setup 是否无遗留项？
- [ ] 真实仓库试点是否按 `docs/009-pilot-guard.md` 签收？独立账号、分支保护、人工合并是否落实？
- [ ] 数据库 schema 是否需要迁移？`stateDir` 是否已备份？
- [ ] 三份 fork 契约是否仍只写增量，没有改写 `001` 的领域术语？
- [ ] 已知限制、回退方式和谁负责合并是否写清楚？

## 不能用的替代证据

- `pnpm build` 成功不等于部署成功。
- `status` 退出 0 不等于安全边界成立。
- 1240 个测试通过不等于真实仓库试点通过。
- 上游 dsh-superagent 的发布说明不等于这个 fork 的发布资格。
- 本地 DSH 面板能打开不等于目标 Source、账号或 Feishu bot 已配置正确。

## 维护规则

- 每次上游同步后重新跑 `pnpm check`，并复核 `docs/009-pilot-guard.md` 是否仍匹配当前代码。
- 每次依赖、Node/pnpm/DSH 版本、数据库 schema 或部署步骤变化时更新本页。
- 新增 GitHub Actions 时，把 CI 结果加入硬条件；当前没有 CI，不能写成“CI 已通过”。
- 本页不复制 `009` 的全部试点步骤；安全签收以 `009` 为准。
- 本页不把没有签收的真实试点、没有目标机的部署或没有 tag 的提交标成已发布。

## 相关

`README.md`、`SETUP.md`、`docs/006-deployment.md`、`docs/009-pilot-guard.md`、`docs/007-architecture.md`、`docs/80_协作/DOCUMENT_REGISTRY_文档登记表.md`
