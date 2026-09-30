// dsh-notify — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-notify/client.js and executed
// through the client module system's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with
// require() resolved against the shell's module table — the same shape every
// shipped ui-* package's bundle emits. react is part of the platform seed
// table, so require("react") resolves to the shell-seeded instance; the
// settings page is skipped when react or the slots/locale services are
// absent, keeping the reminder core self-contained.
//
// Designed after chromoany/dsh-notify-me (MIT), rewritten for DSH 0.2:
//
// DSH 0.2 moved everything this plugin needs into two services:
//   * "uiSession" -> ctx.uiSession.sessionStatus, a store publishing a
//     Map<sessionId, { running, pendingInteraction, completionUnread }> —
//     pendingInteractions live here now (0.1.x carried them on the Controller
//     session snapshots; 0.2 snapshots have neither `pending` nor `nodes`).
//     The interaction values are domain objects carrying kind + key +
//     sessionId plus their own detail fields:
//       PendingApproval  { kind: "approval",     toolName, reason, callId }
//       PendingQuestion  { kind: "question" | "plan-review", questions[] }
//     It is resolved through ctx.get() — cordis throws on a plain
//     ctx.uiSession read for any name absent from the plugin's inject map,
//     and a hard inject entry would gate the whole plugin on the service
//     existing (a missing service leaves the entry pending forever);
//   * "sessions" -> ctx.sessions.list, the session catalog rows
//     ({ id, displayTitle, running, retainedBy: { mainView } }). Titles come
//     from displayTitle; the conversation the user is looking at is the row
//     with retainedBy.mainView > 0 (0.2 has no list "current" field).
//
// When uiSession is reachable it owns both alert channels; the list rows then
// only label alerts. Without uiSession (a composition lacking the UI layer)
// the list rows' own running bits still drive reply-finished alerts, so the
// plugin degrades to done-only instead of going silent.
//
//   - fires a desktop Notification (+ optional WebAudio chime) when the agent
//     needs the user's input — approval / plan-review / question — and when a
//     reply/turn finishes;
//   - marks the tab title while any wait is open;
//   - registers a "通知提醒 / Notify me" page into DSH Settings
//     (settings.section slot) with an on/off master switch, per-channel
//     toggles, volume and the notification language;
//   - preferences persist in localStorage and are tweakable on
//     window.__dshNotify.

window.__ModuleLoader__.load({
  id: "dsh-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // react is externalized into the loader module table; never required by
    // the reminder core, only by the optional Settings page.
    var React = null;
    try { React = require("react") || null; } catch (e) { React = null; }

    // ───────────────────────── configuration ─────────────────────────
    var LS_CONFIG = "dshNotify.config";
    var DEFAULTS = {
      enabled: true, // master switch: off = no toast/sound/title marker at all
      // language of the notification copy: 'auto' follows the DSH UI locale,
      // 'zh' and 'en' pin Simplified Chinese / English.
      language: "auto",
      // toast + sound are only useful while the user is elsewhere; the tab
      // being hidden is the reliable "away" signal.
      attentionHiddenOnly: false, // needs-input alerts even while the page is visible
      // A wait inside the conversation already on screen needs no toast: the
      // approval card is right there, and a toast lands on top of it. Leaving
      // the page brings that alert back (see flushQuieted).
      currentHiddenOnly: true, // the visible session's own waits stay silent
      doneHiddenOnly: true, // reply-finished alerts only when the page is hidden
      toast: true,
      sound: true,
      volume: 0.5,
      autoFocus: true // clicking the toast focuses the DSH window
    };
    function readConfig() {
      var cfg = {};
      try {
        var raw = localStorage.getItem(LS_CONFIG);
        if (raw) cfg = JSON.parse(raw);
      } catch (e) { /* corrupt storage -> defaults */ }
      for (var k in DEFAULTS) if (!(k in cfg)) cfg[k] = DEFAULTS[k];
      return cfg;
    }
    function writeConfig(patch) {
      var cfg = readConfig();
      for (var k in patch) cfg[k] = patch[k];
      try { localStorage.setItem(LS_CONFIG, JSON.stringify(cfg)); } catch (e) {}
      return cfg;
    }
    var config = readConfig();
    // Persist a patch, swap the live module config and re-apply any active
    // title marker (its prefix follows the notification language).
    function setConfigLocal(patch) {
      config = writeConfig(patch);
      applyTitle();
      return config;
    }

    // ───────────────────────── copy tables ─────────────────────────
    // Notification copy, keyed by language id. Selected through
    // effectiveLang() so a pinned language stays pinned even while the DSH UI
    // speaks the other one.
    var TXT = {
      zh: {
        kind: { approval: "审批请求", "plan-review": "方案待确认", question: "提问" },
        kindDefault: "需要操作",
        bodyKind: { approval: "有审批待处理", "plan-review": "方案待确认", question: "有提问待回答" },
        bodyDefault: "需要你操作",
        current: "当前对话",
        doneTitle: "DSH · 回复完成",
        doneBody: "回复已完成",
        background: "后台会话",
        marker: "🔔 需要你 · ",
        sep: "：",
        testAttention: "这是一条测试提醒：DSH 需要你的操作",
        testDone: "测试提醒 · 回复完成示例"
      },
      en: {
        kind: { approval: "Approval request", "plan-review": "Plan review", question: "Question" },
        kindDefault: "Action needed",
        bodyKind: {
          approval: "An approval is waiting for you",
          "plan-review": "A plan awaits your review",
          question: "A question is waiting for you"
        },
        bodyDefault: "Your input is needed",
        current: "Current conversation",
        doneTitle: "DSH · Reply finished",
        doneBody: "Reply finished",
        background: "Background session",
        marker: "🔔 Action needed · ",
        sep: ": ",
        testAttention: "This is a test alert: DSH is waiting for your input",
        testDone: "Test alert · reply-finished sample"
      }
    };
    // Locale service handle (registered on the client context by dsh-client-locale).
    var localeSvc = null;
    // Current DSH UI language: 'zh' | 'en' | null (unknown). Used by the
    // 'auto' notification-language mode.
    function currentUILang() {
      try {
        if (localeSvc && typeof localeSvc.getLocale === "function") {
          var a = localeSvc.getLocale().active;
          if (typeof a === "string" && a) {
            if (a.indexOf("zh") === 0) return "zh";
            if (a.indexOf("en") === 0) return "en";
          }
        }
      } catch (e) {}
      try {
        var dl = (document.documentElement && document.documentElement.lang) || "";
        if (dl.indexOf("zh") === 0) return "zh";
        if (dl.indexOf("en") === 0) return "en";
      } catch (e) {}
      return null;
    }
    function effectiveLang() {
      if (!config.language || config.language === "auto") return currentUILang() || "zh";
      return config.language === "en" ? "en" : "zh";
    }
    function texts() { return TXT[effectiveLang()] || TXT.zh; }

    // ─────────────────────── notification plumbing ───────────────────
    var permAsked = false;
    function requestPermission() {
      if (!("Notification" in window) || permAsked) return;
      permAsked = true;
      try {
        if (Notification.permission === "default") {
          Notification.requestPermission().catch(function () {});
        }
      } catch (e) {}
    }
    function canToast() {
      if (!config.toast) return false;
      try {
        return "Notification" in window && Notification.permission === "granted";
      } catch (e) { return false; } // a policy-disabled Notification must not break delivery
    }
    // Bring the window forward and make the alerted session the main one, so
    // a click on the toast lands on the conversation that needs the user
    // instead of just the app. Every failure here is non-fatal: a session
    // that left the list, a composition without uiWorkspace, or a cordis
    // service that cannot be resolved must still leave a usable window in
    // front.
    function focusSession(sessionId) {
      try { window.focus(); } catch (e) {}
      if (!sessionId) return;
      try {
        var st = listStore && listStore.getSnapshot();
        if (st && st.byId && !st.byId[sessionId]) return; // left the list -> never open
        var svc = lookupService("uiWorkspace");
        if (!svc || typeof svc.openSession !== "function") return;
        svc.openSession(sessionId);
      } catch (e) {}
    }
    function showToast(kind, title, body, sessionId) {
      if (!canToast()) return;
      try {
        var n = new Notification(title, {
          body: body || "",
          tag: "dsh-notify-" + kind,
          renotify: true,
          icon: (location.origin || "") + "/favicon.svg"
        });
        if (config.autoFocus) {
          n.onclick = function () {
            focusSession(sessionId);
            n.close();
          };
        }
        setTimeout(function () { n.close(); }, 15000);
      } catch (e) {}
    }
    // Sound: WebAudio beeps (no asset needed). The context only runs after a
    // user gesture; we unlock it on the first pointer/key event.
    var audioCtx = null;
    function unlockAudio() {
      try {
        if (!audioCtx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          audioCtx = new AC();
        }
        if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
      } catch (e) {}
    }
    function tone(freq, startIn, durMs, vol) {
      if (!audioCtx || audioCtx.state !== "running") return;
      try {
        var t0 = audioCtx.currentTime + startIn;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + durMs / 1000 + 0.05);
      } catch (e) {}
    }
    function playAttentionSound() {
      if (!config.sound) return;
      unlockAudio();
      tone(880, 0.0, 140, config.volume);
      tone(1174, 0.16, 140, config.volume);
      tone(1568, 0.32, 200, config.volume);
    }
    function playDoneSound() {
      if (!config.sound) return;
      unlockAudio();
      tone(659, 0.0, 150, config.volume);
      tone(988, 0.18, 260, config.volume);
    }
    function unlockOnce() {
      unlockAudio();
      requestPermission();
    }
    function onFirstGesture() {
      unlockOnce();
      window.removeEventListener("pointerdown", onFirstGesture, true);
      window.removeEventListener("keydown", onFirstGesture, true);
    }
    window.addEventListener("pointerdown", onFirstGesture, true);
    window.addEventListener("keydown", onFirstGesture, true);

    // ────────────────────────── title marker ─────────────────────────
    // The host owns document.title (it tracks the session/workspace name), so
    // the base title is re-read on every apply instead of being frozen once —
    // and the exact string we last wrote is remembered, so the host taking the
    // title over (or an earlier load leaving a marker behind) can never make us
    // mistake our own marker for the base title.
    var attentionActive = 0;
    var hostBase = null; // document.title as the host last left it
    var writtenTitle = null; // exact string this plugin last put into document.title
    // Our own marker prefix never belongs to the base title — strip a leftover
    // one (an earlier load that was closed while a wait was pending, or a title
    // the host tracked while a marker was up) before storing the base.
    function cleanBase(t) {
      var prefixes = [texts().marker, TXT.zh.marker, TXT.en.marker];
      for (var i = 0; i < prefixes.length; i++) {
        while (t.indexOf(prefixes[i]) === 0) t = t.slice(prefixes[i].length);
      }
      return t;
    }
    function applyTitle() {
      try {
        var current = String(document.title || "");
        if (current !== writtenTitle) hostBase = cleanBase(current);
        var next = (config.enabled && attentionActive > 0) ? texts().marker + hostBase : hostBase;
        writtenTitle = next;
        if (current !== next) document.title = next;
      } catch (e) {}
    }
    function acquireTitleMark() {
      attentionActive += 1;
      applyTitle();
    }
    function releaseTitleMark() {
      if (attentionActive > 0) attentionActive -= 1;
      applyTitle();
    }
    // One title mark per open wait: acquired when a wait is first seen and
    // released exactly once when that wait (or its key) goes away, so a wait
    // replaced by a newer one in the same session never stacks markers and a
    // surviving wait never loses its marker to a sibling's release.
    function markAttention(key) {
      if (attentionKeysMarked[key]) return;
      attentionKeysMarked[key] = true;
      acquireTitleMark();
    }
    function unmarkAttention(key) {
      delete quietedAttention[key]; // the wait is over; a queued alert dies with it
      if (!attentionKeysMarked[key]) return;
      delete attentionKeysMarked[key];
      releaseTitleMark();
    }

    // ─────────────────────── shared alert core ───────────────────────
    var attentionKeysFired = Object.create(null); // dedupe per interaction key
    var attentionKeysMarked = Object.create(null); // keys currently holding a title mark
    // Waits silenced because their session is the one on screen, keyed by
    // interaction key so an entry dies with the wait it belongs to (the mark
    // release path deletes it) and is re-delivered once the page is backgrounded.
    var quietedAttention = Object.create(null);
    var lastAttentionAt = 0;

    function hidden() { return document.hidden || document.visibilityState === "hidden"; }

    // Deliver one alert regardless of visibility rules (used by the test
    // buttons); respects the master switch and permission state. The title
    // marker is NOT touched here — its ownership belongs to the watchers
    // (markAttention / unmarkAttention), which keeps the counter balanced.
    function deliver(kind, title, body, sessionId) {
      if (!config.enabled) return;
      showToast(kind, title, body, sessionId);
      if (kind === "attention") {
        playAttentionSound();
      } else {
        playDoneSound();
      }
      try {
        if (window.__dshNotify && window.__dshNotify.onEvent) {
          window.__dshNotify.onEvent(kind, { title: title, body: body, sessionId: sessionId || null });
        }
      } catch (e) {}
    }
    function fire(kind, title, body, isCurrent, sessionId) {
      if (!config.enabled) return false;
      if (kind === "attention" && config.attentionHiddenOnly && !hidden()) return false;
      // The wait belongs to the conversation the user is looking at right now:
      // the approval card is already on screen, so a toast would only cover the
      // thing it is asking about. The caller keeps the tab marker, and
      // flushQuieted() re-delivers the alert the moment the page is backgrounded.
      if (kind === "attention" && quietedByVisibleSession(isCurrent)) return false;
      if (kind === "done" && config.doneHiddenOnly && !hidden()) return false;
      deliver(kind, title, body, sessionId);
      return true;
    }
    // True when this alert must stay silent purely because it is about the
    // session already on screen. Kept separate from fire() so the caller can
    // queue exactly this case and nothing else.
    function quietedByVisibleSession(isCurrent) {
      return !!(isCurrent && config.currentHiddenOnly && !hidden());
    }
    // Queued copies of the alerts that rule suppressed. Delivered by key so a
    // wait that got answered while the user was still on the page never fires.
    function queueQuieted(key, copy) {
      if (key && copy) quietedAttention[key] = copy;
    }
    function flushQuieted() {
      if (!config.enabled || !hidden()) return;
      var keys = Object.keys(quietedAttention);
      for (var i = 0; i < keys.length; i++) {
        var copy = quietedAttention[keys[i]];
        delete quietedAttention[keys[i]];
        fire("attention", copy.title, copy.body, false, copy.sessionId);
      }
    }
    // The session the user is looking at, per the list rows' mainView
    // retention (DSH 0.2 has no list "current" field).
    function isMainSession(sid) {
      try {
        var st = listStore && listStore.getSnapshot();
        var row = st && st.byId && st.byId[sid];
        return !!(row && row.retainedBy && (row.retainedBy.mainView || 0) > 0);
      } catch (e) { return false; }
    }
    // Display label for a session id: the list row's display title, the
    // localized "current" placeholder for the session on screen, the raw id as
    // a last resort.
    function labelForSessionId(sid) {
      try {
        var st = listStore && listStore.getSnapshot();
        if (st && st.byId) {
          var row = st.byId[sid];
          if (row && (row.displayTitle || row.title)) return row.displayTitle || row.title;
        }
      } catch (e) {}
      return sid;
    }
    // Returns null once the alert went out, or the copy it would have shown
    // when only the visible-session rule held it back — the caller queues that
    // copy by interaction key so it can still fire from the background.
    function fireAttention(kind, sessionLabel, detail, isCurrent, sessionId) {
      var d = texts();
      var label = d.kind[kind] || d.kindDefault;
      var content = detail || d.bodyKind[kind] || d.bodyDefault;
      var who = sessionLabel || "";
      var title = "DSH · " + label;
      var body = (who ? who + d.sep : "") + content;
      if (quietedByVisibleSession(isCurrent)) return { title: title, body: body, sessionId: sessionId || null };
      fire("attention", title, body, isCurrent, sessionId);
      return null;
    }
    function fireDone(sessionLabel, sessionId) {
      var d = texts();
      fire("done", d.doneTitle, sessionLabel || d.doneBody, false, sessionId);
    }
    // Test alerts deliberately ignore the visibility rules (attentionHiddenOnly
    // / doneHiddenOnly): the whole point of a test button is to prove the
    // channel works while you are looking at the page. Only the master switch
    // (and browser notification permission) can stop them. The attention test
    // also drops its title marker again shortly after, so a test never leaves a
    // standing "waiting on you" mark in the tab.
    var TEST_MARK_RELEASE_MS = 6000;
    var TEST_MARK_KEY = "test:attention";
    function testAlert(kind) {
      var d = texts();
      if (kind === "attention") {
        deliver("attention", "DSH · " + d.kind.question, d.testAttention);
        markAttention(TEST_MARK_KEY);
        setTimeout(function () { unmarkAttention(TEST_MARK_KEY); }, TEST_MARK_RELEASE_MS);
      } else {
        deliver("done", d.doneTitle, d.testDone);
      }
    }

    // ───────────────────────── state machine ─────────────────────────
    // baseline: per-session-id observation state.
    //   { running: bool, pendingKey: string|null, seeded: bool }
    // Owned by whichever source is bound: uiSession.sessionStatus when
    // present (it sees pending interactions AND running for every session),
    // otherwise the list rows' running bits (done alerts only).
    var baseline = Object.create(null);
    var listStore = null; // sessions.list store
    var rootCtx = null; // client cordis context, captured at apply()
    var statusStore = null; // uiSession.sessionStatus store we subscribe to
    var statusSub = null;
    var statusBound = false; // true once sessionStatus is the driving source
    var statusBindNote = "not attempted"; // last lookup outcome, read by debug()
    var statusWarned = false; // one unreachable-service warning per page load
    var disposed = false;

    // One-line detail for a pending interaction. DSH 0.2 interaction objects:
    //   PendingApproval  — flat: toolName/reason/callId;
    //   PendingQuestion  — questions: [{ question, detail, options, multiSelect }].
    // Older/flat payload shapes are still scanned best-effort.
    function textFromPayload(payload) {
      if (!payload || typeof payload !== "object") return "";
      function clip(s) {
        s = String(s).replace(/\s+/g, " ").trim();
        if (!s) return "";
        return s.length > 160 ? s.slice(0, 160) + "…" : s;
      }
      // scalar fields (covers PendingApproval and flat payloads)
      var keys = ["text", "question", "prompt", "title", "summary", "description", "message", "operation", "toolName", "reason", "name", "tool"];
      for (var i = 0; i < keys.length; i++) {
        var v = payload[keys[i]];
        if (typeof v === "string") {
          var s = clip(v);
          if (s) {
            // PendingApproval carries both the tool and the human-readable
            // reason — "pwsh" alone says nothing useful in a toast.
            if (keys[i] === "toolName" && typeof payload.reason === "string" && clip(payload.reason)) {
              return s + " · " + clip(payload.reason);
            }
            return s;
          }
        } else if (v && typeof v === "object" && typeof v.text === "string" && clip(v.text)) {
          return clip(v.text);
        }
      }
      // nested batches (PendingQuestion.questions -> { question, detail, options })
      var qs = payload.questions;
      if (Array.isArray(qs) && qs.length > 0) {
        var q = qs[0];
        if (typeof q === "string") return clip(q);
        if (q && typeof q === "object") {
          var qk = ["question", "title", "text", "detail"];
          for (var j = 0; j < qk.length; j++) {
            if (typeof q[qk[j]] === "string" && clip(q[qk[j]])) return clip(q[qk[j]]);
          }
        }
      }
      return "";
    }

    // Raise (or queue) one needs-input alert for a freshly observed wait.
    function raiseInteraction(it, sid, key) {
      attentionKeysFired[key] = true;
      var copy = fireAttention(it.kind, labelForSessionId(sid), textFromPayload(it), isMainSession(sid), sid);
      if (copy) queueQuieted(key, copy);
      lastAttentionAt = Date.now();
      markAttention(key);
    }

    // Evaluate one session's status entry from uiSession.sessionStatus.
    // st: { running: boolean|undefined, pendingInteraction: object|undefined, ... }
    function evaluateStatusEntry(sid, st) {
      var it = st && st.pendingInteraction;
      var key = it ? (it.key || (it.kind + ":" + sid)) : null;
      var runningNow = !!(st && st.running);
      var prev = baseline[sid];
      if (!prev) {
        // Seed: a wait that already existed when the plugin (or page) mounted
        // still alerts once; no done edge fires from a seed.
        baseline[sid] = { running: runningNow, pendingKey: key, seeded: true };
        if (key) {
          if (attentionKeysFired[key]) markAttention(key); // alerted before, still needs its mark
          else raiseInteraction(it, sid, key);
        }
        return;
      }
      // 1) the wait changed: a new one appeared, or the old one was answered /
      //    replaced / cancelled. The old mark goes with the old key, otherwise
      //    the tab would keep one stale marker per replacement.
      if (key !== prev.pendingKey) {
        if (prev.pendingKey) unmarkAttention(prev.pendingKey);
        prev.pendingKey = key;
        if (key) {
          if (attentionKeysFired[key]) markAttention(key); // already alerted, still needs its mark
          else raiseInteraction(it, sid, key);
        }
      }
      // 2) running true -> false: a reply finished. Ignored while a wait is
      //    open in the same session (the attention alert already called the
      //    user back) and for a short window after one (same-tick guard).
      if (prev.seeded && prev.running && !runningNow && !key) {
        if (Date.now() - lastAttentionAt < 300) {
          /* answered by an attention alert moments ago */
        } else {
          fireDone(labelForSessionId(sid), sid);
        }
      }
      prev.running = runningNow;
      prev.seeded = true;
    }

    // Evaluate the whole sessionStatus snapshot (a Map<sessionId, status>).
    function evalStatus() {
      if (!statusStore) return;
      var snap = statusStore.getSnapshot();
      if (!snap || typeof snap.forEach !== "function") return;
      var seen = Object.create(null);
      snap.forEach(function (st, sid) {
        seen[sid] = true;
        try { evaluateStatusEntry(sid, st); } catch (e) {}
      });
      for (var sid in baseline) {
        if (seen[sid]) continue;
        // the session left the status map: its wait (if any) is over
        if (baseline[sid].pendingKey) unmarkAttention(baseline[sid].pendingKey);
        delete baseline[sid];
      }
    }

    // Fallback evaluation from list rows (compositions without uiSession):
    // running bits only, no pending interactions exist in the rows.
    function evaluateListRow(sid, row) {
      var runningNow = !!(row && row.running);
      var prev = baseline[sid];
      if (!prev) {
        baseline[sid] = { running: runningNow, pendingKey: null, seeded: true };
        return;
      }
      if (prev.seeded && prev.running && !runningNow) {
        if (Date.now() - lastAttentionAt < 300) {
          /* same-tick guard, mirrors evaluateStatusEntry */
        } else {
          fireDone(labelForSessionId(sid), sid);
        }
      }
      prev.running = runningNow;
      prev.seeded = true;
    }
    function onListChanged() {
      if (!listStore) return;
      try {
        var st = listStore.getSnapshot();
        var byId = (st && st.byId) || {};
        for (var sid in byId) {
          if (statusBound) continue; // sessionStatus owns edges; rows only label
          evaluateListRow(sid, byId[sid]);
        }
      } catch (e) {}
    }

    // ─────────────────────── subscription wiring ─────────────────────
    // The service is looked up lazily rather than declared in `inject`:
    // a cordis `inject` entry is a hard gate (the entry never activates while
    // the service is missing, and a never-activated entry makes the whole web
    // boot audit fail), while a composition without the UI session layer must
    // keep its done alerts working through the list-row path above.
    //
    // ⚠️ Reading `ctx.uiSession` directly does NOT work: cordis resolves a
    // service property only for names declared in the plugin's `inject` map
    // and throws `cannot get property "uiSession" without inject` for every
    // other name. ctx.get() reads the reflector store with no inject
    // requirement, which is the only lazy lookup that actually resolves the
    // service; ctx.reflect.get() and a plain property read stay as fallbacks
    // for contexts that predate that API.
    function lookupService(name) {
      var svc = null;
      try {
        if (rootCtx && typeof rootCtx.get === "function") svc = rootCtx.get(name) || null;
      } catch (e) { svc = null; }
      if (svc) return svc;
      try {
        if (rootCtx && rootCtx.reflect && typeof rootCtx.reflect.get === "function") svc = rootCtx.reflect.get(name) || null;
      } catch (e) { svc = null; }
      if (svc) return svc;
      try { if (rootCtx && name in rootCtx) svc = rootCtx[name] || null; } catch (e) { svc = null; }
      return svc;
    }
    // Did some entry on this host ever provide the service? Separates the
    // normal "composition without the UI layer" case (stay silent, the list
    // path still works there) from "provided but unreachable", which is a
    // real defect and deserves one console warning.
    function serviceWasProvided(name) {
      try {
        var props = rootCtx && rootCtx.reflect && rootCtx.reflect.props;
        return !!(props && props[name]);
      } catch (e) { return false; }
    }
    function noteStatusBind(note) {
      if (statusBindNote === note) return;
      statusBindNote = note;
      if (note === "bound" || statusWarned || !serviceWasProvided("uiSession")) return;
      statusWarned = true;
      try {
        console.warn("[dsh-notify] uiSession is provided but not reachable (" + note + ") — needs-input alerts are unavailable; reply-finished alerts fall back to the session-list path");
      } catch (e) {}
    }
    function bindStatus() {
      if (disposed) return;
      var svc = lookupService("uiSession");
      var store = svc && svc.sessionStatus;
      if (!store || typeof store.getSnapshot !== "function" || typeof store.subscribe !== "function") {
        noteStatusBind(svc ? "uiSession has no sessionStatus store" : "uiSession not visible");
        return;
      }
      if (statusSub && statusStore === store) { noteStatusBind("bound"); return; }
      // the service instance was swapped (plugin HMR): drop the stale
      // subscription and its marks, then bind the live store
      if (statusSub) detachStatus();
      statusStore = store;
      statusBound = true; // this source now owns the edges (and the title marker)
      statusSub = store.subscribe(function () { try { evalStatus(); } catch (e) {} });
      noteStatusBind("bound");
      evalStatus(); // seed: a wait that predates this plugin still alerts once
    }
    function detachStatus() {
      if (statusSub) { try { statusSub(); } catch (e) {} statusSub = null; }
      statusStore = null;
      // drop every mark and baseline this source holds; the list-row path
      // re-seeds its own baselines afterwards
      for (var sid in baseline) {
        if (baseline[sid].pendingKey) unmarkAttention(baseline[sid].pendingKey);
        delete baseline[sid];
      }
      statusBound = false;
    }

    // ──────────────────────── global control API ─────────────────────
    // Expose the control API. Merge instead of replace: a consumer (or a test
    // harness) may have registered onEvent before the plugin applied, and that
    // hook must survive — binding the status store can deliver an alert
    // synchronously, in the middle of apply().
    var api = window.__dshNotify;
    if (!api || typeof api !== "object") api = {};
    try {
      Object.defineProperty(api, "config", {
        get: function () { return readConfig(); },
        configurable: true
      });
    } catch (e) {}
    // keep in sync with package.json "version" on every release
    api.version = "0.1.0";
    api.setConfig = function (patch) { return setConfigLocal(patch); };
    api.resetConfig = function () {
      try { localStorage.removeItem(LS_CONFIG); } catch (e) {}
      config = readConfig();
      return config;
    };
    // manual test; run it after clicking anywhere so permission can be granted.
    // Test alerts fire regardless of the page-open visibility rules.
    api.test = function (kind) {
      kind = kind === "attention" ? "attention" : "done";
      unlockOnce();
      testAlert(kind);
      return "sent " + kind + " (lang=" + effectiveLang() + ", permission=" + ("Notification" in window ? Notification.permission : "n/a") + ")";
    };
    // Live diagnostics for the "why did nothing pop" case: which source is
    // bound, what baselines/marks/queues it holds, and the browser permission
    // state — all readable from the page itself.
    api.debug = function () {
      return {
        version: api.version,
        enabled: config.enabled,
        language: effectiveLang(),
        attentionHiddenOnly: config.attentionHiddenOnly,
        currentHiddenOnly: config.currentHiddenOnly,
        doneHiddenOnly: config.doneHiddenOnly,
        toast: config.toast,
        sound: config.sound,
        permission: ("Notification" in window) ? Notification.permission : "n/a",
        visibility: hidden() ? "hidden" : "visible",
        uiSession: statusBound ? "bound" : "unbound",
        uiSessionNote: statusBindNote,
        sessionBaselines: Object.keys(baseline).length,
        firedKeys: Object.keys(attentionKeysFired),
        markedKeys: Object.keys(attentionKeysMarked),
        quietedKeys: Object.keys(quietedAttention),
        lastAttentionAt: lastAttentionAt ? new Date(lastAttentionAt).toISOString() : null
      };
    };
    window.__dshNotify = api;

    // ────────────────── Settings page (react only, optional) ─────────
    // Registered when the web profile provides react + slots + locale; the
    // reminder core above never depends on any of it.
    var NS = "dsh-notify";
    var UI_zh = {
      nav: "通知提醒",
      blurb: "当模型停下来需要你操作（审批 / 方案待确认 / 提问），或回复完成时，用系统通知、提示音和标签页标题提醒你。",
      enable: "启用提醒",
      enableHint: "总开关：关闭后不再弹系统通知、不播放提示音，也不再改动标签页标题。",
      toast: "系统通知",
      toastHint: "经浏览器弹出系统 Toast（Windows 通知中心）；需要已授予通知权限。",
      sound: "提示音",
      soundHint: "WebAudio 合成音，「需要你」与「回复完成」使用不同音型。",
      attentionVisible: "页面打开时也提醒「需要你」",
      attentionVisibleHint: "默认开启：模型在等你审批 / 确认方案 / 回答问题（含提问弹窗）时，即使页面在最前也会提醒。",
      currentQuiet: "当前对话不弹通知",
      currentQuietHint: "默认开启：等待就发生在你正看着的这个对话里时，只留标签页标记，不弹系统通知、不响提示音，免得挡住审批卡片；页面切到后台后照常提醒。",
      doneVisible: "页面打开时也提醒「回复完成」",
      doneVisibleHint: "默认关闭：「完成」只在页面隐藏或切到后台时才提醒，避免打扰。",
      autoFocus: "点击通知回到对应对话",
      autoFocusHint: "默认开启：点系统通知会把 DSH 带到前台，并直接切到这条提醒所属的对话；关掉后点击通知不做任何事。",
      volume: "音量",
      language: "通知语言",
      langAuto: "跟随界面",
      langZh: "简体中文",
      langEn: "English",
      langAutoNote: "（跟随界面）",
      current: "界面当前语言",
      testTitle: "快速测试",
      testHint: "用当前设置各发一条测试提醒（不受上面「页面打开时也提醒」开关限制）。",
      testAttention: "测试「需要你」",
      testDone: "测试「回复完成」",
      reset: "恢复默认设置",
      resetDone: "已恢复默认设置。",
      sent: "已发送测试提醒 · 通知语言：",
      permHint: "通知权限尚未授予：先在页面上点击一次并允许通知，系统通知才能弹出（提示音不受影响）。",
      offHint: "已关闭提醒：先打开「启用提醒」再测试。"
    };
    var UI_en = {
      nav: "Notify me",
      blurb: "When the agent stops and needs your input (approval / plan review / question) or a reply finishes, get a system notification, a sound, and a tab-title marker.",
      enable: "Enable reminders",
      enableHint: "Master switch: when off, no toasts, no sounds, and the tab title is never modified.",
      toast: "System notifications",
      toastHint: "Native toasts via the browser (Windows notification center); requires notification permission.",
      sound: "Sound",
      soundHint: "WebAudio beeps — \"needs you\" and \"reply finished\" use different patterns.",
      attentionVisible: "Also alert \"needs you\" while the page is open",
      attentionVisibleHint: "On by default: alert even in the foreground when the model waits for approval / plan review / a question.",
      currentQuiet: "Stay quiet for the conversation on screen",
      currentQuietHint: "On by default: a wait inside the conversation you are looking at keeps only the tab marker — no toast or sound landing on the approval card. Backgrounding the page puts the alert back.",
      doneVisible: "Also alert \"reply finished\" while the page is open",
      doneVisibleHint: "Off by default: \"done\" only alerts while the page is hidden or backgrounded, to avoid noise.",
      autoFocus: "Click a toast to open that conversation",
      autoFocusHint: "On by default: clicking a toast brings DSH forward and switches to the conversation the alert came from. When off, clicking a toast does nothing.",
      volume: "Volume",
      language: "Notification language",
      langAuto: "Follow the interface",
      langZh: "简体中文",
      langEn: "English",
      langAutoNote: " (follows the interface)",
      current: "Current interface language",
      testTitle: "Quick test",
      testHint: "Send one test alert with the current settings (not limited by the \"while the page is open\" toggles above).",
      testAttention: "Test \"needs you\"",
      testDone: "Test \"reply finished\"",
      reset: "Restore defaults",
      resetDone: "Defaults restored.",
      sent: "Test alert sent · notification language: ",
      permHint: "Notification permission is not granted yet — click once on the page and allow notifications so toasts can appear (sound is unaffected).",
      offHint: "Reminders are off: enable them first, then test."
    };
    // Small element helper to keep the hand-written page readable.
    function h(tag, props) {
      var args = [tag, props || null];
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
      return React.createElement.apply(React, args);
    }
    // css classes (namespaced to avoid collisions)
    var UI_CSS = "" +
      ".dn-wrap{width:100%;max-width:720px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,rgba(20,20,20,.9))}" +
      ".dn-blurb{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9))}" +
      ".dn-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.05));border-radius:10px;overflow:hidden}" +
      ".dn-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 14px;min-height:46px;box-sizing:border-box}" +
      ".dn-row+.dn-row{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}" +
      ".dn-rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}" +
      ".dn-rowLabel{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,rgba(20,20,20,.9))}" +
      ".dn-rowHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9))}" +
      ".dn-switch{flex:none;position:relative;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.2));cursor:pointer;padding:0;transition:background .15s ease}" +
      ".dn-switch.on{background:var(--dsh-alias-state-business-primary,#3b82f6);border-color:transparent}" +
      ".dn-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s ease}" +
      ".dn-switch.on .dn-knob{left:16px}" +
      ".dn-range{width:150px;accent-color:var(--dsh-alias-state-business-primary,#3b82f6)}" +
      ".dn-select{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));color:var(--dsw-alias-label-primary,rgba(20,20,20,.9));border-radius:8px;padding:5px 8px;font-size:13px;font-family:inherit}" +
      ".dn-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:transparent;color:var(--dsw-alias-label-primary,rgba(20,20,20,.9));border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;font-family:inherit}" +
      ".dn-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1))}" +
      ".dn-btn[disabled]{opacity:.45;cursor:default}" +
      ".dn-btnRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
      ".dn-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9))}" +
      ".dn-feedback{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9));min-height:18px}";
    (function injectStyle() {
      try {
        if (typeof document === "undefined" || typeof document.createElement !== "function") return;
        var tagId = "dsh-notify/settings";
        if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
        var s = document.createElement("style");
        s.dataset.plugin = "dsh-notify";
        s.dataset.pluginCss = tagId;
        s.textContent = UI_CSS;
        (document.head || document.documentElement).appendChild(s);
      } catch (e) {}
    })();

    function rowSwitch(labelText, hintText, checked, onChange) {
      return h("div", { className: "dn-row" }, [
        h("div", { className: "dn-rowText" }, [
          h("div", { className: "dn-rowLabel" }, labelText),
          hintText ? h("div", { className: "dn-rowHint" }, hintText) : null
        ]),
        h("button", {
          type: "button",
          role: "switch",
          "aria-checked": checked ? "true" : "false",
          className: "dn-switch" + (checked ? " on" : ""),
          onClick: function () { onChange(!checked); }
        }, h("span", { className: "dn-knob" }))
      ]);
    }
    function card(children) {
      return h("div", { className: "dn-card" }, children);
    }

    function NotifySettingsView(props) {
      var ctx = props.ctx;
      var t = props.t;
      // Keep the page copy in sync with the active DSH UI language.
      if (React.useSyncExternalStore) {
        React.useSyncExternalStore(
          function (cb) { return ctx.locale.subscribe(cb); },
          function () { return ctx.locale.getSnapshot(); }
        );
      } else {
        var tickState = React.useState(0);
        React.useEffect(function () {
          return ctx.locale.subscribe(function () { tickState[1](tickState[0] + 1); });
        }, []);
      }
      var cfgState = React.useState(function () { return readConfig(); });
      var cfg = cfgState[0];
      var setCfg = cfgState[1];
      var feedbackState = React.useState("");
      var feedback = feedbackState[0];
      var setFeedback = feedbackState[1];
      function patch(p) {
        setCfg(setConfigLocal(p));
      }
      function runTest(kind) {
        if (!config.enabled) { setFeedback(t("offHint")); return; }
        unlockOnce();
        // Bypasses the visibility rules on purpose: a test must fire while the
        // page is open, otherwise the button proves nothing.
        testAlert(kind);
        var langName = effectiveLang() === "en" ? t("langEn") : t("langZh");
        setFeedback(t("sent") + langName);
      }
      var permOK = ("Notification" in window) ? Notification.permission === "granted" : false;
      var resolvedLang = effectiveLang();
      var resolvedLangName = resolvedLang === "en" ? t("langEn") : t("langZh");
      return h("div", { className: "dn-wrap" }, [
        h("p", { className: "dn-blurb" }, t("blurb")),
        card([
          rowSwitch(t("enable"), t("enableHint"), cfg.enabled, function (v) {
            patch({ enabled: v });
            if (!v && attentionActive > 0) { attentionActive = 0; applyTitle(); }
          })
        ]),
        card([
          rowSwitch(t("toast"), t("toastHint"), cfg.toast, function (v) { patch({ toast: v }); }),
          rowSwitch(t("sound"), t("soundHint"), cfg.sound, function (v) { patch({ sound: v }); }),
          rowSwitch(t("attentionVisible"), t("attentionVisibleHint"), !cfg.attentionHiddenOnly, function (v) { patch({ attentionHiddenOnly: !v }); }),
          rowSwitch(t("currentQuiet"), t("currentQuietHint"), cfg.currentHiddenOnly, function (v) { patch({ currentHiddenOnly: v }); }),
          rowSwitch(t("doneVisible"), t("doneVisibleHint"), !cfg.doneHiddenOnly, function (v) { patch({ doneHiddenOnly: !v }); }),
          rowSwitch(t("autoFocus"), t("autoFocusHint"), cfg.autoFocus, function (v) { patch({ autoFocus: v }); }),
          h("div", { className: "dn-row" }, [
            h("div", { className: "dn-rowText" }, [
              h("div", { className: "dn-rowLabel" }, t("volume")),
              h("div", { className: "dn-rowHint" }, String(Math.round(cfg.volume * 100)) + "%")
            ]),
            h("input", {
              type: "range",
              className: "dn-range",
              min: 0, max: 100, step: 5,
              value: Math.round(cfg.volume * 100),
              "aria-label": t("volume"),
              onChange: function (e) { patch({ volume: Number(e.currentTarget.value) / 100 }); }
            })
          ])
        ]),
        card([
          h("div", { className: "dn-row" }, [
            h("div", { className: "dn-rowText" }, [
              h("div", { className: "dn-rowLabel" }, t("language")),
              h("div", { className: "dn-rowHint" }, resolvedLangName + (cfg.language === "auto" ? t("langAutoNote") : ""))
            ]),
            h("select", {
              className: "dn-select",
              value: cfg.language,
              "aria-label": t("language"),
              onChange: function (e) { patch({ language: e.currentTarget.value }); }
            }, [
              h("option", { value: "auto" }, t("langAuto")),
              h("option", { value: "zh" }, t("langZh")),
              h("option", { value: "en" }, t("langEn"))
            ])
          ]),
          h("div", { className: "dn-row" }, [
            h("div", { className: "dn-rowText" }, [
              h("div", { className: "dn-rowLabel" }, t("testTitle")),
              h("div", { className: "dn-rowHint" }, t("testHint"))
            ]),
            h("div", { className: "dn-btnRow" }, [
              h("button", { type: "button", className: "dn-btn", disabled: !cfg.enabled, onClick: function () { runTest("attention"); } }, t("testAttention")),
              h("button", { type: "button", className: "dn-btn", disabled: !cfg.enabled, onClick: function () { runTest("done"); } }, t("testDone"))
            ])
          ]),
          h("div", { className: "dn-row" }, [
            h("div", { className: "dn-rowText" }, [
              h("div", { className: "dn-rowLabel" }, t("reset")),
              h("div", { className: "dn-rowHint" }, " ")
            ]),
            h("button", { type: "button", className: "dn-btn", onClick: function () {
              try { localStorage.removeItem(LS_CONFIG); } catch (e) {}
              config = readConfig();
              applyTitle();
              setCfg(config);
              setFeedback(t("resetDone"));
            } }, t("reset"))
          ]),
          !permOK ? h("div", { className: "dn-row" }, [
            h("div", { className: "dn-rowText" }, [h("div", { className: "dn-rowHint" }, t("permHint"))])
          ]) : null
        ]),
        h("p", { className: "dn-feedback" }, feedback)
      ]);
    }

    // ────────────────────────── plugin body ──────────────────────────
    // Hard service requirements only — every one of these is provided by the
    // stock web composition. `uiSession` and `uiWorkspace` are deliberately
    // NOT listed: a cordis inject entry is a hard gate (the entry stays
    // pending while the service is missing, and the web boot audit fails on
    // entries that never activate). They are looked up lazily in bindStatus()
    // / focusSession(), with the list-row path as the fallback.
    var inject = ["sessions", "locale", "slots"];

    /**
     * Client plugin body: watch the session status and raise desktop
     * notifications + sounds when the agent needs input or a reply finishes;
     * also contributes a Settings page (settings.section slot).
     * @param ctx - client root context.
     */
    function apply(ctx) {
      rootCtx = ctx;
      disposed = false;
      try {
        if (ctx.locale && typeof ctx.locale.getLocale === "function") localeSvc = ctx.locale;
      } catch (e) {}
      // Settings UI — only when the full web profile (react + slots + locale)
      // is present. The reminder core above never depends on this.
      try {
        if (React && React.createElement && ctx.slots && ctx.locale && typeof ctx.locale.register === "function" && typeof ctx.slots.inject === "function") {
          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: UI_zh, en: UI_en });
          }, "dsh-notify: settings dictionaries");
          var t = ctx.locale.bind(NS);
          ctx.slots.inject("settings.section", function () {
            return ctx.slots.register({
              name: "settings.section",
              id: "dsh-notify",
              order: 45,
              label: function () { return t("nav"); },
              locale: NS,
              inject: function () { return { t: t }; }
            }, function () {
              return React.createElement(NotifySettingsView, { ctx: ctx, t: t });
            });
          });
        }
      } catch (e) {
        try { console.error("[dsh-notify] settings page unavailable", e); } catch (e2) {}
      }
      ctx.effect(function () {
        var unsubs = [];
        var retryTimer = null;
        try {
          var sessionsSvc = ctx.sessions;
          if (!sessionsSvc || !sessionsSvc.list || typeof sessionsSvc.list.subscribe !== "function") {
            try { console.log("[dsh-notify] sessions service unavailable — watchers idle"); } catch (e) {}
            return;
          }
          listStore = sessionsSvc.list;
          unsubs.push(sessionsSvc.list.subscribe(function () { try { onListChanged(); } catch (e) {} }));
          // A wait kept quiet because it was already on screen still has to
          // reach the user the moment they leave the page.
          var onVisibility = function () { try { flushQuieted(); } catch (e) {} };
          try { document.addEventListener("visibilitychange", onVisibility); } catch (e) {}
          unsubs.push(function () { try { document.removeEventListener("visibilitychange", onVisibility); } catch (e) {} });
          // The status source owns the edges once present, so binding it
          // before the first list scan keeps a single edge owner.
          bindStatus();
          // initial scan (seeds baselines; no alerts for pre-existing rows)
          onListChanged();
          // the service may resolve a tick later (or be swapped by HMR);
          // re-check periodically while idle
          retryTimer = setInterval(function () {
            if (disposed) return;
            try { bindStatus(); } catch (e) {}
          }, 1500);
          try { console.log("[dsh-notify] active — window.__dshNotify 可配置提醒 (enabled=" + config.enabled + ", lang=" + effectiveLang() + ", toast=" + config.toast + ", sound=" + config.sound + ")"); } catch (e) {}
        } catch (e) {
          try { console.error("[dsh-notify] init failed", e); } catch (e2) {}
        }
        return function () {
          disposed = true;
          if (retryTimer) clearInterval(retryTimer);
          for (var i = 0; i < unsubs.length; i++) { try { unsubs[i](); } catch (e) {} }
          detachStatus();
          baseline = Object.create(null);
          listStore = null;
        };
      }, "dsh-notify: watchers");
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
