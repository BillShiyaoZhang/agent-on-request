# 跨领域研究协作：独立 workspace 与演示指南

入口是 `http://127.0.0.1:4327/research.html`。Alice 是知识图谱／语义技术研究者，Bob 是人机交互研究者。旧日程页面和控制台继续保留。

初始化时，每个 agent 只取得本方的 ontology、研究知识、日程、资料、技能、偏好和授权规则。对方的定义、能力与材料，来自任务中实际收到的消息。三个任务可以沿用同一观众已经积累的知识和长期规则；下一位观众使用新的运行空间。

## 初始内容在哪里

`workspaces/alice/` 与 `workspaces/bob/` 是各自完整、只读、版本化的种子，可以直接展示给观众。两份应用本体都自成体系，包含各自 namespace 中的个人基座。

| 文件 | 内容 |
|---|---|
| `manifest.json` | 本方身份、种子版本、文件清单与 SHA-256 指纹 |
| `ontology.json` | 本方完整概念、关系、继承、属性类型与约束 |
| `knowledge.json` | 有来源的本方研究图谱 |
| `calendar.json` | 本方完整初始日程 |
| `materials.json` | 本方资料版本、字段、来源与公开认证 |
| `interests.json` | 本方研究兴趣 |
| `report-annotations.json` | 本方对公开报告的解释及本方的报告记录类型 |
| `skills.json`、`skills/` | 本方安装的全部 skill 契约与文档 |
| `policies.json` | 可信初始化器使用的初始规则模板，不含旧观众的决定、许可或使用记录 |

`src/research-profiles.mjs` 按指定角色读取本方 manifest 及其列入清单的文件，核验指纹、目录边界、ontology 与事实引用。加载 Alice 不需要 Bob 的目录，反之亦然。文件缺失、未经审阅的改动或跨目录引用会明确阻止初始化。

维护者修改种子并审阅后更新清单：

```sh
node workspaces/update-manifests.mjs alice
node workspaces/update-manifests.mjs bob
```

`workspaces/.gitattributes` 固定种子文本的换行，以便 Windows 和 Linux checkout 保持相同字节指纹。版本和 hash 记录本场使用的起始内容；修改种子从下一位观众的新空间生效。

公共会议节目和模拟场地位于 `demo/environment/conference.json`，没有 Alice／Bob 的个人主题标签。两人的报告解释分别留在本方 `report-annotations.json`。旧的 `profiles/research/*.json` 已迁移；该目录只保留说明。参考对应位于 `demo/acceptance/`，仅供验收显式读取，不复制进 agent 镜像，也不通过任务工具作为答案提供给模型。

## 运行与 Docker 初始化

需要 Node.js 26 或更高版本，本机受控排练运行：

```sh
npm run demo
```

Windows 可使用 `scripts/start-demo.ps1` 或通过 `AGENT_DEMO_NODE` 指定 Node 26+。Guided 调用实际领域工具、授权账本与回执链路，不调用外部模型。它使用确定性的字面文本比较提出和审阅对应候选，没有预置跨域映射答案。这个启发式仅支持受控排练，不是完整的语义匹配器或 OWL 推理器，也不保证自动得出所有“相关／上下位”关系。

Docker 默认启用 `HERMES_RESEARCH_ENABLED=1`。按[Docker 启动指南](hermes-docker-demo.md)配置模型凭据及相邻 KG 插件后运行：

```sh
docker compose up -d --build --wait
```

Alice、Bob 使用各自构建的 Hermes 镜像、独立 profile volume 和角色凭据。每个角色镜像只打包本方种子，并将本方 `workspaces/<role>/` 只读挂载到 `/workspace/seed`，按本方 manifest 校验并安装本方 skills；没有对方种子或验收参考映射。

原生模式只启用准确的 `research` toolset 和本方只读 skill 加载。终端、任意浏览器／HTTP、配置写入、技能修改及额外工具集关闭，API 的 `max_turns` 为 24，服务另有每轮工具及每方运行预算。profile 级自动 KG／用户记忆关闭，知识经当前 experience 的工具取回。

Hermes 每轮使用新 Runs 会话，不选择前一轮的 `session_id`、`previous_response_id` 或共享会话键。需要延续的任务状态和知识由 `task_status`、`knowledge_search` 等取回，不依赖旧对话注入。需要主人决定时持久化 checkpoint 并停止本轮，决定到达后另起一轮。

Docker 与双 Hermes 配置使用既有 agent-comm bridge，实际交换请求、定义、资料、映射提案与审阅决定。未配置 bridge 的纯本机 Guided 使用受控本地投递；该路径用于离线排练和测试。双方不需要额外预先接受一套语义、日期或资源表示协议，agent 可以根据实际交流理解、转换和询问。工具所需的结构化输入以及服务的 ID、版本、hash 是内部执行与核验机制。

关键连接：

| 配置 | 用途 |
|---|---|
| `DEMO_HERMES_ALICE_URL` / `DEMO_HERMES_BOB_URL` | 两个独立数字回环 Hermes API 地址 |
| 对应 `DEMO_HERMES_*_KEY` | 本方 Runs API 凭据 |
| `DEMO_KG_ALICE_URL` / `DEMO_KG_BOB_URL` | 两个角色的原生 KG 服务 |
| 对应 `DEMO_KG_*_SERVICE_TOKEN` | 本方服务凭据，不是主人审批凭据 |
| `DEMO_RESEARCH_GATEWAY_URL` | 原生工具回调来源；Compose 为 `http://demo:4330` |
| `HERMES_RESEARCH_ENABLED=0` | 显式恢复保留的旧单轮 Hermes 日程配置 |

4330 只供容器网络连接，不发布为宿主机端口。凭据从私有文件读取，不作为模型工具参数返回。旧单次提案客户端与研究工具配置分别使用，不混用。

## 每位观众的运行空间

`scripts/demo.mjs` 的本机数据根目录是 `.data/demo`，双 Hermes 模式为 `.data/demo-hermes`。研究协作再使用其下的 `collaboration/`：

```text
.data/<demo-mode>/collaboration/
  workspaces.sqlite
  runs/<experience-id>/
    alice/
      seed/
      manifest.json
      profile.json
      inbox.json
      outbox.json
      artifacts.json
      tasks.json
      authorization.sqlite
    bob/
      ...同样结构
```

`seed/` 是本场初始内容副本；`manifest.json` 记录 experience、角色、seed hash 和 namespace；其余 JSON 是按主人范围保存的可读运行记录。收件、发件、草稿和任务 checkpoint 分别导出，便于演示和检查。控制器密钥、主人凭据及原生准入提示不写进这些可读导出。工作区的任务记录可以包含本方 run／session 引用，帮助核对运行。

Docker 中这些运行目录位于 demo 数据卷，默认容器路径是 `/app/.data/demo-hermes/collaboration/runs/<experience-id>/<role>/`，不是自动创建在宿主仓库根目录的 `runs/`。初始 workspace 仍是项目中可直接展示的 `workspaces/alice/` 与 `workspaces/bob/`。

连接原生 KG 时，每次创建观众身份都用本方经核验的种子建立新的 experience namespace 和 ontology overlay。Bolt 连接可以复用，schema、事实、资料认证、修订与维护状态按 experience 隔离。新空间不导出当前可变的基础 KG 作为起始内容，因此前一场修改的日程、schema、资料、普通记忆及授权投影不会成为下一场的初始知识。

同一观众的三个任务共享本场的本方知识、已收到信息和长期规则。一次许可仍绑定确定任务、内容版本、用途、接收方、期限与次数。下一位观众获得新的身份、项目、双方 KG namespace、运行会话、授权账本及模拟预约状态；旧记录保留以便核验。

页面 **知识与证据** 中的本方 workspace 信息显示起始内容与本场范围。Bob 使用独立的主人窗口查看自己的完整知识和待审内容。双窗观察不授予查看对方私有工作区的权限。

## 知识、技能与实际交换

| 角色 | 个人研究体系 | 日常证据查询 |
|---|---|---|
| Alice | 研究问题、语义模型、映射、数据集、实验、指标、结论与资料版本 | 结论 → 指标 → 实验 → 映射集 → 本体工件版本 |
| Bob | 用户需求、使用情境、交互方案、研究方案、观察、发现与设计启示 | 交互方案 → 设计启示 → 发现 → 观察 → 研究场次 |

研究的 `OntologyArtifactVersion` 是知识对象，不会自动安装成 agent 的运行 schema。人物的专业能力、研究参与者同意、普通事实确认和主人的执行许可分别建模。

每方独立安装六项通用 skills 与四项领域 skills。Alice 包含文献脉络维护、语义模型审阅、实验比较和研究简报；Bob 包含用户研究整理、交互方案评审、发现综合和跨领域交流。通用技能也以本方副本存在，不提前说明另一方词义或指定预期报告。

任务开始时，`peer_describe` 的对方 ontology 和技能为空。只有实际收到 `working-ontology` 或 `capabilities` 消息后，它才返回已收到的内容及来源。请求和提案同样经过通信后才进入对方可见状态。控制器持有的初始化资料和验收参考不会直接作为模型的 peer context。

典型协作顺序：

1. Alice 接收主人的命令，并读取本方知识、技能与授权。
2. 需要对方信息时发送请求。Bob 在收到实际协作通信后开始处理。
3. 双方发送任务所需的定义、能力或资料投影；只根据实际收到的内容讨论含义和方案。
4. Agent 用 `alignment_propose` 选择已披露术语和关系，服务绑定实际定义、来源、版本与 hash；对方通过 `alignment_accept` 明确接受或拒绝。
5. 任务继续使用已经成立的理解和实际交付记录。共同报告的身份还需要核对双方披露的报告记录类型以及具体会议／报告 ID，只有一个无关主题对应不能证明记录同一。

映射不从参考文件中按预置 ID 选择。服务使用已披露来源构造对外说明，避免把任意私有文本通过提案参数发出。任务中的语义接受不产生披露或预约许可。

`knowledge_record` 只记录符合本方类型与关系约束、有来源的私有事实；`artifact_prepare/revise` 保存版本化草稿。公开认证由可信初始化内容和服务记录维护，普通 KG 的“公开”文本不能扩大披露范围。

`knowledge_search` 默认把已经收到的本体和能力描述返回为轻量来源引用，避免在每次查询中重复整份定义或技能正文。需要解释它们时，使用 `peer_describe` 读取实际已经收到的内容。按精确 `ids` 查询只返回相应记录或材料，不顺带展开完整日程、全部资料和授权历史；授权投影按 `recordId` 保留最新的简洁状态及正式查询入口，具体许可仍通过 `authorization_list/check` 取回和核验。

`peer_send` 使用源记录或草稿引用及选定字段，由服务构造确切内容、检查授权后投递。`peer_request` 使用受控请求类别；没有绕过披露门的任意文本发送或任意网络工具。预约表单的 `title`、`day`、`time`、`attendees`、`agenda` 是模拟预约适配器的本地输入契约；提交前校验完整表单、场地容量、时段及冲突。

## 授权记忆与主人入口

每方的 `authorization.sqlite` 是执行依据，KG 中的授权投影用于查找关联和来源，不是许可签发入口。初始 `policies.json` 只有规则模板，可信初始化器为新身份绑定 owner 与 project；旧观众的 Decision、Grant 和 Use 不复制。

账本分别保存长期 Policy、具体 ApprovalRequest、主人 Decision、精确 Grant 和 Operation／Use。默认规则允许在本项目向对端发送已认证公开材料、有限忙闲、个人报告兴趣、任务工作定义和能力描述。私有材料与场地预约有独立的具体请求。

Alice 创建空间时取得自己的主人凭据。**打开 Bob 主人窗口** 提供独立的 Bob 入口；普通 PIN 模式需要操作员登录，纯本机开放控制模式使用该部署的操作员入口。管理员凭据不能代替 Alice 的主人决定，agent 服务凭据也不能批准人类请求。

主人可以批准、收窄或拒绝确定请求。检查覆盖主体、动作、项目／任务、资源版本、接收方、用途、确切内容、期限、撤销和剩余次数。预约必须批准完整表单；旧 revision／hash 和另一位主人的决定被拒绝。普通聊天、“主人已经同意”的对方声明、研究中的 `Decision` 或参与者知情同意都不构成许可。

“以后允许……”可以由原生 agent 通过 `authorization_propose_policy` 提议结构化长期规则。只有可信主人入口确认相同内容 hash 后才生效。后续任务通过 `authorization_list/check` 重新取回和检查当前规则。

授权投影通过持久 outbox 异步进入本方 KG；投影缓慢或失败不阻塞账本上已经允许的动作。执行前重新核验授权并原子预留次数；账本不可用时不执行新操作。超时结果未知时沿原 operation ID 查回执，不直接新建重复预约。撤销阻止后续动作，已经交付的信息和执行回执保留。

## 三场景与观众页面

左右分别显示 Alice、Bob 的对话。开始按钮与手动输入共用 `POST /api/research/workspaces/{id}/commands`，首先把实际主人命令记入 Alice 窗口。未知的 Guided 指令要求选择场景；未知的 Native 指令作为本方私有研究任务，不自动通知 Bob。

两个面板都采用各自 agent 的聊天视角：收到的主人／合作方消息靠右，agent 的回复、发出消息和工作步骤靠左，继续标明消息来源与接收方。工具、运行状态和 checkpoint 按主要步骤插入时间线，默认折叠；展开后查看真实调用及公开进度摘要，参数与输出 JSON 仍可继续展开。新消息和轮询更新保留展开状态与阅读位置。需要人类授权时保持醒目提示，并可跳到具体内容审阅。未获准的对方本地输出保持隐藏；不展示隐藏推理原文，也不补写未记录的思考。

历史授权请求按请求 ID 与当时版本关联主人决定，已处理的消息显示“已拒绝”或“已批准”，不再提示等待决定或链接到已消失的审阅表单。主人可在原消息中展开“查看当时的请求与决定”，检查原始内容、决定时间与实际批准范围；相同请求 ID 的续期版本独立显示。对方主人只能看到已公开的处理状态，不能通过历史入口取回私有表单或决定细节。

- **约讨论**：取回本方规则并交换有限空闲信息，默认种子存在周四 15:00–15:30 的共同时间。忙闲不包含完整日历标题或备注。
- **选报告**：读取各自研究问题和个人报告解释，实际交换定义，提出并审阅对应，再交换参会兴趣。三份报告分别涵盖语义匹配、用户心理模型和可审阅语义映射；当前种子的共同兴趣是 R3。这个结果用于验收，不提前作为模型答案给出。
- **筹备讨论**：交换获准公开介绍，按需要准备私有资料披露请求，继续形成议程和场地表单，再由主人独立决定是否提交预约。可只批准 `summary`、去掉 `method/results/note`；对方消息只出现实际批准并交付的字段。

Guided 有可重复的工具流程，私有材料被拒绝时可以用公开材料继续；预约被拒绝时保留议程和草稿，明确汇报未提交。Native 的具体查找、提案、字段选择与修订由 agents 推进，不能保证每次都以相同顺序或相同文字完成。

具体授权请求进入 pending 后，服务自动保存 checkpoint 并终止该 run；等待对方的显式 checkpoint 同样结束本轮。决定到达后新 run 取回最新状态继续。服务只从实际材料接收、映射接受、保存产物和预约回执确认任务结果；最终模型文本不能覆盖它们。

## 日常研究、恢复与验收

**知识与证据** 页可查询 Alice 的 `claim`、`experiment`、`ontology-source`，或 Bob 的 `design`、`finding`、`observation`，沿返回来源继续检索。Owner API：

```text
POST /api/research/workspaces/{id}/query
Authorization: Bearer <当前主人凭据>
Content-Type: application/json

{"ids":["alice:experiment"],"hops":2}
```

原生私有任务使用 `POST /api/research/workspaces/{id}/research-task` 和 `{"goal":"查找支持这条结论的实验和本体版本，生成有来源的简报。"}`。目标、私有成果及待确认规则只进入本方空间。生成产物继续受披露检查。

重启加载已保存任务、请求、消息与账本。原先运行中的任务暂停，恢复前先核对原 Hermes run 已结束；无法确认时保持角色占用。服务持久化 admission 前的 assignment、幂等请求及准确输入，收到 run ID 后继续保存。旧 assignment 无法借新任务继续调用工具。

Alice 的 `POST /api/research/workspaces/{id}/end` 停止活动任务并保留历史，结束后的身份不能继续开始或恢复任务。**下一位观众 · 新建身份** 结束旧空间，再从经校验的种子建立全新的本场内容。新观众不继承上一场的知识写入、修改、授权或预约。

本次独立 workspace 改造的当前验证记录：

- 最新完整 Node 维护测试共 487 项，484 通过、0 失败、3 项跳过。日志为 `artifacts/research-approval-history-tests.log`，覆盖独立种子、实际定义交换、显式语义审阅、记录身份、角色边界、授权和轻量工具上下文；还验证了 6 个 Worker 并发使用单次许可、持久 outbox 重建与六阶段故障时阻止执行，以及预约中断后重启按原 operation ID 查询结果、撤销后已有回执仍可见。聊天布局覆盖 11 项行为回归：双角色收发方向、主要步骤聚合、异步调用配对、稳定 ID、授权分界及过程摘要的隐私边界；授权历史另有 8 项回归，验证真实预约拒绝、收窄批准、原文和版本保留、续期及角色／任务隔离。
- Python 原生工具插件 21 项、KG 适配器 9 项检查通过。草稿工具仅将有限数值转换为文本；新预约草稿缺少 `fields.title` 时，可复用已经提供的有效外层 `title`，不覆盖显式字段。执行服务仍严格校验原表单，并在主人批准后才执行。
- Native client 的默认和最大运行等待时间均为 `600000 ms`；每次 run 最多 24 轮、64 次工具调用，每方每任务最多 12 次 run，就绪检查仍限 5 秒。
- 2.0.2 种子已部署，6 个 Docker 服务健康。当前部署的 Guided／workspace 验收在 `2026-11-05T21:50:54.493Z` 完成，报告为 `artifacts/research-workspace-acceptance/report.json`。验收先在没有任务时通过实际 API 查询 Alice 的结论、实验和本体版本，以及 Bob 的设计、发现和观察，再完成三个协作场景。另一位观众使用相同 seed hash、相同初始日程／材料／知识，双方获得新的独立 namespace，任务、消息、具体许可和预约历史为空。当前页面也已复核 2.0.2 的空白独立 workspace，截图为 `artifacts/research-independent-workspace-202.png`。
- 当前版本的真实 Native 授权记忆验收在 `2026-11-05T21:51:20.524Z` 完成，报告为 `artifacts/research-independent-memory/report.json`：种子为 2.0.2，确认后的规则可在后续任务取回，没有发送资料，`recoveries` 为空。
- 当前版本的真实 Hermes Native 三场景在 `2026-11-05T22:37:08.018Z` 全部通过，报告为 `artifacts/research-independent-native/report.json`，双方 2.0.2 seed hash 与当前种子一致：找到周四 15:00–15:30 共同时间，交换并审阅实际定义后选择 R3，最后由 Alice 完成唯一一次成功预约并取得 `confirmed` 回执。本次包含 6 次虚构主人通过可信入口作出的实际审批、16 次消息交付；按主人授权 checkpoint 结束当前 run，再启动新 run 继续，没有超时或异常恢复，`recoveries` 为空。

本次原生运行将两种 Alignment 保留为 `related`，没有当作同义词；人工复核决定使用 `close`。本次没有输出显式 `conditional`，该关系的提议与接受在 Guided 场景和原生工具回归中验证。实际映射记录位于 `artifacts/research-independent-native/alignment-dd2d1a83-5c70-4a1a-8774-765260ae7684.json`；同目录的 `execution-dd2d1a83-5c70-4a1a-8774-765260ae7684.json` 核对了批准内容、许可使用次数、执行版本和三处一致的预约回执。

完整维护测试入口是 `npm test`，范围为 `test/*.test.mjs`；`artifacts/` 中的历史实验文件不属于入口。上述 Guided 和 Native 验收均使用实际 agent-comm 与工具执行流程；Native 的计划和工具选择由真实 Hermes agents 推进。

部署上的可重复验收：

```sh
node scripts/research-acceptance.mjs
node scripts/research-acceptance.mjs --native
node scripts/research-memory-acceptance.mjs
node scripts/research-workspace-acceptance.mjs
```

这些脚本默认访问 `http://127.0.0.1:4327`，可用 `DEMO_URL` 指定隔离的本机端口；它们要求开放控制的虚构演示环境，并代虚构主人确认具体请求。报告默认分别写入 `artifacts/research-acceptance-controlled/`、`artifacts/research-acceptance-native/`、`artifacts/research-memory-acceptance/` 和 `artifacts/research-workspace-acceptance/`，可用 `DEMO_ARTIFACTS` 指定本次输出目录。本次确证的 Native 三场景报告使用 `artifacts/research-independent-native/report.json`。历史真实模型报告只能证明生成它们时的版本，不能直接用改造前的报告证明当前版本；应核对各次报告的运行和种子记录。

Native 三场景或授权记忆脚本可额外传入 `--resume-paused`。它只在有界次数和时限内恢复因 `HERMES_RESEARCH_FAILED` 或 `MODEL_TIMEOUT` 暂停的真实任务，继续读取已保存状态；每次恢复必须保留在报告的 `recoveries` 中，不能将恢复后的完成写成没有中断的成功。

持久规则和操作回执的实际应用重启验收命令：

```sh
node scripts/research-restart-acceptance.mjs --restart-qa-app
```

该脚本仅允许本机 `14327` 端口，显式重启隔离的 `agent-on-request-research-qa` 项目中的 `demo` 服务，保留持久数据；检查长期规则与已交付回执仍在、已用单次许可不被新任务复用，以及下一位观众没有之前的授权。本次实际应用重启验收已于 `2026-11-05T22:17:59.346Z` 通过，使用 2.0.2 种子，报告为 `artifacts/research-restart-acceptance/report.json`。

全部人物、材料、实验值、研究观察、会议和预约服务均为虚构数据。当前示例采用固定会议周和模拟场地，不执行真实预订、付款或研究参与者同意管理。模型、KG、Hermes 或通信失败会保留真实暂停／未完成状态，不切换成伪造成功。
