# dsh-notify

简体中文 | [English](README.en.md)

**离开 DSH 页面也不错过任何动静。** 当模型停下来需要你操作(审批 / 方案待确认 / 提问)、或你在别的软件时回复正好完成,dsh-notify 会用系统通知 + 提示音 + 标签页标题标记提醒你——开关和通知语言都直接在 **DSH 设置 → 通知提醒** 里改。

设计参考 [chromoany/dsh-notify-me](https://github.com/chomoany/dsh-notify-me)(MIT,感谢!),针对 **DSH 0.2** 的客户端服务模型完全重写、独立维护——原插件只兼容到 0.1.5。

---

## 与 dsh-notify-me 的关系

这个插件延续 dsh-notify-me 的产品设计与交互(提醒时机、三种提醒通道、设置页、中英双语),但浏览器半身针对 DSH 0.2 重写了数据层:

| | dsh-notify-me(1.1.8) | dsh-notify(0.1.0) |
| --- | --- | --- |
| 兼容 DSH | 0.1.1 ~ 0.1.5-rc.2 | **0.2.0-rc.0 及以上**(peerDependencies 声明) |
| 「需要你」数据源 | `uiSession.pendingInteractions`(0.1.2+)+ 旧控制器快照双路径 | `uiSession.sessionStatus`(0.2 统一状态存储) |
| 「回复完成」数据源 | 当前会话 ConversationSnapshot `running` + 列表行 `completed` | `sessionStatus.running`(当前/后台会话统一) |
| 「当前会话」判定 | 列表 `current` 字段 | 列表行 `retainedBy.mainView`(0.2 无 `current`) |
| 点通知跳转 | `sessions.open(id)`(0.2 已移除) | `uiWorkspace.openSession(id)` |
| 通知正文摘要 | 当前会话最后一条助手消息(快照 `nodes`) | 会话标题(0.2 快照不再携带 `nodes`) |
| 无 UI 层宿主 | 旧控制器路径兜底 | 列表行 `running` 兜底(仅完成提醒) |
| 版本兼容声明 | `dsh.compatibility.dshReleases`(0.2 已废弃) | `peerDependencies["@deepseek-ai/dsh"]` |

## 提醒时机

| 时机 | 提醒内容 | 默认 |
| --- | --- | --- |
| 🔔 **模型需要你操作** — 审批请求 / 方案待确认(plan review)/ 提问(`ask_user_question`) | 通知 + 提示音 + `🔔 需要你 ·` 标题标记 | 页面可见也提醒 |
| ✅ **回复完成** — 一轮回复跑完;后台会话完成也会报 | 通知 + 提示音 | 仅页面隐藏/后台时提醒 |

## 在 DSH 设置里改配置

打开 **设置 → 通知提醒**(安装后刷新一次页面即可看到),页面提供:

- **启用提醒** 主开关:关闭后不再弹系统通知、不播放提示音、也不改标签页标题;
- **系统通知 / 提示音 / 音量**:Toast、WebAudio 提示音与音量滑块;
- **页面打开时也提醒「需要你」**(默认开)与 **页面打开时也提醒「回复完成」**(默认关);
- **当前对话不弹通知**(默认开):等待就发生在你正看着的对话里时,只留标签页标记——审批卡片本来就在屏幕上,Toast 只会盖住它;页面一转到后台立刻补发;
- **点击通知回到对应对话**(默认开):点系统通知把 DSH 带到前台,并直接切到这条提醒所属的对话;
- **通知语言**:跟随界面 / 简体中文 / English;
- **测试按钮**:用当前设置立即发一条「需要你」或「回复完成」测试提醒(不受「页面打开时也提醒」开关限制)。

> 需要浏览器通知权限:页面上点一下 → 允许;或地址栏锁 → 站点设置 → 通知 → 允许 → 刷新。

## 安装

```powershell
# DSH 官方插件命令:安装并自动挂载进 web profile
dsh plugin --profile web add dsh-notify
```

重启 `dsh web`(桌面版重启应用)后硬刷新页面(Ctrl+Shift+R)。

- 未发布到 npm 时可从 git 安装:`dsh plugin --profile web add github:chongyi/dsh-notify`
  或本地路径:`dsh plugin --profile web add /path/to/dsh-notify`
- 兼容性由 `peerDependencies["@deepseek-ai/dsh"]: ">=0.2.0-rc.0 <0.3.0"` 声明;安装器与启动检查据此拒绝不匹配的运行时组合。

**验证** — F12 控制台执行:

```js
window.__dshNotify.test("done")        // 「完成」示例
window.__dshNotify.test("attention")   // 「需要你」示例
window.__dshNotify.debug()             // 绑定状态、权限、已提醒 key 等诊断
```

没反应?九成是:通知权限被拒绝(页面上点一下 → 选「允许」;或地址栏锁 → 站点设置 → 通知 → 允许 → 刷新)、装完没重启 DSH、系统设置里浏览器通知被关。

## 控制台高级配置

设置页是第一入口;想脚本化/批量改或恢复默认时,偏好存 `localStorage`(`dshNotify.config`),可用控制台实时调整:

```js
window.__dshNotify.config                       // 查看
window.__dshNotify.setConfig({
  enabled: true,              // false = 关闭所有提醒(主开关)
  language: "auto",           // 'auto' 跟随界面 | 'zh' 简体中文 | 'en' English
  attentionHiddenOnly: false, // true = 页面可见时「需要你」不提醒
  currentHiddenOnly: true,    // false = 当前对话的等待也弹通知
  doneHiddenOnly: true,       // false = 页面可见时「完成」也提醒
  toast: true,                // 系统通知开关
  sound: true,                // 提示音开关
  volume: 0.5,                // 音量 0~1
  autoFocus: true             // 点通知切回对应对话
})
window.__dshNotify.resetConfig()                // 恢复默认
window.__dshNotify.onEvent = (kind, p) => console.log(kind, p)  // 事件钩子(测试用)
```

## 工作原理(DSH 0.2)

浏览器半身订阅客户端服务(与 UI 同一数据源),全部经 `ctx.get()` 懒解析、失败可降级:

- **`uiSession.sessionStatus`** — 0.2 的统一会话状态存储,发布 `Map<sessionId, { running, pendingInteraction, completionUnread }>`:
  - 新增 `pendingInteraction`(带 `kind`: `approval` / `plan-review` / `question`,域对象自带 `toolName·reason` 或 `questions[]` 详情)= 模型在等你 → 「需要你」提醒;
  - `running` true→false(当前/后台会话统一)= 回复完成 → 「完成」提醒;
- **`sessions.list`** — 会话目录行(`displayTitle` 标题、`retainedBy.mainView` 主视图占用)。标题用于提醒文案,`mainView > 0` 即「你正看着的对话」;
- **`uiWorkspace.openSession(id)`** — 点击通知切到对应会话(会话已离开列表则不调用)。

两个懒解析的服务**故意不写进 cordis `inject`**——inject 是硬门槛,服务缺失会让整个条目停在 `pending` 并拖垮 web 启动审计(原插件 1.1.3/1.1.4 踩过的坑)。无 `uiSession` 的组合(无 UI 层)自动降级为列表行 `running` 驱动的纯「完成」提醒。

提醒核心零第三方运行时依赖、完全自包含;通知文字按所选语言即时解析。设置页是**可选的** React 呈现层——web profile 提供 `slots` / `locale` / `react` 时才注册进「设置 → 通知提醒」,缺任一能力时自动降级为纯提醒。

## 已知限制

- 页面必须开着才会提醒(后台标签/最小化可以;关标签页即失效——浏览器层方案固有限制)。
- 通知经由浏览器弹出,需允许浏览器通知权限,且勿扰模式不能屏蔽它。
- 每次页面加载后第一次出声/弹通知前,需在页面上点击过一次(浏览器自动播放与权限策略)。
- 未授权通知权限时只有提示音与标题标记。
- 配置存在浏览器 `localStorage`:换浏览器/设备或清除站点数据后会回到默认值(设置页可一键恢复默认)。
- 「回复完成」正文只带会话标题,不再带最后一条助手消息摘要——0.2 的会话快照不再暴露 `nodes`。

## 开发自检

```powershell
node --check lib\client.js
node --check lib\index.js
node smoke\smoke-test.cjs     # 离线状态机冒烟测试(0.2 全宿主 + 无 uiSession 降级宿主)
npm pack --dry-run            # 预览发布包
```

## License

MIT — 见 [LICENSE](LICENSE)。设计参考 [dsh-notify-me](https://github.com/chomoany/dsh-notify-me)(MIT)。
