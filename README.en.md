# dsh-notify

English | [简体中文](README.md)

**Never miss a beat while away from the DSH page.** When the agent stops and needs your input (approval / plan review / question), or a reply finishes while you are in another app, dsh-notify raises a system notification + a chime + a tab-title marker — the switches and the notification language live in **DSH Settings → Notify me**.

Design informed by [chromoany/dsh-notify-me](https://github.com/chomoany/dsh-notify-me) (MIT, thanks!) and fully rewritten for the **DSH 0.2** client service model as an independently maintained plugin — the original only supports up to 0.1.5.

---

## Relationship to dsh-notify-me

This plugin keeps dsh-notify-me's product design and interactions (alert timing, three alert channels, the settings page, zh/en copy) but the browser half's data layer is rewritten for DSH 0.2:

| | dsh-notify-me (1.1.8) | dsh-notify (0.1.0) |
| --- | --- | --- |
| DSH compatibility | 0.1.1 ~ 0.1.5-rc.2 | **0.2.0-rc.0 and newer** (declared via peerDependencies) |
| "needs you" source | `uiSession.pendingInteractions` (0.1.2+) + legacy controller snapshots | `uiSession.sessionStatus` (the unified 0.2 status store) |
| "reply finished" source | current session ConversationSnapshot `running` + list-row `completed` | `sessionStatus.running` (uniform for current/background sessions) |
| "current session" | list `current` field | list row `retainedBy.mainView` (0.2 has no `current`) |
| toast click target | `sessions.open(id)` (removed in 0.2) | `uiWorkspace.openSession(id)` |
| done body snippet | last assistant message of the current session (snapshot `nodes`) | session title (0.2 snapshots no longer expose `nodes`) |
| hosts without the UI layer | legacy controller fallback | list-row `running` fallback (done alerts only) |
| compatibility declaration | `dsh.compatibility.dshReleases` (dropped in 0.2) | `peerDependencies["@deepseek-ai/dsh"]` |

## When it alerts

| Moment | Alert | Default |
| --- | --- | --- |
| 🔔 **The agent needs you** — approval request / plan review / question (`ask_user_question`) | notification + chime + `🔔 Action needed ·` title marker | alerts even while the page is visible |
| ✅ **Reply finished** — a turn completes; background sessions included | notification + chime | only while the page is hidden/backgrounded |

## Configure in DSH Settings

Open **Settings → Notify me** (refresh the page once after installing). The page offers:

- **Enable reminders** master switch: off = no toasts, no sounds, no tab-title changes;
- **System notifications / Sound / Volume**: toasts, WebAudio chimes and the volume slider;
- **Also alert "needs you" while the page is open** (on by default) and **also alert "reply finished"** (off by default);
- **Stay quiet for the conversation on screen** (on by default): a wait inside the conversation you are looking at keeps only the tab marker — the approval card is already on screen and a toast would only cover it; backgrounding the page re-delivers it immediately;
- **Click a toast to open that conversation** (on by default): clicking a toast brings DSH forward and switches to the conversation the alert came from;
- **Notification language**: follow the interface / Simplified Chinese / English;
- **Test buttons**: fire one "needs you" or "reply finished" test alert with the current settings (not limited by the "while the page is open" toggles).

> Browser notification permission required: click once on the page → Allow; or the address-bar lock → Site settings → Notifications → Allow → reload.

## Install

```powershell
# official DSH plugin command: installs and mounts into the web profile
dsh plugin --profile web add dsh-notify
```

Restart `dsh web` (or the desktop app) and hard-refresh the page (Ctrl+Shift+R).

- Before an npm release, install from git: `dsh plugin --profile web add github:chongyi/dsh-notify`
  or from a local path: `dsh plugin --profile web add /path/to/dsh-notify`
- Compatibility is declared via `peerDependencies["@deepseek-ai/dsh"]: ">=0.2.0-rc.0 <0.3.0"`; the installer and startup checks reject mismatched runtimes.

**Verify** — in the F12 console:

```js
window.__dshNotify.test("done")        // "finished" sample
window.__dshNotify.test("attention")   // "needs you" sample
window.__dshNotify.debug()             // binding state, permission, fired keys, diagnostics
```

Nothing popped? Nine times out of ten: notification permission denied (click once on the page → Allow; or the address-bar lock → Site settings → Notifications → Allow → reload), DSH not restarted after install, or browser notifications disabled in the OS settings.

## Console-level configuration

The settings page is the primary entry; preferences live in `localStorage` (`dshNotify.config`) and can be tweaked live for scripting/bulk edits:

```js
window.__dshNotify.config                       // inspect
window.__dshNotify.setConfig({
  enabled: true,              // false = all alerts off (master switch)
  language: "auto",           // 'auto' follows the UI | 'zh' | 'en'
  attentionHiddenOnly: false, // true = no "needs you" alerts while visible
  currentHiddenOnly: true,    // false = toast even for the on-screen conversation
  doneHiddenOnly: true,       // false = "done" alerts while visible too
  toast: true,                // system notifications
  sound: true,                // chime
  volume: 0.5,                // 0..1
  autoFocus: true             // toast click focuses that conversation
})
window.__dshNotify.resetConfig()                // restore defaults
window.__dshNotify.onEvent = (kind, p) => console.log(kind, p)  // event hook (testing)
```

## How it works (DSH 0.2)

The browser half subscribes to client services (the same data sources the UI uses), all resolved lazily through `ctx.get()` with graceful degradation:

- **`uiSession.sessionStatus`** — 0.2's unified session status store publishing `Map<sessionId, { running, pendingInteraction, completionUnread }>`:
  - a new `pendingInteraction` (carrying `kind`: `approval` / `plan-review` / `question`; the domain objects bring `toolName·reason` or `questions[]` detail) = the agent waits on you → "needs you";
  - `running` true→false (uniform for current/background sessions) = a reply finished → "done";
- **`sessions.list`** — session catalog rows (`displayTitle`, `retainedBy.mainView`). Titles feed the alert copy; `mainView > 0` marks "the conversation you are looking at";
- **`uiWorkspace.openSession(id)`** — switching to a session on toast click (never called once the session left the list).

The two lazily-resolved services are deliberately **not** cordis `inject` entries — inject is a hard gate; a missing service would leave the whole entry `pending` and fail the web boot audit (the trap dsh-notify-me hit in 1.1.3/1.1.4). Compositions without `uiSession` (no UI layer) degrade to list-row-`running`-driven done alerts.

The reminder core has zero third-party runtime dependencies and is fully self-contained; the notification copy resolves live per selected language. The settings page is an **optional** React layer — it registers into "Settings → Notify me" only when the web profile provides `slots` / `locale` / `react`, and the plugin degrades to pure alerting otherwise.

## Known limitations

- The page must stay open (background tab/minimized is fine; closing the tab disables everything — inherent to a browser-layer solution).
- Notifications go through the browser; permission must be granted and Do-Not-Disturb must not block them.
- After each page load, the first sound/notification needs one prior click on the page (autoplay & permission policies).
- Without notification permission only the chime and the title marker work.
- Preferences live in browser `localStorage`: switching browser/device or clearing site data restores defaults (one click in the settings page resets them too).
- The "reply finished" body carries the session title only — no last-assistant-message snippet, because 0.2 session snapshots no longer expose `nodes`.

## Development checks

```powershell
node --check lib\client.js
node --check lib\index.js
node smoke\smoke-test.cjs     # offline state-machine smoke test (0.2 full host + no-uiSession degraded host)
npm pack --dry-run            # preview the published package
```

## License

MIT — see [LICENSE](LICENSE). Design informed by [dsh-notify-me](https://github.com/chomoany/dsh-notify-me) (MIT).
