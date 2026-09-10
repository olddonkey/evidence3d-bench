# Evidence3D Bench

本地的「资料 → 可编辑 3D」benchmark 原型，当前版本为 v0.1。

这一版先验证评分器：通过具有解析尺寸的合成建筑，检查客观指标能否检出已知缺陷。几何测量、人类偏好和模型辅助判断分开记录，不合成未经校准的百分制总榜。

## 当前可运行的内容

- 两个合成建筑、26 个对照提交、22 项评分器校准检查。
- 静态 GLB 读取、世界坐标尺寸测量、位置偏差、五个固定正交方向的轮廓 Precision / Recall / IoU。
- 两种真值方式：完整参考网格；仅包含独立核验尺寸区间的部分真值。部分真值不需要完整扫描模型。
- 四个真实建筑开发任务：Westminster、Fenchurch、Kingsfold、In-N-Out。23 份本地原始图片有 SHA-256 锁，标准答案尚未独立核验，因此不计准确性分。
- 任务导出、提交清单、准确性报告与 SVG 差异图。
- 匿名 A/B 评审：实际 GLB、统一灰模、固定尺度、相机联动、续评、重复投票拦截、反向顺序复测。
- 练习与人工记录分开；平局、两个都不好、资料不足分别记录。没有自动制造人工评分。
- 本地 HTTP 服务仅监听 127.0.0.1。没有远程仓库、部署或上传流程。

**当前不是已经验证有效的真实世界排行榜。** 尚无独立人工判断、真实模型生成实验、完整表面／语义拓扑评分或受信任的隔离生成 runner。没有模型 API 调用。四个真实任务不能凭旧模型的技术 PASS 升格为标准答案。

## 启动

要求 Node.js 22 或以上。依赖已锁定在 package-lock.json。

    cd /Users/olddonkey/Documents/evidence3d-bench
    npm ci --ignore-scripts
    npm run demo
    npm start

打开 http://127.0.0.1:5198 。

合成校准独立于旧工程，可以在其他机器运行。真实资料是可选的本地输入：

    npm run prepare:local
    npm run check

默认从同级 img2threejs 工程采集 tasks/catalog.json 中明确列出的原始图片。指定其他位置：

    node cli.mjs prepare --source /path/to/img2threejs

prepare 不覆盖已有标注；若源文件变化，拒绝静默更改已锁定任务。新数据版本应使用新的任务 id 或 --data 目录。

## 给生成系统的输入包

    node cli.mjs pack --task .local/tasks/calibration-chapel/task.json --out exports/calibration-chapel

导出只包含 task.json、input-lock.json 和明确列出的 inputs。不会带入旧模型、建模代码、评测参考模型、标注工作表或运行答案。导出目标必须为空。

真实题的原始资料可以同样导出，但仍标记为 annotation_pending 和 local_review_only。目标年代、坐标框架和测量容差未核验之前，不应进行正式准确性比较。

**导出白名单不是操作系统沙箱。** 正式运行生成 agent 时，必须在不含 evaluator 私有目录与旧答案的隔离环境中挂载导出的任务包。本版本没有实现该隔离 runner，也不会因提交者自报 runner_measured 就承认其预算或无人工干预。

## 接收与评价 GLB

GLB 应只有一个场景、静态未压缩三角网格、FLOAT POSITION、Y-up、米制，并使用题目规定的坐标框架。不能依赖外部 buffer 或图片。v0 明确不接收动画、骨骼、量化／压缩网格、稀疏 accessor 或 GPU 实例扩展；这是赛道格式限制，不代表这些技术质量差。

把交付文件放到独立目录，然后创建清单：

    node cli.mjs submit \
      --task .local/tasks/calibration-chapel/task.json \
      --artifact /path/to/submission/model.glb \
      --id candidate-01 \
      --system example-system --model exact-version --harness exact-version \
      --seconds 120 --cost 0.5 --seed 1 --human false

此命令只创建提交清单，不运行模型。耗时、费用和是否人工干预都是自报信息；费用未知时留空而不是填零。

    node cli.mjs evaluate \
      --task .local/tasks/calibration-chapel/task.json \
      --submission /path/to/submission/submission.json \
      --truth .local/private/calibration-chapel/truth.json \
      --out .local/reports/candidate-01

输出包括 report.json 和五个 overlay SVG。不对候选模型自动缩放、居中或最佳配准。参考错误返回 evaluation_error；无效提交返回 invalid_submission；未核验真值的真实题返回 annotation_pending，并保留技术验收结果而不编造几何准确性分。

仅验证尚待标注的真实题时可省略 --truth。

## 人工盲评

1. 在「匿名盲评」输入稳定昵称。看过缺陷答案或进行界面测试时，选择练习模式。
2. 检查参考、A、B 的多个角度。评审对象是几何忠实度；颜色、灯光和模型身份不参与。
3. 可以选 A、B、平局、两个都不好或资料不足，并保存观察。
4. 同昵称、同实验可续评。每人每对候选只计一次；额外反向展示是顺序偏差检查，不作为第二票加入偏好统计。

    node cli.mjs review-summary

结果按每对候选记录。胜率与 Wilson 95% 区间仅针对明确 A/B 选择；其他类别另列。少于三位独立评审者时标记样本不足。即使达到三人，也只是初步结果，不表示已经证明排名可靠。

昵称仅是本地去重标识，不是身份认证。前端可以查看校准答案，因此这套开发界面不等于对抗作弊的公共投票平台。生产研究还需要独立受试者招募、评审培训、覆盖控制与身份管理。

## 实际文件

    schemas/                  任务与提交 JSON Schema
    tasks/catalog.json        四个真实资料包的显式来源清单
    lib/glb.mjs               GLB 合同验证、几何读取与匿名化
    lib/metrics.mjs           独立几何计算
    lib/evaluate.mjs          评分协议及未评分状态
    lib/fixtures.mjs          合成场景与已知扰动校准
    lib/prepare.mjs           输入锁定与无答案导出
    lib/reviews.mjs           持久投票、随机顺序与汇总
    lib/server.mjs            本地应用的受限文件/API 路由
    site/                     评测工作台
    test/                     合同、测量、隔离路径和评审测试
    docs/PROTOCOL.md          指标定义、真值方式及边界
    docs/NEXT-STEPS.md        进入真实试验前的工作

以下目录仅留在本地，并被 Git 忽略：

    .local/tasks/             锁定的任务与原始图片副本
    .local/private/           评分参考及真值
    .local/submissions/       交付文件与提交清单
    .local/reports/           测量结果与差异图
    .local/annotations/       四个真实任务的独立标注工作表
    .local/reviews/           投票及不对外提供的身份映射
    exports/                 可交给生成系统的任务输入包

## 验证

    npm test
    npm run demo
    npm run check

测试覆盖解析几何对照、世界变换、不变性、错误严重度、空参考、无效 GLB、输入／答案哈希漂移、部分真值、匿名资产、练习票隔离、重复投票、顺序复测、源版本冻结与标注保留。

轮廓重合不能证明内部几何、隐藏表面、语义完整性或网格拓扑正确。当前报告明确保留这些盲点，不将校准通过解释为真实任务的模型质量已被验证。
