# Evidence3D Bench

[![test](https://github.com/olddonkey/evidence3d-bench/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/olddonkey/evidence3d-bench/actions/workflows/test.yml?query=branch%3Amain)

测 AI 智能体（Codex、Claude Code 这类命令行客户端，加上它们背后的模型）能不能**照着资料建出尺寸和结构都对的 3D 模型**。生成器先造一个隐藏的真值模型（住宅、塔楼、水塔、仓库……），再把它渲染成照片、航拍、带比例尺的图纸和勘测笔记；参赛系统只看到这些资料，交一个 GLB；评分器拿它和真值比，全自动给出 0–100 分，形状分和细节分各占一半。测试集的对象由私有随机种子生成，模型不可能见过，考的是用证据，不是记忆。

参赛的是**系统**：客户端 + 模型 + 推理档位。每题一个全新会话，在 macOS Seatbelt 沙箱里作答：只能读题包、写输出目录，读不到仓库和真值，执行的命令连不了网；墙钟上限 30 分钟。

## 现状（2026-10-28）

<!-- 维护：每轮跑完、路线图的 PR 合并、Round 4 计划签署时，更新"现状""各阶段""Round 4 准备进度"三节；新一轮的结果出来后，把"Round 3 榜单"换成新一轮的。数字以 docs/V1-ROUND*.md 为准。 -->

**最新结果是 Round 3**（[docs/V1-ROUND3.md](docs/V1-ROUND3.md)）：私有测试集 `test-2026-10` 的 24 个对象，12 个系统，评分器 1.1.0；10-21 跑完，10-28 按两张榜加 Holm 校正重出了报告。默认档（high）上 Codex 的 gpt-6-astra 和 gpt-6.1-sol 并列第一，Claude Code 的 Opus 5.5 第三；最高档（max）上这三个依次分开，79.2 > 77.2 > 71.5。同一个模型从 high 调到 max 涨 5 分左右，和模型之间的差距一样大。

**正在做 Round 4 的准备**：路线图第一阶段 10 项，6 项已合并，1 项在等负责人拍板（[#2](https://github.com/olddonkey/evidence3d-bench/pull/2) Round 4 计划），3 项在负责人手上（Antigravity 实机预检、真实建筑候选、盲评）。明细见下面的 [Round 4 准备进度](#round-4-准备进度)。

**Round 4 要回答的**：在评分器冻结之后才生成的新私有题集（72 个对象）上排两张系统榜，并说清每个分差是否可信：校正多重比较后还分不分得开、人眼看不看得出、有多少来自客户端（同一模型换客户端的对照）。真实建筑扩到 10–12 个（至少 8 个才给区间）。计划还是草案（[#2](https://github.com/olddonkey/evidence3d-bench/pull/2)），负责人合并它就是签署。

**现在还说不了的**：分数和人眼判断是否一致（盲评只评了 110 对里的 14 对）；榜上的差多少来自模型、多少来自客户端；真实建筑只有 2 个，只能看排序。

## Round 3 榜单

主分 =（形状分 + 细节分）/ 2，取 `t2`（照片加航拍）、`t4`（再加图纸和勘测笔记）、`c1`（图纸是过期的）三种题型的均值，再对 24 个对象平均。每个系统都跑了这三种题型，所以这一列可以横着比；五种题型都算的分数和区间见 [V1-ROUND3 第 1 节](docs/V1-ROUND3.md#1-test-set)。

**梯队**：同一梯队里任意两个系统没有分开，不同梯队之间两两都分开。"分开"指：每个对象上取两个系统在双方都跑过的题上的分差（有的对含 `t1`、`t3`，所以不一定等于两行主分之差），按对象配对的自助法和 t 分布 95% 区间都不含零，并且 Holm 校正后 p < 0.05；每张榜单独校正（默认档 9 个系统 36 对，最高档 3 对）。

### 默认档（high）

| 梯队 | 客户端 / 模型 | 主分 | t2 照片 + 航拍 | t4 + 图纸、笔记 | c1 过期图纸 |
|:-:|---|--:|--:|--:|--:|
| 1 | Codex / gpt-6-astra | **73.4** | 59.5 | 82.1 | 78.8 |
| 1 | Codex / gpt-6.1-sol | **72.4** | 61.1 | 81.4 | 74.8 |
| 2 | Claude Code / claude-opus-5-5 | **66.5** | 51.1 | 78.7 | 69.9 |
| 3 | Codex / gpt-6-sol | **53.3** | 37.3 | 67.0 | 55.4 |
| 3 | Grok Build / grok-4.7-build-fast | **53.1** | 36.8 | 67.4 | 55.0 |
| 3 | Grok Build / grok-4.6 | **50.6** | 36.1 | 63.0 | 52.5 |
| 3 | Grok Build / grok-4.7 | **49.6** | 36.7 | 60.0 | 52.2 |
| 4 | Codex / gpt-5.6-luna | **40.1** | 31.2 | 48.6 | 40.5 |
| 5 | Claude Code / claude-haiku-4-5（没有传档位参数） | **24.0** | 22.8 | 29.2 | 20.0 |

### 最高档（max）

| 梯队 | 客户端 / 模型 | 主分 | t2 照片 + 航拍 | t4 + 图纸、笔记 | c1 过期图纸 |
|:-:|---|--:|--:|--:|--:|
| 1 | Codex / gpt-6-astra | **79.2** | 69.5 | 85.4 | 82.7 |
| 2 | Codex / gpt-6.1-sol | **77.2** | 69.0 | 82.9 | 79.6 |
| 3 | Claude Code / claude-opus-5-5 | **71.5** | 57.2 | 83.1 | 74.3 |

只有这三个模型跑了 max；Codex 的 `ultra` 和 Grok 的最高档 `xhigh` 没有跑。第一和第二只差 +2.0 [+0.7, +3.4]（24 个对象里 16 个 Astra 高），在这张榜内校正后仍分开（p = 0.010），放进 12 个系统的全部 66 对一起校正就不分开了（p = 0.088）。

### 同一模型从 high 到 max

| 客户端 / 模型 | high | max | max − high [95%] | 变好的对象 |
|---|--:|--:|--:|--:|
| Codex / gpt-6-astra | 73.4 | 79.2 | +5.7 [+4.2, +7.1] | 23 / 24 |
| Codex / gpt-6.1-sol | 72.4 | 77.2 | +4.7 [+3.2, +5.9] | 23 / 24 |
| Claude Code / claude-opus-5-5 | 66.5 | 71.5 | +5.0 [+3.8, +6.2] | 23 / 24 |

### 要点

- **档位和模型一样重要。** 调到 max 涨的 5 分左右，和 high 档上 Astra 与 Opus 之间的差（6–7 分）差不多大；资料越少涨得越多（只有照片的 `t2` 上 Astra 从 59.5 涨到 69.5）。所以只在同一档位内比，分两张榜。
- **图纸最值钱**（下面依次是 Astra high / Opus high，按对象配对）。带比例尺的图纸 +22.8 / +27.4（`t3` − `t2`）；多给几张照片和航拍 +7.2 / +4.4（`t2` − `t1`）；有了图纸再给勘测笔记几乎没用，−0.2 / +0.2（`t4` − `t3`）；图纸过期比图纸是新的低 3.5 / 8.6 分（`c1` − `t3`）。
- **冲突题看得出谁在用证据。** 图纸过期、照片是现状时，有争议的尺寸跟着照片走的比例：Astra max 95%，Astra high 93%，Opus high 77%；gpt-6-sol 和三个 Grok 只有 36–44%，Haiku 17%。
- **换题集，大次序不变。** 跑过记忆题和真实建筑的系统里仍是 Astra > Opus > Grok > Luna > Haiku（记忆题 Astra 88.1、Opus 76.5；真实建筑 Astra 50.9、Opus 47.7，只有 2 个对象，只能看排序）。只有 Grok 之间不稳：grok-4.7 在测试集上是三个 Grok 里最低的，在记忆题上是最高的。
- **每一行是客户端 + 模型 + 档位的组合**，跨客户端的差里包含客户端的作用（工具、内置提示、上下文管理），不能全算到模型头上。Opus 隔 9 天重测，差 −0.6 [−1.9, +0.7]，没有可测的变化。

## 各阶段

| 阶段 | 时间 | 做了什么 | 文档 |
|---|---|---|---|
| v0 | 2026-09 | 评分器校准原型、人工评审工作台；能自动评分的题等于抄参数表，真实照片题没有真值，不排总榜 | [docs/V0.md](docs/V0.md) |
| v1 试点 | 2026-10-01 | 公开开发集 5 个对象、4 个系统，验证分数拉得开、和肉眼看到的一致；不是测试成绩 | [docs/V1-PILOT.md](docs/V1-PILOT.md) |
| v1 首轮测试 | 2026-10-03 至 04 | 私有测试集 `test-2026-10`，24 个对象 × `t2`/`t4`/`c1`，4 个系统，两两全部分开 | [docs/V1-TEST.md](docs/V1-TEST.md) |
| Round 3 | 2026-10-05 至 21 | 同一测试集补上 `t1`、`t3`；12 个系统（加了 gpt-6.1-sol、gpt-6-sol、3 个 Grok 和 max 档）；记忆题；2 个真实建筑；10-28 按两张榜和 Holm 重出报告 | [docs/V1-ROUND3.md](docs/V1-ROUND3.md) |
| Round 4 | 准备中 | 新题集 72 个对象、两张系统榜、人眼校准、同模型跨客户端对照、10–12 个真实建筑 | 计划草案 [#2](https://github.com/olddonkey/evidence3d-bench/pull/2) |

## Round 4 准备进度

路线图第一阶段，2026-10-28 开始。✅ 已合并　🔄 在审　⏳ 负责人在做

| | 项 | 状态 |
|:-:|---|---|
| ✅ | T1 GitHub Actions：每次推到 main 和每个 PR 都在 Linux 上跑测试 | [#5](https://github.com/olddonkey/evidence3d-bench/pull/5) |
| ✅ | T2 盲评支持多位评审者（每票带评审者、合并投票文件、κ） | [#3](https://github.com/olddonkey/evidence3d-bench/pull/3) |
| ✅ | T3 报告的诊断列：具名尺寸、细节类别、坐标与尺度误差 | [#1](https://github.com/olddonkey/evidence3d-bench/pull/1) |
| ✅ | T4 题面写清评分器 1.1.0 怎么评分（只用于今后新建的题集） | [#4](https://github.com/olddonkey/evidence3d-bench/pull/4) |
| ✅ | T5 两张系统榜、名单文件、Holm 校正 | [#7](https://github.com/olddonkey/evidence3d-bench/pull/7) |
| ✅ | T6 作答过程中每 5 分钟存一次模型，画分数-时间曲线 | [#6](https://github.com/olddonkey/evidence3d-bench/pull/6) |
| ⏳ | T7 在装了 agy 的 Mac 上查 `agy models`，跑 Antigravity 第一次实机预检和 3–5 题试跑 | 适配器是照文档写的，还没在真机上跑过 |
| ⏳ | T8 真实建筑候选：有平面和至少两个立面、街上拍得到、不是名建筑 | 现有 2 个，Round 4 目标 10–12 个 |
| ⏳ | T9 负责人评完自己那份 110 对盲评，再找 2 位评审者 | 已评 14 / 110 |
| 🔄 | T10 Round 4 计划与事先决定 | [#2](https://github.com/olddonkey/evidence3d-bench/pull/2)：等负责人确认第 13 节，合并即签署 |

之后：阶段 2 用 3 位评审者的盲评决定评分器权重是否要改（G1），跑同一模型换客户端的对照（G2），定名单；阶段 3 加新题型（`t5`、照片退化）和生成器 1.2，生成新题集并打 tag `v1.3`；阶段 4 正式跑 Round 4，发布 `docs/V1-ROUND4.md`。

## 结果在哪

- **结论**在 `docs/`，每轮一份（见上表），数字都来自对应的报告。
- **报告和原始数据不进 git**，只在负责人的 Mac 上：`.local/v1/reports/<名字>/` 里有 `index.html`（完整报告）、`summary.md`（可以直接贴的摘要）和 `leaderboard.json`。Round 3 的是 `test-final`（测试集）和 `mr-final`（记忆题和真实建筑）。
- `.local/` 里还有测试集的种子、真值和每次作答的记录。测试集靠它们不公开才保得住，所以 `.local/` 永远不要提交（已在 `.gitignore` 里）。

## 怎么跑

要 Node.js 22.2 以上；渲染照片要 Blender 5.x（默认 `/Applications/Blender.app`）；参赛系统的沙箱只在 macOS 上实现。

    npm ci --ignore-scripts
    npm run test:v1                                         # Linux 上会跳过要沙箱、Blender 或私有数据的测试
    node v1/cli.mjs build-set --set v1/sets/dev.json        # 公开的开发集，5 个对象
    node v1/cli.mjs verify
    node v1/cli.mjs score --task house-0011-t2 --glb truth  # 拿真值当提交，应接近 100 分

让一个系统作答，再出报告：

    node v1/scripts/run.mjs prepare   --id BATCH --system codex --model gpt-6-astra --effort high --tasks a,b,c
    node v1/scripts/run.mjs preflight --batch .local/v1/runs/BATCH
    node v1/scripts/run.mjs run       --batch .local/v1/runs/BATCH
    node v1/cli.mjs report --batches BATCH --out .local/v1/reports/NAME

`--system` 可以是 `codex`、`claude-code`、`grok`、`antigravity`（还没在装了 agy 的机器上验证过，见 [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md)），以及 `api-anthropic`、`api-openai`（自建的统一 agent 循环，只在模拟服务器上测过；负责人决定不用 API key，这两个现在不跑）。`report` 加 `--roster 名单文件` 就按名单排两张榜、做 Holm 校正，Round 3 的名单是 [v1/rounds/round3.roster.json](v1/rounds/round3.roster.json)。完整说明见 [docs/V1.md](docs/V1.md) 和 [运行器说明](v1/lib/runner/README.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/V1-ROUND3.md](docs/V1-ROUND3.md) | **最新结果**：Round 3 的全部数字、两张榜、记忆题、真实建筑、Grok、工具链漂移（英文） |
| [docs/V1-TEST.md](docs/V1-TEST.md) | 第一份测试成绩（4 个系统），以及主机睡眠规则的由来 |
| [docs/V1-PILOT.md](docs/V1-PILOT.md) | v1 试点：分数能不能拉开、和肉眼看到的是否一致 |
| [docs/V1.md](docs/V1.md) | v1 的设计：题目、评分、评分器校准、运行条件、已知限制 |
| [v1/DESIGN.md](v1/DESIGN.md) | 工程契约：数据格式、模块接口、评分定义（英文） |
| [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md) | 在另一台 Mac 上用 Google Antigravity CLI 跑（英文） |
| 各模块（英文） | [评分器](v1/lib/score/README.md) · [报告](v1/lib/report/README.md) · [运行器](v1/lib/runner/README.md) · [盲评](v1/lib/study/README.md) · [生成器](v1/lib/generator/README.md) · [记忆题](v1/lib/generator/landmarks/README.md) · [真实建筑](v1/lib/real/README.md) |
| [docs/V0.md](docs/V0.md) | v0：评分器校准原型和人工评审工作台（原来的首页正文），以及它引用的 PROTOCOL、DETAILS、EXAMPLES、PILOT、NEXT-STEPS |

## 仓库结构

    v1/                 v1：命令行 v1/cli.mjs 和 v1/scripts/，模块在 v1/lib/（生成器、渲染、评分器、运行器、报告、盲评、真实建筑）
    v1/rounds/          每轮的正式名单：哪些系统上哪张榜
    v1/real/            真实建筑的真值（按图纸写成的模型）和出处说明；照片原件不在仓库里
    docs/               各轮结果和设计说明
    其余顶层目录        v0：cli.mjs、lib/、site/、scripts/、schemas/、test/（lib/ 里的 GLB 与文件读写 v1 也在用）
    .local/             私有数据：种子、真值、作答、报告；不进 git

开发都在 `main` 上。`v1-hidden-truth` 分支停在 2026-10-22（`64be108`），之后合并的内容它都没有。
