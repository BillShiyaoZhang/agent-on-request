# 双 Hermes 本机直连演示

Alice 和 Bob 各自运行一个 Hermes profile。Live 规划提交到对应 profile 的 Runs API。演示控制器继续执行授权、投影、签名、语义映射和业务回执；获准的对等消息通过 agent-comm SDK 的两个本机 TCP 端口来回传输。两个端口由启动程序分配。配置和运行都无需协作平台、Web 账号或公网消息队列。

## 准备

1. 安装 Node.js 26+、Go 1.26.8+ 和支持认证 Runs、取消及 `/v1/toolsets` 的 Hermes。用 `hermes profile create demo-alice` 和 `hermes profile create demo-bob` 建立两个全新的演示 profile。各自运行 `hermes -p demo-alice setup` 和 `hermes -p demo-bob setup` 配置模型。使用虚构数据。模型推理是否需要公网取决于每端选择的模型，agent-comm 传输始终走回环。
2. 给每个 profile 的 `.env` 配置 `API_SERVER_ENABLED=true`、`API_SERVER_HOST=127.0.0.1`、各自的 `API_SERVER_PORT`（例如 Alice `8643`，Bob `8644`）和各自生成的 `API_SERVER_KEY`。在两个 profile 的 `config.yaml` 合并以下片段。保持演示 profile 无 MCP 服务、额外插件或个人记忆自动同步。

   ```yaml
   platform_toolsets:
     api_server: []
   mcp_servers: {}
   fallback_providers: []
   agent:
     max_turns: 1
     api_max_retries: 1
     background_review:
       enabled: false
   auxiliary:
     title_generation:
       enabled: false
       model_upgrade_enabled: false
   memory:
     memory_enabled: false
     user_profile_enabled: false
   ```

   演示在启动时验证两个 gateway 的认证和 Runs 能力，并在每次提交前核对 Hermes 公布的 API 工具集。个人记忆、KG 插件和角色能力可在各自 profile 中后续配置。启用能够产生副作用的工具前，应先定义它们如何经过演示授权。使用专用 profile，因为 Hermes 可能在本机保存运行和会话记录。演示的研究同意只控制本项目的研究记录与导出。

3. 在两个终端分别启动 `hermes -p demo-alice gateway run` 和 `hermes -p demo-bob gateway run`。端口冲突时，调整其中一方的 API 端口，同时更新下面的 URL。
4. 在演示仓库的 `.env` 填写 `.env.example` 中的 `DEMO_HERMES_ALICE_URL`、`DEMO_HERMES_ALICE_KEY`、`DEMO_HERMES_BOB_URL`、`DEMO_HERMES_BOB_KEY`。每个 URL 使用数字回环地址，端口和密钥分别对应自己的 gateway。`.env` 已由 Git 忽略。
5. 构建一次直连 bridge。第一次构建会下载 `go.mod` 固定的依赖。应在演示前完成构建。

   ```powershell
   Push-Location bridge/agent-comm-direct
   go build -o agent-comm-direct.exe .
   Pop-Location
   ```

   在 macOS/Linux 上用 `go build -o agent-comm-direct .`。若二进制在别处，设置 `DEMO_AGENT_COMM_DIRECT` 为绝对路径。

## 启动和验证

运行 `npm run demo:hermes`，或在 Windows 运行 `powershell -ExecutionPolicy Bypass -File scripts/start-demo.ps1 -Hermes`。打开 [http://127.0.0.1:4327](http://127.0.0.1:4327)。演示配置和已同意的研究记录保存于 `.data/demo-hermes`。

1. 选 Live 和默认研究会议。Alice 和 Bob 分别通过自己的 Hermes profile 产生提案。通过本体对齐后，预览并批准空闲时间，再按需补充周四范围。
2. 展开确认回执。预览阶段没有数据交付。业务回执由接收端签署，确认内容与实际批准的一致。到了 Bob 的简报确认，取消议程、只允许主题一次，检查接收结果。
3. 在研究者控制台断开 Bob，选择分享，然后停止分享并恢复连接。直连桥没有离线投递队列，恢复连接本身不重发。若在途的操作已由接收端确认，历史回执会保留。

Controlled 使用确定性规则走同一条直连数据路径，方便在 gateway 启动后排查模型推理。Replay 只展示参考轨迹。直连桥一次处理一项传输，建议现场只运行一轮。`npm run demo` 可启动独立的原演示。两端的 profile、模型和 API 密钥在 Hermes 中维护，Hermes 直连模式下的演示页不开放原模型配置。
