# 跨领域研究协作：实现与操作指南

新入口是 `http://127.0.0.1:4327/research.html`。旧日程演示和控制台继续保留。

Alice 是知识图谱／语义技术研究者，Bob 是人机交互研究者。每人都有自己的应用本体、研究知识、资料、日程、技能和授权记录。三个协作任务使用同一个身份空间；下一位观众应创建新的身份空间。

## 启动与执行模式

使用 Node.js 26 或更高版本。

```sh
npm run demo
```

Windows 可运行 `scripts/start-demo.ps1`，或者通过 `AGENT_DEMO_NODE` 指定 Node 26+。这个启动方式支持不调用外部模型的 **Guided / 受控排练**：规则驱动器调用实际领域工具、授权服务和签名消息／回执链路。

Docker Compose 默认设置 `HERMES_RESEARCH_ENABLED=1`，启用 **Native Hermes / 原生技能** 模式。按[现有 Docker 启动指南](hermes-docker-demo.md)配置模型凭据及相邻 KG 插件后启动：

```sh
docker compose up -d --build --wait
```

原生模式使用两份独立 Hermes profile、原生多轮工具调用及本方只读 skill 加载。启动时核对实际工具清单，必须只有准确的 `research` toolset；终端、任意浏览器／HTTP、技能写入和其他工具集不属于允许清单。配置将 API 运行的 `max_turns` 设为 24；任务服务还限制每轮工具次数及每方的任务运行次数。

`HERMES_RESEARCH_ENABLED=0` 可明确恢复旧的单次提案 Hermes 配置。旧提案客户端要求 API 工具全部关闭，不能与原生研究配置混用。

本机 `npm run demo:hermes` 还需要事先配置两份原生 profile。关键连接如下：

| 配置 | 用途 |
|---|---|
| `DEMO_HERMES_ALICE_URL` / `DEMO_HERMES_BOB_URL` | 两个独立的数字回环 Hermes API 地址 |
| 对应的 `DEMO_HERMES_*_KEY` | 各自的 Runs API 凭据 |
| `DEMO_KG_ALICE_URL` / `DEMO_KG_BOB_URL` | 本方原生 KG 服务 |
| 对应的 `DEMO_KG_*_SERVICE_TOKEN` | 服务写入与角色绑定凭据，不能作为主人审批凭据 |
| `HERMES_RESEARCH_ENABLED=1` | 在应用与 Hermes profile 中启用原生研究配置 |
| `DEMO_RESEARCH_GATEWAY_URL` | Hermes 工具回调的应用来源地址 |

Compose 中回调地址是 `http://demo:4330`，该端口仅供容器网络连接，没有发布为宿主机端口。本机原生配置应指向实际的本机应用地址。工具插件从私有 token 文件读取凭据；凭据不会作为模型工具参数或结果返回。

## Ontology 与个人知识

本体来源位于 `profiles/research/`，由 `src/research-profiles.mjs` 加载、补齐个人基座、生成独立 namespace 并校验。profile 包含模块依赖、概念定义、继承、属性类型、关系的定义域／值域，以及定义摘要。研究对象的 ontology 工件与 agent 自身的应用 schema 分别建模。

| 角色 | 主要模块 | 日常检索路径 |
|---|---|---|
| Alice | 研究问题、语义模型、映射、数据集、实验、指标、结论与研究资料 | 结论 → 指标 → 实验 → 映射集 → 精确本体版本 |
| Bob | 用户需求、使用情境、原型、研究方案、观察、发现及设计启示 | 交互方案 → 设计启示 → 发现 → 观察 → 研究场次 |
| 双方 | 人物、组织、项目、任务、目标、偏好、时间、学术活动、资料版本及来源 | 从各自的研究问题安排阅读、参会和讨论 |

连接原生 KG 时，适配器安装 personal 基座与领域定义，将资料和图关系写入各自的原生空间。后续导出读取当前原生 schema 和事实，演示使用本轮冻结的 profile。改变初始本体或数据后，应创建新身份空间读取新的起始条件；旧空间保留自己的已审阅定义和数据。

公开材料有服务侧保存的原始内容／版本认证。普通 KG 写入不能签发公开认证；编辑已认证材料的字段或版本会使认证失效，导出为私有材料。普通 agent 记录的研究事实和生成草稿同样保持私有。`visibility` 文本或人物研究中的 `Decision` 不会产生执行权。

按任务交换 ontology 的 working subset，而非完整私人图谱。领域候选对应是有界的：人工复核决定可以在限定条件下对应，Provenance 与 Transparency 保留相关关系，词面相同的两种 Alignment 不被认作等价。选择具体报告还需要个体报告的对应关系；只接受一个相关主题关系不足以完成该任务。

这套实现没有宣称任意未知本体的自动对齐或完整 OWL 推理。模块、类型、版本、声明关系和数据引用得到校验；报告筛选使用明确的会议／报告 ID 和各自的研究兴趣。

## Skills 与工具如何配合

实际 skill 文档位于 `skills/research/`。每个研究者包含自己的四项领域技能，以及日程协调、参会规划、讨论筹备、材料分享、授权记忆和资源协调等共同技能。manifest 声明依赖模块、输入输出类型、工具及外部影响。

- Alice：文献与研究脉络、语义模型审阅、实验比较与结论追踪、研究交流简报。
- Bob：用户研究整理、原型与交互方案评审、研究发现综合、跨领域交流准备。

原生工具使用下划线名称，例如 `knowledge_search`、`knowledge_record`、`ontology_describe`、`artifact_prepare`、`alignment_propose`、`peer_send`、`authorization_check`、`authorization_request`、`reservation_submit` 和 `receipt_inspect`。skill manifest 中的点号名称表达同一能力的逻辑分组。

`knowledge_record` 允许在本方 ontology 内记录有来源的研究事实和合法关系，检查类型、属性、版本、声明的枚举／数值／长度约束及关系端点；它不能签发授权或把资料自行变成公开材料。`artifact_prepare/revise` 保存版本化草稿；生成摘要不会自动允许发送。

预约草稿在生成与修订时就检查必填字段和类型：`title`、`day`、`time`、`attendees`、`agenda` 使用文本字段，`day` 是星期标签，`time` 是合法同日时段，`attendees` 是正整数人数的文本表示。场地查询可按设备需求筛选；提交还检查容量、可用时段及时间冲突。检查失败不构造成功回执。

`peer_send` 只接受源记录／草稿引用和选定字段。服务从当前记录构造实际 payload，检查身份、资源版本和许可，然后生成签名消息及接收回执。`peer_request` 采用固定请求类别；没有任意自由文本消息旁路。

双方知识查询只返回本方记录和实际收到的信息。对方待审批内容、私有草稿、checkpoint 文本和预约表单值不因任务状态共享而可见。

## 授权记忆与两个主人入口

授权是业务控制记录，不依赖是否同意收集研究记录。

- `workspaces.sqlite` 保存可恢复的身份空间、任务、版本化草稿及消息／预约记录。
- 每个身份空间另有 `alice.sqlite` 和 `bob.sqlite`，分别保存各自主人的长期 Policy、ApprovalRequest、Decision、Grant 和 Operation／Use。
- 授权账本通过持久 outbox 异步向本方 KG 投影关联与解释。任务先提交本地可发现投影，后台发送并定时重试；缓慢或不可用的 KG 投影不阻塞已获准的通信和预约。KG 可以帮助查找记录，但执行时始终回到账本校验。投影失败不会把有效许可改成无效，也不会将未批准动作变成成功。

Alice 创建身份空间时取得 Alice 专用凭据。页面里的 **打开 Bob 主人窗口** 使用独立 Bob 入口：普通 PIN 模式需要操作员登录取得 Bob 凭据；仅本机开放控制模式沿用本机操作员权限。操作员登录凭据本身不能批准 Alice 的请求，也不能读取 Alice 的 owner API。工具服务凭据同样不能充当主人凭据。

授权页可确认和保存结构化长期规则，或撤销现有规则。默认允许在当前协作项目中向固定对端分享已认证公开材料、有限忙闲和参会兴趣；材料披露与场地预约使用各自具体请求。

原生研究任务也可以接收“以后允许……”之类的主人目标。Agent 使用 `authorization_propose_policy` 把它整理成待确认候选，候选本身没有执行权。主人在授权页审阅准确接收方、用途和资源范围后确认；`POST /api/research/workspaces/{workspaceId}/policy-candidates/{candidateId}/decision` 使用 `decision` 和 `expectedHash` 绑定这份候选。只有可信主人决定写入的正式 Policy 才参与后续检查。普通聊天文本、对方关于“主人已同意”的声明、记忆确认和论文中的同意记录都不会自动签发许可。

每次外部动作的检查包含：本地主人、动作、项目／任务、资源 ID 和版本、接收方或服务、用途、字段及实际内容、期限、撤销和剩余次数。审批可收窄材料字段；预约必须审阅并批准完整表单。旧请求版本、旧内容 hash 和跨主人决定会被拒绝。

长期规则跨本身份空间的任务保存；一次 Grant 只覆盖其确定的任务和内容。明确禁止和撤销优先，拒绝同一具体请求后不会自动反复弹窗。账本不可用时不执行新的披露或预约。

## 三场演示的操作脚本

协作页左右分别是 Alice（Agent A）和 Bob（Agent B）的任务对话窗口。三个「开始」按钮通过与手动输入相同的 `commands` 入口，把主人指令记入 Alice 的对话，再启动相应任务。可以直接输入「请和 Bob 约一次学术讨论」「选择共同参加的报告」或「筹备讨论并预约场地」，也可以在输入框中明确选择任务类型。

主对话按实际顺序，用自然语言展示主人指令、双方请求、已交付内容摘要、授权决定及核验结果，并醒目标明消息来自谁、发给谁。忙闲以可读的星期和时段呈现，报告兴趣使用实际报告名称，资料摘要仅包含实际获准并交付的字段。工具调用集中放在默认折叠的「执行细节」，每条消息的 JSON、版本和回执同样默认折叠。

每个窗口顶部显示该 agent 当前在做什么，或正在等待哪一方；需要人类授权时显示醒目的授权提示。本方主人可以直接跳到具体审批卡片，逐项查看自然语言内容并批准、收窄或拒绝。对方等待授权不会被误写成自己的主人需要审批，历史任务也不会显示另一项任务的待审卡片。

这些摘要来自实际记录，不另行编造 agent 对话。资料消息对应服务保存的真实接收回执；工具完成、授予许可和业务任务完成分别展示。原生模型的最终答复只是说明，任务结果仍由实际材料接收、映射接受和预约回执核验。

双方窗口共享任务中可观察的动作及已交付的信息。对方本地检索结果、私有草稿、主人指令和授权内容不会因为出现在双窗中而额外披露；未获准的内容显示为隐藏。授权请求的确切内容由本方主人窗口审阅。任务对话持久保存，刷新或重启后可继续查看，历史任务也能切换回看。

Guided 使用固定的领域工具流程；手动指令用于选择这三个场景。更自由的研究要求应使用 Native Hermes。不匹配场景的原生指令作为 Alice 的私有研究任务执行，不会自动通知 Bob。自然语言中写「已同意」也不构成披露或操作授权。

```text
POST /api/research/workspaces/{workspaceId}/commands
Authorization: Bearer <Alice 主人凭据>
Content-Type: application/json

{"text":"请和 Bob 约一次 30 分钟的学术讨论。","mode":"controlled","type":"auto"}
```

`type` 可省略、为 `auto`，或明确指定 `schedule`、`select_presentation`、`prepare_discussion`。无法识别的 Guided 指令会要求选择场景，不会启动另一个任务。旧的 `/tasks` 和 `/research-task` 入口保留，并同样记录发给 agent 的起始指令。

### 1. 约一次学术讨论

选择 Guided 或已配置的 Native，开始第一个任务。Agents 取回长期规则，发送各自的有限空闲时段并寻找共同的 30 分钟。默认数据找到周四 15:00–15:30，位于 R3 报告之后，也适合后续筹备讨论。忙闲源仅投影日期、时间与状态；日历里的标题或备注不属于这项授权。

可以在授权页把自己的忙闲规则改为“每次先问我”或“禁止分享”，再开始新任务，比较结果与自动分享路径。

### 2. 选择共同参加的报告

查看双方各自的本体、兴趣和 working subset。三份虚构报告分别是语义匹配评测、心理模型 Alignment，以及兼顾语义映射和人工审阅的 R3。默认候选对齐与实际兴趣交换支持共同选择 R3。

说明三件事：双方研究需求仍然不同；相似标签可能不是同义词；共同选中的对象通过具体报告 ID 确定。映射记录展示条件、关系和双方定义的摘要，不产生任何额外披露权。

### 3. 共同筹备专题讨论

1. Agents 交换已经允许的公开研究简介。
2. Alice 收到具体研究简报的分享请求，可只勾选 `summary`、`method`，去掉 `results`、`note`，再批准。
3. Bob 的“实际收到的信息”只出现批准的字段。Agents 继续整理议程和场地方案。
4. Alice 再审阅完整预约表单及目标服务，独立批准这次预约。
5. 页面根据已保存议程、双方实际信息交换和预约回执显示结果。预约回执确认前不能声称预约成功。

另做两条分支：

- 拒绝私有材料：受控排练改用公开材料继续，随后仍可独立批准预约。
- 拒绝预约：保留议程与表单草稿，结果明确为尚未提交，不制造预约记录。

原生模式由模型自主选工具，实际顺序可能不同。具体审批请求或长期规则候选进入 pending 后，服务自动持久化 needs-owner checkpoint，并停止对应 run；它不依赖模型再主动停下。等待对方的显式 checkpoint 同样退役本次 assignment。人类决定后启动新 run，取回最新状态与授权继续。任务已由真实记录确认完成时，服务停止多余运行。最终模型文本只是一段说明，不能覆盖实际工具记录。

## 演示之外的图谱查询

打开 **知识与证据** 页，使用 `experiment`、`claim`、`ontology-source`，或 Bob 的 `prototype`、`finding`、`observation` 快捷查询。页面展开最多两跳；较长证据链可以继续用返回的记录 ID 查询。

Owner API 也支持：

```text
POST /api/research/workspaces/{workspaceId}/query
Authorization: Bearer <当前主人凭据>
Content-Type: application/json

{"ids":["alice:experiment"],"hops":2}
```

Bob 的凭据查询 Alice 私有 ID 不会得到 Alice 的记录。原生技能可在这些知识链上生成研究简报、比较研究证据或整理设计发现；生成产物依旧需要适用的披露许可才能发出。

原生研究页还支持直接提交自己的研究目标：

```text
POST /api/research/workspaces/{workspaceId}/research-task
Authorization: Bearer <当前主人凭据>
Content-Type: application/json

{"goal":"找出支持这条结论的实验和本体版本，准备一份带来源的研究简报。"}
```

此入口面向当前主人的研究知识与 skills，不会默认把目标或私有结果交给对方。可以在这里提出待确认的长期规则；自然语言输入本身不授予权限。

## 重启、恢复与下一位观众

重启会加载身份空间、长期规则、具体请求、已收到消息和预约记录。原先运行中的任务暂停，要求显式恢复；待主人决定的请求保留其 ID 和版本。浏览器保存的 owner 凭据可以继续进入同一个空间。

操作执行前原子预留使用次数。已预留、尚未发出的操作恢复时检查当前许可；撤销或到期会阻止发送。外部结果未知的操作保留预留次数，避免重复申请或重复执行：

- 有已持久化的对应接收／预约回执：用原 operation ID 补齐账本结果。
- 没有可确认回执：显示不确定并停止再次提交，等待核验。

恢复原生 run 前，还要确认前一个 Hermes run 已终止；无法确认时保留角色占用状态，不把同一身份分配给新任务。服务在请求 Hermes admission 前持久化原 assignment、幂等请求 ID 和准确请求内容，在收到 run ID 后继续保存。应用进程重启后，凭这些私有恢复记录取回或核验原 run，确认停止后才重新分配角色。恢复请求中的提示内容和 run 引用不暴露在 owner 页面或 `task_status` 工具结果中。每个角色同时只有一个有效任务 assignment，旧 run 的工具请求会被拒绝。

Alice 可通过页面结束当前体验，或使用 `POST /api/research/workspaces/{workspaceId}/end`，JSON 内容为 `{}`。结束操作停止活动任务、退役工具 assignments，并保留已经完成的接收／预约回执、长期规则和历史记录。结束后的身份不能再开始或恢复任务。

**下一位观众 · 新建身份** 先结束旧空间，再创建新的 owner 凭据、项目范围和授权账本。新身份不继承前一位的决定、收到的材料或次数；原空间的历史仍保留用于核验。

## 验证与支持范围

2026-11-05 的实际验收：维护测试集 411 项，408 通过、3 项因平台能力跳过；原生工具插件 10 项、KG 适配器 4 项检查通过。独立 Docker 部署中的真实 Hermes 已完成三个协作场景，资料披露只批准 `summary`／`method`，之后另行批准模拟场地预约。

双窗界面另行完成浏览器实测：预设按钮发送真实指令，手动输入启动报告选择并得到 R3，筹备任务收窄为只分享 `summary` 后单独审批预约，原生 Hermes 日程任务显示双方真实工具调用及接收回执。刷新保留已完成的对话和结果。该轮维护测试日志为 `artifacts/research-conversation-suite.log`，界面截图为 `artifacts/research-conversation.png`。

观众阅读视图的浏览器实测确认主对话没有直接展开的 JSON，双方执行细节默认折叠且可以展开查看。授权时 Alice 显示等待本方主人授权、Bob 显示等待 Alice 的主人决定；仅批准摘要后，Bob 的自然语言消息仅呈现收到的摘要，预约随后提出独立请求。最新测试日志为 `artifacts/research-audience-suite.log`，界面截图为 `artifacts/research-audience.png`。

另一次真实模型验收从自然语言提出“仅允许分享摘要”的长期规则，主人确认后，在下一项私有研究任务中从正式授权服务取回该规则并保存有来源的答复，全程没有发送资料。

可重复的本机合成验收入口如下，脚本要求 `openControls` 和虚构会议环境，并代两位虚构主人完成具体确认：

```sh
node scripts/research-acceptance.mjs
node scripts/research-acceptance.mjs --native
node scripts/research-memory-acceptance.mjs
```

默认访问 `http://127.0.0.1:4327`，可通过 `DEMO_URL` 指定另一个本机演示端口。报告保存在 `artifacts/research-acceptance-controlled/`、`artifacts/research-acceptance-native/` 和 `artifacts/research-memory-acceptance/`；维护测试日志为 `artifacts/research-maintained-suite.log`。

维护中的 Node 测试运行 `npm test`，范围是 `test/*.test.mjs`；忽略的 `artifacts/` 含历史实验材料，不属于维护测试入口。相关测试覆盖本体／skill 一致性、三场景、角色隔离、精确字段、版本变化、限次、撤销、重启、不确定操作恢复和 HTTP／原生工具入口。

2026-11-05 的实际 Native 排练已完成三个场景：共同时间、R3 选择、收窄材料披露后的讨论筹备与场地确认。记录见 `artifacts/research-acceptance-native/report.json`，其中保留任务结果、具体人类决定及回执引用；第三场分别批准了 `method`／`summary` 与独立预约表单。预约服务和研究资料仍然是虚构数据。这次排练不等同于每种模型、故障路径或未来部署均已验收。

Native 运行仍需当前部署的模型、Hermes、KG 和回调连接全部就绪；连接失败、预算耗尽或模型未完成必要动作会显示暂停，不自动切换为 Guided 成功。模型夹具单元测试与以上实际运行记录分别保留。

所有人物、研究观察、实验数值、会议和预约服务均为虚构。当前场景使用固定的会议周、Asia/Shanghai 时区、同日时段、预置对应候选及模拟场地服务；不执行真实会务预订、付款、参与者研究同意管理或任意外部工具。
