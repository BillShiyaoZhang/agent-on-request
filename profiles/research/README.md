# 研究者初始化内容已拆分

实际初始资料位于 `workspaces/alice/` 与 `workspaces/bob/`，各自可以独立加载。原来合并在这里的共同基座、角色资料、公开会议资料和预置映射已分别迁移：

- `workspaces/alice/`：Alice 的完整种子。
- `workspaces/bob/`：Bob 的完整种子。
- `demo/environment/`：公开会议与模拟场地资料。
- `demo/acceptance/`：只供验收使用的参考对应。

运行加载器为 `src/research-profiles.mjs`；它按角色读取并核验本方的 manifest，不把对方目录或验收答案作为角色的初始知识。
