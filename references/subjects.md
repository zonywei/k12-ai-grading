# 先确定学段，再确定学科

当前覆盖小学、初中、高中3个学段，共24组学段学科入口。初中、高中不分具体年级；小学可按题目需要选填年级或年级段，未提供就使用小学通用规则，不猜测年级。

教师可直接说“初中数学”“高中思想政治”。从题目、平台或已给材料能确定的，不重复询问；只有“数学”“物理”等同名学科而无法确定学段时，才简短补问学段。

学科默认原则每题生效，教师没提到的项保留，明确冲突仅覆盖相应条款。本库是学科阅卷操作性归纳，结合用户工作流及公开课程、考试和评价资料；不是全国统一逐题评分细则。课程框架、国外参考与AI归纳分别标注。

## 小学

| 学科名称 | 默认原则与学段要求 |
| --- | --- |
| 语文 | [展开](rules/chinese.md#primary) |
| 数学 | [展开](rules/math.md#primary) |
| 英语 | [展开](rules/english.md#primary) |
| 科学 | [展开](rules/science.md#primary) |
| 道德与法治 | [展开](rules/civics.md#primary) |

小学仅以上5科学科入口。年级段可选1—2、3—4、5—6，不选则用小学通用；相关自然主题通过科学课程理解，不另列物理、化学等独立小学科目。

## 初中

| 学科名称 | 默认原则与学段要求 |
| --- | --- |
| 语文 | [展开](rules/chinese.md#middle) |
| 数学 | [展开](rules/math.md#middle) |
| 英语 | [展开](rules/english.md#middle) |
| 物理 | [展开](rules/physics.md#middle) |
| 化学 | [展开](rules/chemistry.md#middle) |
| 生物学 | [展开](rules/biology.md#middle) |
| 科学 | [展开](rules/science.md#middle) |
| 历史 | [展开](rules/history.md#middle) |
| 地理 | [展开](rules/geography.md#middle) |
| 道德与法治 | [展开](rules/civics.md#middle) |

初中保留“科学”以适配学校实际开设的综合科学课程；与分科教学并列作为可选入口，不假定每所学校同时开设全部科目。

## 高中

| 学科名称 | 默认原则与学段要求 |
| --- | --- |
| 语文 | [展开](rules/chinese.md#high) |
| 数学 | [展开](rules/math.md#high) |
| 英语 | [展开](rules/english.md#high) |
| 物理 | [展开](rules/physics.md#high) |
| 化学 | [展开](rules/chemistry.md#high) |
| 生物学 | [展开](rules/biology.md#high) |
| 历史 | [展开](rules/history.md#high) |
| 地理 | [展开](rules/geography.md#high) |
| 思想政治 | [展开](rules/civics.md#high) |

高中使用“思想政治”。理综为组合试卷任务，内部可用science并指定related_subjects，按实际小问加载物理、化学、生物规则，不出现在学科下拉选项中。

## 执行顺序

1. 优先读取已知学段与学科；缺失时先确定学段，再按该学段名称询问学科。也可一次简问“这次阅哪个学段、哪门学科？”不要强制教师走菜单。
2. 运行workflow.mjs rules，读取[共同原则](rules/common.md)、本学科默认原则和学段调整；先向教师取已有细则，缺项告知后由agent补拟。
3. 定稿采分条件、独立与依赖、部分分和来源，再运行workflow.mjs intake冻结有效规则。完整教师细则也不整体关闭默认原则。
4. 教师明确冲突按rule_overrides逐条记录rule_id、source、quote、source_ref、conflict、replacement；无提及不等于取消，“不扣单位”也不取消模型、方向等其他条件。
5. 评分开始后保留规则全文快照，独立复核使用同版规则；变更学段、学科、小学年级段或覆盖口径先更新细则版本并复核受影响答卷。初中、高中不因年级信息变化另换规则。

## 智能体数据

上下文：stage（primary/middle/high）、subject。学段可从“高中数学”等明确名称或既有材料识别；仅说“思想政治”可识别为高中。初中、高中不需要grade，也不填7或10冒充教师已提供信息；上下文中的grade统一为null，旧冻结记录保留原文但按学段校验。小学可选grade 1—6或primary_band（primary、primary-1-2、primary-3-4、primary-5-6）。

综合科学或理综任务按本题提供related_subjects；相关学科是内容参考，不改变小学学科入口。所有JSON由智能体生成，教师只用自然语言。

```sh
node scripts/workflow.mjs rules --input 本地学段学科上下文.json
node scripts/workflow.mjs intake --run-dir 本机私密任务目录 --input 本地材料核对.json
```

规则更新参看[合成校准情境](rules/calibration.md)，重点检查等价解法、局部错误、只评结果和证据不足。来源与适用限制见[来源说明](public-sources.md)，复核见[终审流程](review.md)，数据字段见[数据契约](contracts.md)。
