#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCatalog } from "./rules.mjs";

/** A local, self-contained teacher reference; no student data or remote requests. */
export function renderRulesHTML(c) {
  const embedded = JSON.stringify(c).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>K12 分学段学科默认阅卷规则</title>
<style>
:root{color-scheme:light;--ink:#25372e;--muted:#667568;--line:#d9dfd6;--paper:#fffdf6;--accent:#346346}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#f1f3ec;color:var(--ink);font:16px/1.75 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:40px auto;padding:0 24px 36px}header{border-bottom:2px solid var(--ink);padding-bottom:24px}small{color:var(--muted)}h1{font-size:clamp(27px,4vw,39px);line-height:1.3;margin:8px 0 14px;letter-spacing:-.02em}h2{font-size:23px;line-height:1.4}h3{font-size:18px;line-height:1.4;margin:0 0 8px}p{margin:8px 0}.lead{max-width:850px}.controls{position:sticky;top:0;background:#f1f3ecf5;backdrop-filter:blur(8px);padding:20px 0;display:flex;gap:18px;flex-wrap:wrap;z-index:1}label{display:flex;flex:1;min-width:min(220px,100%);gap:8px;flex-direction:column;font-size:14px}select{width:100%;font:17px system-ui;padding:11px 32px 11px 12px;color:var(--ink);background:var(--paper);border:1px solid #9caa98;border-radius:4px}.stage{padding:22px 26px;background:#e4ebdc;border-left:4px solid var(--accent);margin-bottom:30px}.stage h2{margin-top:0}.stage ul{padding-left:22px}.example{padding-top:12px;border-top:1px solid #bbc9b7}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.rule{padding:22px;background:var(--paper);border-top:3px solid var(--accent);overflow-wrap:anywhere}.when{font-size:14px;color:var(--muted)}details{margin-top:30px;padding:20px 24px;background:var(--paper);border:1px solid var(--line)}summary{font-size:19px;cursor:pointer;font-weight:600}.common{padding:18px 0;border-bottom:1px solid var(--line)}footer{margin-top:32px;font-size:14px;color:var(--muted)}a{color:var(--accent)}@media(max-width:650px){main{margin-top:22px;padding:0 16px 24px}.grid{grid-template-columns:1fr}.rule,.stage{padding:18px}.controls{gap:10px;padding:14px 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}#primary-control{grid-column:1 / -1}label{min-width:0}select{font-size:15px;padding-left:8px}.controls label:first-child{flex:1.2}.controls label:last-child{flex:1}}@media print{main{margin:0;max-width:none}.controls{position:static}.grid{display:block}.rule{break-inside:avoid;margin-bottom:10px}details{break-inside:avoid}}
</style><main><header><small>教师参考 · ${Object.keys(c.subjects).length}类学科 / ${c.stages.length}个学段 / ${c.stages.reduce((n, s) => n + s.subjects.length, 0)}组学段学科 · 核对于${c.updated}</small><h1>每门学科，有自己的判分原则</h1><p class="lead">学科默认原则每题加载，再按学段限定深度，与本题细则合并。<strong>教师没提到的项继续适用；明确冲突只覆盖相应条款。</strong>教师只给总分时，智能体告知后补拟其余采分点与分值。</p><p><small>可直接告诉智能体“初中数学”或“高中思想政治”；材料已明确时无需重复选择。初中、高中不要求具体年级，小学可按需要选填年级段。</small></p></header>
<div class="controls"><label>先选学段<select id="school-stage" aria-label="选择学段"></select></label><label>再选学科<select id="subject" aria-label="选择学科" disabled></select></label><label id="primary-control" hidden>小学年级段（选填）<select id="band" aria-label="小学年级段"></select></label></div>
<section class="stage" id="stage" aria-live="polite"></section><h2 id="heading"></h2><div class="grid" id="rules"></div><details><summary>所有学科共同遵守的${c.common_rules.length}条原则</summary><div id="common"></div></details>
<footer><p>这些是基于教师既有工作流、公开课程与考试评价资料组织的操作性规则，包含适用范围与边界；具体分值在本题细则中确定。完整来源、已读范围及版本限制保存在随包来源说明中。没有把未获得的2025修订版全学科原文当作已吸收内容。</p><p>小学学科入口仅列语文、数学、英语、科学、道德与法治；初中和高中按对应课程名称显示。高中“理综”是组合试卷任务，按题目关联学科，不作为独立学科选项。</p><p>资料入口：<a href="https://www.ictr.edu.cn/download_center/ywjy.html">义务教育课程标准</a> · <a href="https://www.ictr.edu.cn/download_center/put.html">高中课程标准旧版基线</a> · <a href="https://www.cambridgeenglish.org/images/151760-pet-information-for-candidates-.pdf">英语写作评价维度参考</a>。国外题型、分档与扣分不直接迁入中国考试。</p></footer></main>
<script type="application/json" id="catalog">${embedded}</script><script>
const c=JSON.parse(document.getElementById('catalog').textContent),school=document.getElementById('school-stage'),subject=document.getElementById('subject'),band=document.getElementById('band');
function node(tag,text,cls){const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;}
function option(text,value){const o=node('option',text);o.value=value;return o;}
school.append(option('请选择学段',''));for(const stage of c.stages)school.append(option(stage.name,stage.id));
for(const b of c.bands.filter(b=>b.stage==='primary'))band.append(option(b.id==='primary'?'小学通用（不细分）':b.name,b.id));
function rule(r,cls){const a=node('article','',cls);a.append(node('h3',r.title),node('p','适用：'+r.when,'when'),node('p',r.principle));return a;}
for(const r of c.common_rules)document.getElementById('common').append(rule(r,'common'));
function render(){const stage=c.stages.find(s=>s.id===school.value),entry=stage?.subjects.find(s=>s.code===subject.value),area=document.getElementById('stage');document.getElementById('primary-control').hidden=school.value!=='primary';
 if(!stage||!entry){area.replaceChildren(node('h2',stage?'已选择'+stage.name+'，请选择学科':'先选择学段，再选择学科'),node('p','也可以直接告诉智能体本次阅卷的学段与学科；已知信息不用重复提供。'));document.getElementById('heading').textContent='';document.getElementById('rules').replaceChildren();return;}
 const code=entry.code,b=school.value==='primary'?band.value:school.value,p=c.subjects[code].profiles[b];area.replaceChildren(node('h2',stage.name+' · '+entry.name),node('p','课程范围：'+p.course_scope));const list=document.createElement('ul');for(const r of p.rules)list.append(node('li',r.title+'：'+r.principle));area.append(list,node('p','例如：'+p.example,'example'));document.getElementById('heading').textContent=entry.name+'的默认判分原则';document.getElementById('rules').replaceChildren(...c.subjects[code].rules.map(r=>rule(r,'rule')));}
function setSubjects(){const old=subject.value,stage=c.stages.find(s=>s.id===school.value);subject.replaceChildren(option(stage?'请选择学科':'请先选择学段',''));subject.disabled=!stage;if(stage)for(const s of stage.subjects)subject.append(option(s.name,s.code));if(stage?.subjects.some(s=>s.code===old))subject.value=old;render();}
school.addEventListener('change',setSubjects);subject.addEventListener('change',render);band.addEventListener('change',render);setSubjects();
</script></html>`;
}

export function renderRulesDocs(c) {
  const docs = new Map();
  docs.set(
    "rules/common.md",
    "# 每科每题默认加载的共同原则\n\n" +
      c.authority_notice +
      "\n\n" +
      c.common_rules
        .map(
          (r) =>
            `## ${r.title} · ${r.id}\n\n适用：${r.when}。\n\n${r.principle}\n`,
        )
        .join("\n") +
      "\n按[学段及学科入口](../subjects.md)选择对应规则。\n",
  );
  for (const [code, subject] of Object.entries(c.subjects)) {
    let text = `# ${subject.name}：默认阅卷规则\n\n每题默认加载，按适用条件判断；教师明确要求仅覆盖冲突部分。共同要求见[共同原则](common.md)。初中和高中只分学段，不要求具体年级；小学年级段为可选细化。\n\n本页由catalog.json生成，维护时修改数据源并运行scripts/build_rules_docs.mjs。\n\n## 本学科默认原则\n\n`;
    text += subject.rules
      .map(
        (r) =>
          `### ${r.title} · ${r.id}\n\n适用：${r.when}。\n\n${r.principle}\n`,
      )
      .join("\n");
    for (const band of c.bands) {
      const stage = c.stages.find((s) => s.id === band.stage),
        entry = stage.subjects.find((s) => s.code === code),
        composite = code === "science" && band.stage === "high";
      if (!entry && !composite) continue;
      const profile = subject.profiles[band.id],
        title = composite
          ? "高中理综任务（非独立学科）"
          : band.stage === "primary"
            ? band.name
            : stage.name + " · " + entry.name;
      text +=
        `\n<a id="${band.id}"></a>\n\n## ${title}\n\n课程范围：${profile.course_scope}。\n\n` +
        profile.rules
          .map((r) => `- **${r.title}**（${r.id}）：${r.principle}`)
          .join("\n") +
        `\n\n例：${profile.example}\n`;
    }
    text += `\n## 来源与性质\n\n${c.authority_notice}\n\n来源索引：${subject.sources.map((id) => "`" + id + "`").join("、")}，详见[来源说明](../public-sources.md)。条款为操作性归纳，不冒充官方逐条评分原文。\n\n返回[学段及学科入口](../subjects.md)。\n`;
    docs.set("rules/" + code + ".md", text);
  }
  let index = `# 先确定学段，再确定学科\n\n当前覆盖小学、初中、高中3个学段，共${c.stages.reduce((n, s) => n + s.subjects.length, 0)}组学段学科入口。初中、高中不分具体年级；小学可按题目需要选填年级或年级段，未提供就使用小学通用规则，不猜测年级。\n\n教师可直接说“初中数学”“高中思想政治”。从题目、平台或已给材料能确定的，不重复询问；只有“数学”“物理”等同名学科而无法确定学段时，才简短补问学段。\n\n学科默认原则每题生效，教师没提到的项保留，明确冲突仅覆盖相应条款。${c.authority_notice}\n`;
  for (const stage of c.stages) {
    index += `\n## ${stage.name}\n\n| 学科名称 | 默认原则与学段要求 |\n| --- | --- |\n`;
    for (const entry of stage.subjects)
      index += `| ${entry.name} | [展开](rules/${entry.code}.md#${stage.id}) |\n`;
    if (stage.id === "primary")
      index +=
        "\n小学仅以上5科学科入口。年级段可选1—2、3—4、5—6，不选则用小学通用；相关自然主题通过科学课程理解，不另列物理、化学等独立小学科目。\n";
    if (stage.id === "middle")
      index +=
        "\n初中保留“科学”以适配学校实际开设的综合科学课程；与分科教学并列作为可选入口，不假定每所学校同时开设全部科目。\n";
    if (stage.id === "high")
      index +=
        "\n高中使用“思想政治”。理综为组合试卷任务，内部可用science并指定related_subjects，按实际小问加载物理、化学、生物规则，不出现在学科下拉选项中。\n";
  }
  index += `\n## 执行顺序\n\n1. 优先读取已知学段与学科；缺失时先确定学段，再按该学段名称询问学科。也可一次简问“这次阅哪个学段、哪门学科？”不要强制教师走菜单。\n2. 运行workflow.mjs rules，读取[共同原则](rules/common.md)、本学科默认原则和学段调整；先向教师取已有细则，缺项告知后由agent补拟。\n3. 定稿采分条件、独立与依赖、部分分和来源，再运行workflow.mjs intake冻结有效规则。完整教师细则也不整体关闭默认原则。\n4. 教师明确冲突按rule_overrides逐条记录rule_id、source、quote、source_ref、conflict、replacement；无提及不等于取消，“不扣单位”也不取消模型、方向等其他条件。\n5. 评分开始后保留规则全文快照，独立复核使用同版规则；变更学段、学科、小学年级段或覆盖口径先更新细则版本并复核受影响答卷。初中、高中不因年级信息变化另换规则。\n\n## 智能体数据\n\n上下文：stage（primary/middle/high）、subject。学段可从“高中数学”等明确名称或既有材料识别；仅说“思想政治”可识别为高中。初中、高中不需要grade，也不填7或10冒充教师已提供信息；上下文中的grade统一为null，旧冻结记录保留原文但按学段校验。小学可选grade 1—6或primary_band（primary、primary-1-2、primary-3-4、primary-5-6）。\n\n综合科学或理综任务按本题提供related_subjects；相关学科是内容参考，不改变小学学科入口。所有JSON由智能体生成，教师只用自然语言。\n\n\`\`\`sh\nnode scripts/workflow.mjs rules --input 本地学段学科上下文.json\nnode scripts/workflow.mjs intake --run-dir 本机私密任务目录 --input 本地材料核对.json\n\`\`\`\n\n规则更新参看[合成校准情境](rules/calibration.md)，重点检查等价解法、局部错误、只评结果和证据不足。来源与适用限制见[来源说明](public-sources.md)，复核见[终审流程](review.md)，数据字段见[数据契约](contracts.md)。\n`;
  docs.set("subjects.md", index);
  return docs;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const docs = renderRulesDocs(readCatalog());
  for (const [file, body] of docs)
    fs.writeFileSync(new URL("../references/" + file, import.meta.url), body);
  const htmlIndex = process.argv.indexOf("--html");
  if (htmlIndex >= 0) {
    if (!process.argv[htmlIndex + 1]) throw new Error("--html须指定输出文件");
    const output = path.resolve(process.argv[htmlIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, renderRulesHTML(readCatalog()));
  }
  console.log(JSON.stringify({ generated: docs.size }));
}
