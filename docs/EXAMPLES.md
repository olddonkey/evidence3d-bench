# 示例库与多任务评测

v0.3 新增三个可自动测量的合成示例和三个真实资料示例。新增样例覆盖孔洞、重复支撑、连续曲面、曲面细分和视角遮挡。它们使用同一个评分器，保持任务、参考、候选与评分记录分别锁定。

## 可评分的合成校准示例

| 示例 | Task ID | 卡片 | 对照 | 主要问题 |
|---|---|---:|---:|---|
| 原有立面 | calibration-facade-v1 | 10 | 12 | 窗棂、门窗数量、局部凸出 |
| 三拱廊 | calibration-arcade-v1 | 6 | 9 | 真正的贯穿孔洞、前后栏杆、拱券厚度 |
| 圆顶亭 | calibration-rotunda-v1 | 6 | 9 | 穹顶曲率、环形立柱、合理加密与过粗分面 |
| 曲面天线 | calibration-reflector-v1 | 6 | 9 | 凹凸方向、薄支架、背面遮挡和底座连接 |

共 39 个对照提交、28 张可评分卡片、56 个固定局部视角，另保留立面题的一张预先排除卡片。细节校准共 46 项检查；加上原有全局几何校准 22 项，共 68 项。

这些是具有完整参数和解析参考的校准任务，不是已经采集了独立人类评分或运行了多个 AI 模型的成绩。

## 三拱廊

墙体有三个真正贯穿的圆拱孔洞。前后栏杆各九根立杆。对照包括填实一个孔洞、删除前侧中央立杆、额外添加立杆、压平拱券、移动拱顶石。

前后中央立杆可以在正面投影重叠；删除前杆不一定改变轮廓，却会改变最近表面的深度。软件测试还单独检查拱洞内部射线：正确模型没有表面，填实后出现墙面。

## 圆顶亭

参考由闭合旋转剖面、八根立柱、柱头／柱础、圆形檐口与尖饰组成。对照包括缺柱、多柱、压平穹顶、将穹顶周向降至八个分面，以及将参考 48 段增加至 96 段。

加密曲面不是故障，不要求与参考的每个三角形相同。该对照在既定几何容差下仍通过，而八分面版本不能通过；因此不会仅奖励复制相同网格表示。

## 曲面天线

反射面使用局部公式 Z = 0.1 × (X² + Y²)，具有固定厚度、外缘环、馈源支架、背部径向支撑和基座。

对照包括压平凹面、改成相反曲率、删掉馈源支架、删掉背部支撑、删掉基座斜撑。背面和左侧视角按参考中的构件位置预先设置。

背部支撑缺失在正面被反射面遮住，所以正面卡片保持通过，背面卡片检出差异。这是对可见性边界的验证；不会把“正面看起来一样”当成整个模型完整。

## 输入与运行

每个示例的输入包含：

- task.json：目标、单位、坐标、预算和交付格式。
- inputs/dimensions.json：完整部件参数、位置、旋转、细分数量及 primitive 语义。
- inputs/elevation.svg：固定正面参考。

参数表是允许的建模输入，评测参考 GLB 和细节卡片保留在评测方目录。当前任务用于测试明确资料下的构建与几何检查，不代表真实照片中未知信息的推断能力。

生成示例：

    npm run demo:examples

生成包括原有样例在内的所有合成校准：

    npm run demo

导出某一题：

    node cli.mjs pack --task .local/tasks/calibration-arcade-v1/task.json --out exports/calibration-arcade-v1

给其他模型独立的输入包，取得实际 GLB 后，按该题创建提交清单：

    node cli.mjs submit --task .local/tasks/calibration-arcade-v1/task.json --artifact /path/to/run/model.glb --id model-a-arcade-01 --seconds 420 --model exact-version --harness exact-version --human false
    node cli.mjs register-detail --submission /path/to/run/submission.json --label "Model A / arcade / run 1"

登记命令从提交的 task_id 找到对应参考和候选索引，不会误登记到立面题。示例中的耗时、版本及人工介入字段必须填写实际值。

按对象查看人工细节汇总：

    node cli.mjs detail-summary --task calibration-arcade-v1
    node cli.mjs detail-summary --task calibration-rotunda-v1
    node cli.mjs detail-summary --task calibration-reflector-v1

省略 --task 时仍使用原有立面题，兼容 v0.2。新增示例的索引在 .local/detail-indices/；原有 .local/detail-index.json 不被新增示例替换。注册候选、评分会话、续评与汇总均绑定任务和卡片版本。

## 新增真实资料

| 对象 | 原始资料数 | 内容 | 当前边界 |
|---|---:|---|---|
| Gasholders London | 6 | 规划平面、立面、建筑师照片和屋顶参考 | 仅 10/11/12，排除独立 No.8 |
| The Stanford Dish | 6 | 标注为 2013 年的照片和航拍 | 远景较多；小杆件数量、尺度和年代待核验 |
| Green Library / Bing Wing | 8 | HABS 照片／图纸、概览和航拍 | 历史主体与后期连接需区分 |

真实资料集现为 7 个对象、43 份原始图片和 70 张细节草案。三个新增对象仍是 annotation_pending，草案没有独立批准的世界相机或容差，不参与准确性排名。已有四个对象的资料锁和人工工作表保持不变。

所有资料、结果和评审记录都保留在本地；没有远程仓库、发布或上传步骤。
