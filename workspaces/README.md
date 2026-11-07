# 独立研究者 workspace

`alice/` 与 `bob/` 是可直接展示、分别安装的初始内容。各自包含完整的本体、知识图谱、日程、材料、兴趣、技能与初始规则模板；初始化某一位研究者不需要读取另一位的目录。

这些目录是只读、版本化的种子。每位观众使用新的运行空间；同一观众的三个任务可以积累信息并延续规则。运行产物、接收内容、Hermes 状态和真实授权账本写入各自的运行目录，不修改种子。

修改初始资料后，先审阅变更，再运行：

```sh
node workspaces/update-manifests.mjs alice
node workspaces/update-manifests.mjs bob
```

加载器检查 `manifest.json` 及每个列入清单的文件指纹。文件跨出本方目录、缺失或未经清单更新时，初始化会明确失败。校验值用于复现起始条件；种子的发布和修改仍由演示维护者负责。

`demo/environment/` 保存双方可独立取得的公共会议与模拟场地信息。个人对报告的主题解释留在各自的 `report-annotations.json`。`demo/acceptance/` 的参考对应仅供测试，不安装到 agent 的 workspace，也不作为协商的预置答案。
