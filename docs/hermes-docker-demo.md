# Docker 双 Hermes 演示

把 `.env.example` 复制为项目根目录的 `.env`，填入现有 MiniMax 中国区 Token Plan 的 `MINIMAX_CN_API_KEY`。构建还需要 KG-plugin 源码，默认位置为仓库旁边的 `../hermes-kg-plugin`。其他位置可在 `.env` 设置 `KG_PLUGIN_SOURCE`。从项目根目录启动。

```sh
docker compose up -d --build --wait
```

观众打开[演示首页](http://127.0.0.1:4327/)，先浏览架构，再选择 **Live**、审阅本体对齐并批准空闲时间。补充周四后，操作员在[控制台](http://127.0.0.1:4327/console)代 Bob 主人审阅简报，可以只允许主题或拒绝简报。观众在总结页查看结果和协作记录。操作员也可以在控制台检查两个 Agent Comm 端点和编辑新一轮的初始状态。

Compose 运行两个 Hermes gateway、双方 KG-plugin 原生工作台、Neo4j 和演示容器。Alice 和 Bob 的 Live 推理使用各自 Hermes profile 中配置的模型，初始设置为 `MiniMax-M3.1-Flash`（MiniMax 中国区）。Compose 把根目录 `.env` 的模型密钥作为 secret 交给两个 Hermes 容器。两端分别生成和保存本地 gateway 密钥，共享 MiniMax 账户额度。Live 会把各端用于规划的虚构数据发到模型供应商。

Alice 和 Bob 各有独立的 profile 数据卷、gateway 密钥、KG namespace、工作台凭证、私有通信网络和出网网络。每个 KG 工作台与对应 Hermes provider 使用相同的 profile 和 Neo4j namespace。演示容器经各自的私有网络访问两端 gateway，并在自身回环上运行 agent-comm 的两个签名对等端口。管理网页端口发布到宿主回环。首次构建需要下载镜像、Go 依赖、KG-plugin 的锁定 Python 依赖并构建其原生网页。

## 原生管理界面

从演示控制台的原生管理入口打开对应角色的页面。KG 工作台的链接携带该角色的本机认证信息，页面连接后即可使用图谱和本体管理。复制这些链接时应保留在本机操作员环境中。

| 入口 | 默认本机端口 | 管理内容 |
| --- | --- | --- |
| 观众演示 | 4327 | Alice 操作、协作进展、结果和实际回执 |
| 演示控制台 | 4327 的 `/console` | 轮次、Agent Comm、Bob 授权审批、恢复和研究回顾 |
| Alice KG-plugin | 8765 | Alice 的初始知识、日历与实际收到的信息 |
| Bob KG-plugin | 8766 | Bob 的初始知识、可用时间、简报与实际收到的信息 |
| Alice Hermes Dashboard | 9119 | Alice 的模型、技能、工具、profile 和会话 |
| Bob Hermes Dashboard | 9121 | Bob 的模型、技能、工具、profile 和会话 |

首次启动会在缺少演示初始记录时写入虚构数据。之后在 KG-plugin 原生工作台更正初始记录，或在 Hermes 原生技能页面编辑、停用技能，下一轮演示会读取这些记录与技能。已经开始的轮次使用自己的已持久化初始化快照。预览不会把信息写入对端 KG；接收端确认后的精确字段和回执才会进入本轮接收记录。总结页从同一份 KG 轮次快照读取结果与协作过程。

KG 保存本场业务快照和已确认回执。观众的可选研究记录开关控制研究回顾与导出，KG 的业务持久化独立于该开关。所有示例数据均为虚构。

## 管理

```sh
docker compose ps
docker compose logs -f demo hermes-alice hermes-bob
docker compose stop
```

重新运行启动命令即可恢复。`stop` 会保留独立的 profile 卷和演示数据。若 `4327` 被占用，在 `.env` 设置 `DEMO_DOCKER_PORT=4337`。更换 MiniMax 密钥后，运行 `docker compose up -d --force-recreate --wait` 让容器读取新的 secret。

后续可分别通过对应 Hermes Dashboard 或 `docker compose exec hermes-alice hermes config`、`docker compose exec hermes-bob hermes config` 管理角色。双方启用真实 KG memory provider。演示 API 规划由适配器使用本轮显式快照，关闭该调用的历史自动召回、自动记忆写入与后台抽取，避免旧轮次信息进入当前任务。普通 Hermes 原生聊天继续使用其 KG provider。演示的 API 工具集保持受控配置，实际信息交付仍经过当前轮次的明确共享选择和 Bob 审批。

## 本机验收

`node scripts/kg-native-smoke.mjs` 使用 Controlled 模式运行真实 KG、原生更正和完整审批路径。它会暂时更正一条虚构初始日历记录，验证下一轮读取该值，结束后恢复原值。验证还覆盖只读的已冻结轮次、预览不写入对端、缩小到主题的实际回执，以及同操作重试与冲突。该脚本不调用外部模型。

脚本报告默认保存在 Git 忽略的 `artifacts/kg-native-smoke/report.json`。重启 `kg-alice`、`kg-bob` 后，再运行 `node scripts/kg-native-smoke.mjs --verify-persisted`，可核对双方已保存的结果与精确回执。

`node scripts/kg-native-ui-smoke.mjs` 使用已有 Playwright 与浏览器检查双方原生图谱、Hermes 技能和配置页面。可用 `DEMO_PLAYWRIGHT_MODULE`、`DEMO_BROWSER_EXECUTABLE` 指定本机安装位置。

`node scripts/kg-native-skill-smoke.mjs` 通过 Hermes 原生技能接口临时停用 Alice 的发送技能，验证下一轮确实拒绝发送，然后恢复原状态并结束验证轮次。它使用相同的 Playwright/浏览器设置与 Controlled 模式。
