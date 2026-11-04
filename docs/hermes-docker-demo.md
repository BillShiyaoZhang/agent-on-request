# Docker 双 Hermes 演示

在运行 Docker Desktop 的 Windows 电脑，从仓库根目录启动。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-docker-demo.ps1
```

打开 [http://127.0.0.1:4327](http://127.0.0.1:4327)，选 **Live** 和默认研究会议，审阅本体对齐，然后预览并批准空闲时间。补充周四后，打开 Bob 主人的审阅窗口，可只允许主题或拒绝简报。按需查看精确回执和双方的已接收状态。

Compose 运行两个 Hermes gateway 和一个演示容器。Alice 和 Bob 的 Live 推理使用 `MiniMax-M3.1-Flash`（MiniMax 中国区）。启动脚本从本机 Hermes 的 `.env` 或进程环境读取 `MINIMAX_CN_API_KEY`，通过标准输入为各自的 `/opt/data` 数据卷初始化凭据。两端共享 MiniMax 账户额度。Live 会把各端用于规划的虚构数据发到 MiniMax。

Alice 和 Bob 各有独立的 profile 数据卷、gateway 密钥、私有通信网络和出网网络。演示容器经各自的私有网络访问两端 gateway，并在自身回环上运行 agent-comm 的两个签名对等端口。只有网页端口发布到宿主回环。首次构建需要下载镜像和 Go 依赖。跨端通信始终走本机。

## 管理

```powershell
$demoCompose = @('--project-name', 'agent-on-request-hermes-demo', '--env-file', '.data/docker-hermes/compose.env', '-f', 'compose.hermes-demo.yaml')
docker compose @demoCompose ps
docker compose @demoCompose logs -f demo hermes-alice hermes-bob
docker compose @demoCompose stop
```

重新运行启动脚本即可恢复。`stop` 保留独立的 profile 卷和演示数据。若 `4327` 被占用，启动脚本可加 `-Port 4337`。

后续可分别用 `docker compose @demoCompose exec hermes-alice hermes config` 和 `docker compose @demoCompose exec hermes-bob hermes config` 管理对应角色。profile 数据属于各自的卷。启动时只补齐缺失的 MiniMax 凭据，并把旧夹具模型迁移为 MiniMax。演示初始关闭长期记忆、背景抽取和 API 工具，等需要时再单独配置。
