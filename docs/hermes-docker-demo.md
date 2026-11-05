# Docker 双 Hermes 演示

把 `.env.example` 复制为项目根目录的 `.env`，填入现有 MiniMax 中国区 Token Plan 的 `MINIMAX_CN_API_KEY`。从项目根目录启动。

```sh
docker compose up -d --build --wait
```

观众打开[演示首页](http://127.0.0.1:4327/)，先浏览架构，再选择 **Live**、审阅本体对齐并批准空闲时间。补充周四后，操作员在[控制台](http://127.0.0.1:4327/console)代 Bob 主人审阅简报，可以只允许主题或拒绝简报。观众在总结页查看结果和协作记录。操作员也可以在控制台检查两个 Agent Comm 端点和编辑新一轮的初始状态。

Compose 运行两个 Hermes gateway 和一个演示容器。Alice 和 Bob 的 Live 推理使用 `MiniMax-M3.1-Flash`（MiniMax 中国区）。Compose 把根目录 `.env` 的模型密钥作为 secret 交给两个 Hermes 容器。两端分别生成和保存本地 gateway 密钥，共享 MiniMax 账户额度。Live 会把各端用于规划的虚构数据发到 MiniMax。

Alice 和 Bob 各有独立的 profile 数据卷、gateway 密钥、私有通信网络和出网网络。演示容器经各自的私有网络访问两端 gateway，并在自身回环上运行 agent-comm 的两个签名对等端口。只有网页端口发布到宿主回环。首次构建需要下载镜像和 Go 依赖。跨端通信始终走本机。

## 管理

```sh
docker compose ps
docker compose logs -f demo hermes-alice hermes-bob
docker compose stop
```

重新运行启动命令即可恢复。`stop` 会保留独立的 profile 卷和演示数据。若 `4327` 被占用，在 `.env` 设置 `DEMO_DOCKER_PORT=4337`。更换 MiniMax 密钥后，运行 `docker compose up -d --force-recreate --wait` 让容器读取新的 secret。

后续可分别用 `docker compose exec hermes-alice hermes config` 和 `docker compose exec hermes-bob hermes config` 管理对应角色。启动时只更新这套演示所用的 MiniMax 凭据，并把旧夹具模型迁移为 MiniMax。演示初始关闭长期记忆、背景抽取和 API 工具，等需要时再单独配置。
