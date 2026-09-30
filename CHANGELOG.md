# Changelog

All notable changes to **dsh-notify** are documented here.

## [0.1.0] — 2026-09-30

首个版本。设计参考 [chromoany/dsh-notify-me](https://github.com/chomoany/dsh-notify-me)(MIT),针对 DSH 0.2 重写数据层、独立维护。

### 新增
- **「模型需要你操作」提醒**:审批请求 / 方案待确认(plan review)/ 提问(`ask_user_question`)出现时,系统通知 + 提示音 + `🔔 需要你 ·` 标签页标题标记;通知正文带交互详情(审批的 `toolName · reason`、提问/方案的文字)与会话标题。数据源为 0.2 的 `uiSession.sessionStatus`(经 `ctx.get()` 懒解析,同 key 去重、替换即换标记)。
- **「回复完成」提醒**:`sessionStatus.running` true→false 边沿触发(当前/后台会话统一);默认仅页面隐藏时提醒。
- **点击通知回到对应对话**:`uiWorkspace.openSession(id)`(0.2 移除了 `sessions.open`);会话已离开列表则只把窗口带到前台、不调用。
- **设置页**(设置 → 通知提醒):主开关、系统通知/提示音/音量、「页面打开时也提醒」×2、「当前对话不弹通知」、点击通知跳转、通知语言(跟随界面/中文/English)、测试按钮、恢复默认。仅当 web profile 提供 `react`+`slots`+`locale` 时注册,缺任一自动降级为纯提醒。
- **无 UI 层降级**:`uiSession` 缺失的组合自动改由列表行 `running` 驱动「完成」提醒(不硬注入该服务,避免条目停在 `pending` 拖垮启动审计)。
- **`window.__dshNotify`**:`config` / `setConfig` / `resetConfig` / `test("attention"|"done")` / `debug()`(绑定状态、权限、已提醒/已标记/排队 key)与 `onEvent` 钩子。
- **离线冒烟测试** `smoke/smoke-test.cjs`:0.2 全宿主(18 组用例)+ 无 `uiSession` 降级宿主。

### 与 dsh-notify-me 的差异
- 兼容声明改用 `peerDependencies["@deepseek-ai/dsh"]`(`dsh.compatibility.dshReleases` 在 0.2 已废弃)。
- 「当前会话」判定改用列表行 `retainedBy.mainView`(0.2 无 `current` 字段)。
- 「回复完成」正文只带会话标题:0.2 会话快照不再暴露 `nodes`,最后一条助手消息摘要无法廉价取得。
- `package.json` 的 `dsh.client` 不再列 `inject` 模块依赖——0.2 的模块图会拒绝缺失的供应方,而本插件的 bundle 只依赖平台种子表中的 `react`。
