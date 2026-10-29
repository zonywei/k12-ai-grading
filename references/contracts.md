# 智能体生成的数据（教师不填）

`templates/`提供合成示例。schema_version=2；删除v1字符相似度评分引擎，任何旧评分记录必须重新由智能体理解，不静默迁移旧分数。

## Rubric

必要字段：task_id（平台当前任务稳定ID）、qid、version、kind、question（完整本题及必要材料）、reference_answer、max_score、step、points。采分点id唯一，max为实际分值，description为得分条件，source为teacher/reference/agent，可附alternatives、exclusions、teacher_rules、source_notes。

points默认独立相加；任选或替代用groups `{ids:[...],cap:N}`，不允许交叉组。经组封顶后的最大分必须等于max_score。不要使用含糊的required=false。复杂嵌套任选需由智能体先归一化成不重叠计分原子，不能错误编码。

明确教师/本题细则的机械扣分放deduction_rules `{id,max,description,source}`；明确总分封顶放cap_rules `{id,cap,description,source}`。来源仅teacher/reference；无依据不新增扣分。一般语义未满足应采分点不得分，不倒扣。

## Snapshot

read保存task_id、paper_id、qid、max_score、step、status、text、answer_hash、artifacts、snapshot_file。媒体截图SHA256和尺寸与证据绑定；空白图片也可读图评分，空DOM不能当空白。稳定paper_id来自平台，哈希只校验内容。

## Decision

必要字段：task_id、paper_id、answer_hash、rubric_hash；awards每个点恰好一条 `{point_id,score,reason,evidence}`。得0分仍填reason，得正分须evidence。文本证据 `{type:"text",quote:"学生原文片段"}`；图片证据 `{type:"image",file:"artifacts/...png",sha256:"read返回值",region:[x,y,w,h],observation:"该区域实际看到的内容"}`，坐标为截图CSS像素。可辅以agent_transcript，但不得把未识别图像当确切文字。

deductions `{rule_id,amount,reason,evidence}`、applied_caps `{rule_id,reason,evidence}`为可选；先原子相加、组封顶、再扣分并截0、最后总分封顶。总分完全由代码计算；如传total_score必须与计算一致，分项原始分和总分封顶差异可从记录追溯，不会绕过封顶。

review `{required:boolean,reasons:[]}`与status ready/review须一致。self_check.negation/context/duplicates/rules必须均为true，含义是智能体实际完成复读，并非自动证明模型正确。summary为简短判分依据。

## Journal

评分与快照先落盘后生成scored/review。提交前落盘intent；回读相同任务/答卷/分数且后台保存状态明确才confirmed；失败或不明确为unknown。intent/unknown都会阻止新提交。不同任务下相同paper_id不混合。summary按task_id+paper_id最后状态去重，不用事件条数代替人数。

这是可审计运行工具，不能证明各学科判分必然正确；教师纠正应优先吸收。真实平台回读必须在当前账号实际验证。

## v3工作流字段

保留schema_version=2以兼容计分契约，新增workflow_version=3启用材料/模式/学情门槛。kind还支持objective、fill、calculation、proof、experiment、source_response、project；它们只标识题型，不调用关键词判分。新版snapshot必须与rubric的qid/max_score/step一致。

Decision必须附learning `{judgment,action,check,point_ids:[本题采分点ID]}`。只有明确的本题可见证据才能形成判断。intake含subject（学科代码）、stage primary/middle/high；初中和高中不要求grade，规范化为null；小学可选grade 1—6或primary_band，未给则小学通用。另含question_clear/reference_clear/rules_clear（均为布尔true）、reference_origin teacher/official/agent、rubric_mode teacher/reference/agent-organized/teacher-completed、mode writeback/offline/report-only、scope.label。先记录teacher_rubric_checked=true和teacher_rubric_status complete/partial/none。教师细则不全时保留已有条件，agent补拟并告知：agent_organization_notified=true，rubric_generation_notice记录实际告知内容；不要求教师另外批准组织细则。rules_clear表示补拟后细则清楚，不表示教师最初材料完整。AI拟定参考答案仍需要independently_verified。字段由智能体据实际材料生成，不是给教师的表单。

已核对intake绑定task_id与rubric_hash，换细则后须重新运行intake。提交除旧契约外还校验当前mode为writeback。offline/report-only无论是否有authorization均不能提交；报告单列建议分与原平台分。scope.expected_papers和platform_count_reconciled只有实际对账后填入，用于完成性判定。

## 评分置信度与终审

v3 Decision必须含confidence `{level:"high|medium|low",reasons:[],affected_points:[],score_range:[下界,上界]}`，中/低置信度须有原因、真实采分点和区间。初评中/低置信度只能进入review；不能直接虚升置信度跳过复核。主智能体可在完整先行复核记录基础上终审，final_adjudication绑定复核包、复核结果指纹、最终依据、候选分取舍、剩余不确定性和teacher_notification_required=true。终审后review.required=false代表流程闭合，不代表必须变成高置信度。具体命令见review.md。

## v3.1默认学科规则

新任务rubric设置default_rules_required=true，保留workflow_version=3。先由智能体运行workflow.mjs rules读取默认规则，再组织本题细则。intake无论teacher_rubric_status是complete、partial还是none，均自动加载学段+学科规则；未知学段或范围外学科不静默套其他科，初高中综合科学/理综须由智能体识别related_subjects。

可选rule_overrides是逐条明确冲突记录，字段rule_id、source teacher/exam、quote、source_ref、conflict、replacement。没写某条不是取消该条；覆盖保留原条款不冲突的部分。同一规则只保留本次最新明确口径。

intake.default_rules含activation=always、catalog_version、profile_hash、file、subject、band。完整规则存于本机私密任务目录rules-profiles/<hash>.json，intake返回rule_packet全文供智能体核对；这些教师原话和任务运行快照不得进入共享技能包。

评分前检验材料、细则和规则快照绑定，Store.score自动将default_rules_hash/default_rules_file写入每卷记录；提交前再次检查。相同任务、同一上下文重复intake保留冻结规则，升级技能不静默改变已开始的任务；改变学科、学段、小学年级段、题型或覆盖条款须先换细则版本，再处理受影响答卷。历史旧版记录保留原数据，未绑定时不伪造已应用新规则。

规则包提供判断原则及适用条件，由主智能体理解并用于评分；哈希、覆盖验证和测试只证明载入与留档流程，不能证明语义判分必然正确。

## v3.2学段与学科入口

从材料先识别学段，再使用该学段名称选择学科。小学道德与法治与高中思想政治使用同一稳定代码civics，显示名来自stages.subjects，不影响共建枚举和私密经验索引。初中、高中grade一律null，不猜填7或10；旧冻结快照中的数值年级保持原文，比较与执行仅按学段，因此补充高二等信息不另换评分口径。小学grade可选；也可直接给primary_band，不能与已给年级冲突。

小学学科入口5项，初中10项（包括按学校实际课程使用的科学），高中9项。小学科学可按主题加载相关学科原则，但不把物理化学等列成小学独立学科；高中science只兼容理综试卷任务，不作为学科选项。
