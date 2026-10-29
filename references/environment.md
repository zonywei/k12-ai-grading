# 环境：智能体配置，教师只登录

## 首次与后续入口

先找到宿主可用的 Python>=3.11、Node>=20 与 npm，优先使用宿主已捆绑或本机已管理的运行时，不硬编码开发者的绝对路径。Mac 可使用宿主运行时/Homebrew/fnm/uv，Windows 可检查宿主托管Python、Node及用户级包管理器，Linux可使用已有用户级运行时。先实际探测再选择。

```sh
python3 scripts/bootstrap.py
python3 scripts/bootstrap.py --repair
```

第二条由智能体在第一条未就绪时自动执行。它在技能目录运行 `npm ci`，在本机私密数据目录创建独立venv，按 `requirements.txt` 安装图片、PDF、Word读取依赖，并实际启动和关闭无头浏览器，依次尝试Chrome、Edge和Playwright Chromium；已有浏览器不可用则自动安装Chromium。正式登录窗口始终有界面。浏览器的缓存启动探测最长保留30天，技能路径、运行时或锁文件变化时重验；实际启动失败执行 `bootstrap.py --repair --force-browser` 强制重验和修复。

输出中的 `sharing` 给出首次共享说明是否待展示；工具输出本身不等于已向教师说明，按共建协议处理。

输出 `ready=true` 才能说已就绪。`teacher_notice` 只在首次配置成功时出现：“一次配置，长期使用”。后续仍检查依赖版本和运行时，但不反复讲安装过程。环境状态在私密 `environment.json`，不进技能ZIP。配置使用操作系统跨进程锁，Codex/WorkBuddy同时启动时串行配置；中断由系统释放锁。状态文件用唯一临时名原子替换，避免相互覆盖。

基础Python/Node缺失时，检查本机已经可用的官方安装管理器，由智能体安装官方支持的用户级版本，再重跑。两种运行时都没有也不能要求教师执行命令；宿主智能体应完成官方下载安装。系统要求管理员密码、设备许可或安装界面操作时，明确这是一次性系统交互，让教师完成该步后继续。不要关闭安全机制或改系统权限来绕过。Linux缺少浏览器系统库时按Playwright当前官方依赖指引处理；不能把浏览器下载完成当作能启动。

当前锁定 Node Playwright 1.64.1；Python依赖具体版本见requirements。升级依赖先在合成站点跑完测试，随后更新锁文件。不要每次阅卷顺便无边界更新。

## 本地目录

- Mac：`~/Library/Application Support/k12-ai-grading/`
- Windows：`%LOCALAPPDATA%/k12-ai-grading/`
- Linux：`~/.local/share/k12-ai-grading/`

`python/`放独立依赖；`runs/<本次任务>/`放浏览器profile、原图、评分与报告；`experience/`放个人经验；`contributions/`放私密的共享选择/告知记录与配置，以及已获同意的固定枚举共建队列（选择记录也不能公开）。目录0700、文件0600；Windows沿用用户私有配置目录及账户ACL，不能放入所有人共享目录。首次使用只创建这些本技能文件，不改其它工具运行时。

PDF扫描件用PyMuPDF渲染成图后查看；pypdf抽不到文字不代表原题空白。Word可读段落/表格及内嵌图，复杂公式仍须对照渲染图。裁图辅助脚本 `media.py` 使用原图像素坐标并重新编码，去掉图像元数据。工具不能代替语义评分，也不宣称所有AI识别都离线完成。
