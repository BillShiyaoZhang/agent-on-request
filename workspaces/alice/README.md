# Alice 的初始 workspace

这份目录是版本化、只读的演示种子。它可独立初始化 Alice 的应用本体、个人研究知识、日程、材料、技能和初始授权规则，不读取另一位研究者的 workspace。

- `ontology.json`：完整的本方应用 ontology，含本地个人基座。
- `knowledge.json`：有来源的私有研究图谱。
- `calendar.json`、`materials.json`：本方日程与资料版本。
- `interests.json`、`report-annotations.json`：本方研究兴趣与公开报告的个人解释。
- `skills.json`、`skills/`：本方完整安装的通用与领域技能。
- `policies.json`：可信初始化器使用的规则模板；不包含旧观众的决定、许可或使用记录。
- `manifest.json`：文件列表、SHA-256 校验值及种子版本。

每位观众从这份种子生成新的运行空间；同一观众的连续任务沿用该运行空间。运行时资料、收发件、草稿、授权账本和 Hermes 状态不回写本目录。修改初始资料后运行 `node workspaces/update-manifests.mjs alice` 更新校验清单。

公共会议信息位于 `demo/environment/`；其中没有对方的兴趣标注。参考对应与预期结果只在 `demo/acceptance/` 供测试使用，不是 agent 的初始知识。关于对方的含义、需要和约束应通过任务通信取得。全部人物和资料均为虚构数据。
