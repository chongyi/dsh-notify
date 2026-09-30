// Offline smoke test for dsh-notify/lib/client.js
// Runs the plugin bundle inside a mocked browser-ish environment and drives a
// fake DSH 0.2 host, asserting the alert machinery fires without throwing and
// produces the expected title/onEvent changes.
//
// Two hosts are exercised:
//   * full   — DSH 0.2 web composition: ctx.uiSession.sessionStatus publishes
//              Map<sessionId, {running, pendingInteraction, completionUnread}>
//              plus ctx.sessions.list rows for titles / main-view retention;
//   * bare   — a composition without uiSession (no UI layer): only the list
//              rows' running bits exist, so reply-finished alerts must still
//              work through the fallback path (no needs-input source exists).
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

// Boot the bundle over a mocked window/document and return the handles the
// tests drive: the module exports, the exposed window API, and the stubs.
function bootBundle(opts) {
  let title = 'DeepSeek Harness';
  const listeners = { pointerdown: [], keydown: [] };
  const captured = {};
  // A granted-permission Notification stand-in so a test can grab the toast the
  // plugin raised and click it the way the OS would.
  let lastNotification = null;
  class FakeNotification {
    constructor(t, config) { this.title = t; this.config = config; this.closed = false; lastNotification = this; }
    close() { this.closed = true; }
  }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = () => Promise.resolve('granted');
  const Notify = (opts && opts.withNotification) ? FakeNotification : undefined;

  const windowStub = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = listeners[type] || [];
      const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1);
    },
    focus() {},
    __ModuleLoader__: { load(reg) { captured.reg = reg; } },
    __dshNotify: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined,
  };
  // Only present when the test asked for it: an own `Notification` key holding
  // undefined would make `"Notification" in window` true while the global stays
  // undefined — exactly the shape that used to break canToast().
  if (Notify) windowStub.Notification = Notify;
  const docListeners = { visibilitychange: [] };
  const documentStub = {
    hidden: false,
    visibilityState: 'visible',
    get title() { return title; },
    set title(v) { title = v; },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = docListeners[type] || [];
      const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1);
    },
  };
  const storage = {};
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: { origin: 'http://127.0.0.1:3080' },
    Notification: Notify,
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Symbol, Object, JSON, Date, Math, Array, String, Number, Map,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'client.js' });
  if (!captured.reg) throw new Error('plugin did not register via __ModuleLoader__.load');
  if (captured.reg.id !== 'dsh-notify') throw new Error('unexpected id ' + captured.reg.id);

  // The alert sink is installed before apply() on purpose: binding the status
  // store can alert synchronously for a wait that already exists.
  const events = [];
  windowStub.__dshNotify = { onEvent: (kind, payload) => events.push({ kind, ...payload }) };

  return {
    mod: captured.reg.factory(() => ({})),
    win: windowStub,
    doc: documentStub,
    events,
    getTitle: () => title,
    lastNotification: () => lastNotification,
    // Drive a real visibilitychange the way the browser would.
    fireVisibility: () => { for (const fn of [...docListeners.visibilitychange]) fn(); },
  };
}

// The 0.2 host: sessions.list rows plus (optionally) uiSession.sessionStatus.
// Both are built from plain objects so the test can move the host state one
// notification at a time.
function buildHost({ withUiSession }) {
  const listeners = { list: [], status: [] };
  let listState = { ids: [], byId: {}, phase: 'ready' };
  let statusSnapshot = new Map();
  const cleanups = [];
  const opened = []; // sessions the plugin asked the host to open

  const sessionsFake = {
    list: {
      getSnapshot: () => listState,
      subscribe: (fn) => { listeners.list.push(fn); return () => { listeners.list = listeners.list.filter((f) => f !== fn); }; },
    },
  };
  const uiWorkspaceFake = {
    openSession: (id) => { opened.push(id); },
  };

  const ctx = {
    sessions: sessionsFake,
    uiWorkspace: uiWorkspaceFake,
    get: (name) => (name in ctx ? ctx[name] : undefined),
    effect: (fn) => { const r = fn(); if (typeof r === 'function') cleanups.push(r); },
  };
  if (withUiSession) {
    ctx.uiSession = {
      sessionStatus: {
        getSnapshot: () => statusSnapshot,
        subscribe: (fn) => { listeners.status.push(fn); return () => { listeners.status = listeners.status.filter((f) => f !== fn); }; },
      },
    };
  }

  return {
    ctx,
    listeners,
    cleanups,
    opened,
    setList: (v) => { listState = v; },
    setStatus: (map) => { statusSnapshot = map; },
    notifyList: () => { for (const l of [...listeners.list]) l(); },
    notifyStatus: () => { for (const l of [...listeners.status]) l(); },
  };
}

// Interaction objects shaped like the shipped 0.2 domain classes.
function approval(key, extra) {
  return Object.assign({ key, kind: 'approval', sessionId: 's1', toolName: 'pwsh', reason: 'needs elevated shell' }, extra || {});
}
function question(key, extra) {
  return Object.assign({ key, kind: 'question', sessionId: 's1', questions: [{ id: 'q1', question: '继续吗？', options: [] }] }, extra || {});
}
function planReview(key, extra) {
  return Object.assign({ key, kind: 'plan-review', sessionId: 's1', questions: [{ id: 'q1', question: '执行这个方案？', detail: '第一步…', intent: { kind: 'plan-review' } }] }, extra || {});
}
// A status entry the way uiSession publishes it.
function status(running, pendingInteraction) {
  return { running, pendingInteraction, completionUnread: false };
}
// A list row the way sessions.list publishes it.
function row(displayTitle, running, mainView) {
  return { id: undefined, displayTitle, running, retainedBy: { mainView: mainView ? 1 : 0 }, blank: false, updatedAt: 0 };
}

async function fullHost() {
  console.log('\n— full host (0.2: uiSession.sessionStatus + sessions.list) —');
  const b = bootBundle();
  const host = buildHost({ withUiSession: true });
  host.setList({ ids: ['s1'], byId: { s1: row('当前会话', false, true) }, phase: 'ready' });
  host.setStatus(new Map([['s1', status(false, undefined)]]));
  const { mod, win, doc, events, getTitle } = b;

  assert(Array.isArray(mod.inject) && typeof mod.apply === 'function', 'export shape');
  assert(mod.inject.indexOf('uiSession') === -1 && mod.inject.indexOf('uiWorkspace') === -1,
    'uiSession/uiWorkspace must NOT be hard inject entries (a missing service would leave the entry pending and fail the web boot audit)');
  assert(mod.inject.indexOf('sessions') !== -1 && mod.inject.indexOf('locale') !== -1 && mod.inject.indexOf('slots') !== -1,
    'sessions/locale/slots are the hard requirements');
  console.log('export shape OK: inject=', JSON.stringify(mod.inject));

  mod.apply(host.ctx);
  assert(typeof win.__dshNotify === 'object', 'global api exposed');
  win.__dshNotify.onEvent = (kind, payload) => events.push({ kind, ...payload });
  assert(win.__dshNotify.version === PKG_VERSION,
    'window.__dshNotify.version (' + win.__dshNotify.version + ') != package.json version (' + PKG_VERSION + ')');
  console.log('version OK:', PKG_VERSION);
  assert(host.listeners.status.length === 1 && host.listeners.list.length === 1, 'status + list subscribed');
  assert(win.__dshNotify.debug().uiSession === 'bound', 'debug() reports the status source bound');

  // 1) an approval appears -> attention, once, with the tool detail + session title
  doc.hidden = true; doc.visibilityState = 'hidden';
  host.setStatus(new Map([['s1', status(true, approval('approval:1'))]]));
  host.notifyStatus();
  let att = events.filter((e) => e.kind === 'attention');
  assert(att.length === 1, 'attention fired for a new approval');
  assert(att[0].title === 'DSH · 审批请求', 'approval kind mapped to zh copy, got ' + att[0].title);
  assert(att[0].body.indexOf('pwsh') !== -1 && att[0].body.indexOf('needs elevated shell') !== -1,
    'approval body carries toolName + reason, got ' + att[0].body);
  assert(att[0].body.indexOf('当前会话') !== -1, 'body carries the session title, got ' + att[0].body);
  assert(att[0].sessionId === 's1', 'onEvent payload carries sessionId');
  assert(getTitle().indexOf('需要你') !== -1, 'title marker set on approval');

  // 2) repeated notifications for the same interaction do not re-alert
  events.length = 0;
  host.notifyStatus();
  host.notifyStatus();
  assert(events.length === 0, 'no duplicate alert for the same interaction key');
  assert(getTitle().indexOf('需要你') !== -1, 'marker stays while the wait is open');

  // 3) the wait is answered -> marker released
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  assert(getTitle().indexOf('需要你') === -1, 'title marker cleared when the interaction disappears');

  // 4) question + plan-review map to their own copy; the batch text is used
  host.setStatus(new Map([['s1', status(true, question('question:7'))]]));
  host.notifyStatus();
  att = events.filter((e) => e.kind === 'attention');
  assert(att.length === 1 && att[0].title === 'DSH · 提问', 'question kind copy');
  assert(att[0].body.indexOf('继续吗？') !== -1, 'question body carries the question text, got ' + att[0].body);
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, planReview('question:8'))]]));
  host.notifyStatus();
  att = events.filter((e) => e.kind === 'attention');
  assert(att.length === 1 && att[0].title === 'DSH · 方案待确认', 'plan-review kind copy');
  assert(getTitle().indexOf('需要你') !== -1, 'marker set for plan review');

  // 5) a wait in a background session is labelled with its sidebar title and
  //    alerts while the page is visible (attentionHiddenOnly default off)
  doc.hidden = false; doc.visibilityState = 'visible';
  events.length = 0;
  host.setList({ ids: ['s1', 's2'], byId: { s1: row('当前会话', true, true), s2: row('后台任务', true, false) }, phase: 'ready' });
  host.setStatus(new Map([
    ['s1', status(true, planReview('question:8'))],
    ['s2', status(true, question('question:9', { sessionId: 's2' }))],
  ]));
  host.notifyStatus();
  att = events.filter((e) => e.kind === 'attention');
  assert(att.length === 1, 'the background wait alerts (existing key does not re-alert)');
  assert(att[0].body.indexOf('后台任务') !== -1, 'background wait carries the session title, got ' + att[0].body);

  // 6) several waits in different sessions: one mark each, released per wait
  doc.hidden = true; doc.visibilityState = 'hidden';
  events.length = 0;
  host.setStatus(new Map([
    ['s1', status(true, question('question:10'))],
    ['s2', status(true, approval('approval:11', { sessionId: 's2' }))],
  ]));
  host.notifyStatus();
  assert(events.filter((e) => e.kind === 'attention').length === 2, 'two concurrent waits alert once each');
  events.length = 0;
  host.setStatus(new Map([
    ['s1', status(true, question('question:10'))],
    ['s2', status(true, undefined)],
  ]));
  host.notifyStatus();
  assert(events.length === 0, 'a surviving wait does not re-alert');
  assert(getTitle().indexOf('需要你') !== -1, 'marker survives while one wait remains');
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  assert(getTitle().indexOf('需要你') === -1, 'all waits gone -> marker cleared');

  // 7) a wait replaced by a newer one in the same session: one mark, swapped
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, approval('approval:20'))]]));
  host.notifyStatus();
  assert(events.length === 1, 'first of the replaced pair alerted');
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, question('question:21'))]]));
  host.notifyStatus();
  att = events.filter((e) => e.kind === 'attention');
  assert(att.length === 1 && att[0].title === 'DSH · 提问', 'replacement wait alerts');
  assert((getTitle().match(/需要你/g) || []).length === 1, 'exactly one marker after replacement, got ' + getTitle());
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  assert(getTitle().indexOf('需要你') === -1, 'replacement released its mark when answered');

  // 8) a wait that already existed before the plugin attached still alerts once
  //    (fresh boot: the interaction is registered before the plugin applies)
  const late = bootBundle();
  const lateHost = buildHost({ withUiSession: true });
  lateHost.setList({ ids: ['s1'], byId: { s1: row('当前会话', true, true) }, phase: 'ready' });
  lateHost.setStatus(new Map([['s1', status(true, approval('approval:30'))]]));
  late.doc.hidden = true; late.doc.visibilityState = 'hidden';
  late.mod.apply(lateHost.ctx); // alerts synchronously for the pre-existing wait
  const seeded = late.events.filter((e) => e.kind === 'attention');
  assert(seeded.length === 1, 'pre-existing wait alerts once on bind, got ' + seeded.length);
  assert(late.getTitle().indexOf('需要你') !== -1, 'pre-existing wait marks the tab');
  late.events.length = 0;
  lateHost.setStatus(new Map([['s1', status(true, undefined)]]));
  lateHost.notifyStatus();
  assert(late.getTitle().indexOf('需要你') === -1, 'pre-existing wait releases its mark');
  for (const c of [...lateHost.cleanups]) c();

  // 9) running true -> false while hidden fires "done"; list rows do not
  //    double-fire while the status source owns the edges
  await sleep(400);
  doc.hidden = true; doc.visibilityState = 'hidden';
  host.setList({ ids: ['s1'], byId: { s1: row('当前会话', true, true) }, phase: 'ready' });
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  host.notifyList();
  events.length = 0;
  host.setList({ ids: ['s1'], byId: { s1: row('当前会话', false, true) }, phase: 'ready' });
  host.setStatus(new Map([['s1', status(false, undefined)]]));
  host.notifyList(); // row flips first — must be ignored while status is bound
  host.notifyStatus();
  const done = events.filter((e) => e.kind === 'done');
  assert(done.length === 1, 'done fired exactly once for running->idle (list row did not double it), got ' + done.length);
  assert(done[0].body.indexOf('当前会话') !== -1, 'done carries the session title');
  assert(getTitle().indexOf('需要你') === -1, 'no attention marker for done');

  // 10) doneHiddenOnly default suppresses "done" while the page is visible
  events.length = 0;
  doc.hidden = false; doc.visibilityState = 'visible';
  await sleep(400);
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  host.setStatus(new Map([['s1', status(false, undefined)]]));
  host.notifyStatus();
  assert(events.length === 0, 'done suppressed while page visible (doneHiddenOnly default)');

  // 11) config round trip; visible "done" once doneHiddenOnly=false
  const cfg = win.__dshNotify.setConfig({ doneHiddenOnly: false, sound: false });
  assert(cfg.doneHiddenOnly === false, 'setConfig persisted');
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  host.setStatus(new Map([['s1', status(false, undefined)]]));
  host.notifyStatus();
  assert(events.filter((e) => e.kind === 'done').length === 1, 'done fires when doneHiddenOnly=false even visible');

  // 12) defaults + reset
  const d = win.__dshNotify.config;
  assert(d.enabled === true && d.language === 'auto', 'default enabled/language');
  const back = win.__dshNotify.setConfig({ enabled: false, language: 'en' });
  assert(back.enabled === false && back.language === 'en', 'enabled/language settable via setConfig');
  const restored = win.__dshNotify.resetConfig();
  assert(restored.enabled === true && restored.language === 'auto', 'resetConfig restores defaults');

  // 13) English pinned copy + marker
  win.__dshNotify.setConfig({ language: 'en', doneHiddenOnly: true, sound: false });
  doc.hidden = true; doc.visibilityState = 'hidden';
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, question('question:en1'))]]));
  host.notifyStatus();
  att = events.filter((e) => e.kind === 'attention');
  assert(att.length === 1, 'attention fired with language=en');
  assert(att[0].title === 'DSH · Question', 'en attention title');
  assert(att[0].body.indexOf('Current') === -1, 'en body uses the session title');
  assert(getTitle().indexOf('Action needed') !== -1 && getTitle().indexOf('需要你') === -1, 'en title marker');
  events.length = 0;
  await sleep(400);
  host.setStatus(new Map([['s1', status(false, undefined)]]));
  host.notifyStatus();
  assert(getTitle().indexOf('Action needed') === -1, 'en marker cleared');
  const dn = events.filter((e) => e.kind === 'done');
  assert(dn.length === 1 && dn[0].title === 'DSH · Reply finished', 'en done title');
  doc.hidden = false; doc.visibilityState = 'visible';

  // 14) master switch off silences everything and drops no crumbs
  win.__dshNotify.setConfig({ enabled: false, language: 'zh' });
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, approval('approval:off1'))]]));
  host.notifyStatus();
  assert(events.length === 0, 'no alert while master switch is off');
  assert(getTitle().indexOf('需要你') === -1, 'no marker while master switch is off');
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  const armed = win.__dshNotify.setConfig({ enabled: true, doneHiddenOnly: true, sound: false });
  assert(armed.enabled === true, 'master switch can be re-enabled');

  // 15) test buttons ignore the visibility rules
  doc.hidden = false; doc.visibilityState = 'visible';
  events.length = 0;
  const doneStatus = win.__dshNotify.test('done');
  assert(events.filter((e) => e.kind === 'done').length === 1, 'test "done" fires while page visible');
  assert(getTitle().indexOf('需要你') === -1, 'done test leaves no attention marker');
  assert(typeof doneStatus === 'string' && doneStatus.indexOf('sent done') === 0, 'test returns a status string');
  events.length = 0;
  win.__dshNotify.test('attention');
  assert(events.filter((e) => e.kind === 'attention').length === 1, 'test "attention" fires while page visible');
  assert(getTitle().indexOf('需要你') !== -1, 'attention test sets the marker');

  // 16) a wait in the conversation on screen stays silent while it is on
  //     screen, and still reaches the user once the page is backgrounded
  doc.hidden = false; doc.visibilityState = 'visible';
  win.__dshNotify.setConfig({ currentHiddenOnly: true, sound: false, language: 'zh', enabled: true, doneHiddenOnly: true });
  host.setList({ ids: ['s1'], byId: { s1: row('当前会话', true, true) }, phase: 'ready' });
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, approval('approval:40'))]]));
  host.notifyStatus();
  assert(events.length === 0, 'a wait in the conversation on screen stays silent');
  assert(getTitle().indexOf('需要你') !== -1, 'the silent wait still marks the tab');
  assert(win.__dshNotify.debug().quietedKeys.indexOf('approval:40') !== -1,
    'the silent wait is queued for the background');
  doc.hidden = true; doc.visibilityState = 'hidden';
  b.fireVisibility();
  const flushed = events.filter((e) => e.kind === 'attention');
  assert(flushed.length === 1 && flushed[0].title === 'DSH · 审批请求',
    'the queued wait is delivered once the page is backgrounded, got ' + JSON.stringify(flushed));

  // 17) a wait answered while still on screen is never delivered later
  doc.hidden = false; doc.visibilityState = 'visible';
  events.length = 0;
  host.setStatus(new Map([['s1', status(true, approval('approval:42'))]]));
  host.notifyStatus();
  assert(events.length === 0, 'an on-screen wait is silent again');
  host.setStatus(new Map([['s1', status(true, undefined)]]));
  host.notifyStatus();
  doc.hidden = true; doc.visibilityState = 'hidden';
  b.fireVisibility();
  assert(events.length === 0, 'a wait answered on screen is not delivered later');

  // 18) clicking a toast opens the conversation the alert belongs to
  const nb = bootBundle({ withNotification: true });
  const nhost = buildHost({ withUiSession: true });
  nhost.setList({ ids: ['s1', 's2'], byId: { s1: row('当前会话', false, true), s2: row('后台任务', true, false) }, phase: 'ready' });
  nhost.setStatus(new Map([['s1', status(false, undefined)], ['s2', status(true, undefined)]]));
  nb.doc.hidden = true; nb.doc.visibilityState = 'hidden';
  nb.mod.apply(nhost.ctx);
  nhost.setStatus(new Map([['s1', status(false, undefined)], ['s2', status(true, approval('approval:50', { sessionId: 's2' }))]]));
  nhost.notifyStatus();
  const toast = nb.lastNotification();
  assert(toast && toast.title === 'DSH · 审批请求', 'a toast was raised for the background wait');
  toast.onclick();
  assert(nhost.opened.length === 1 && nhost.opened[0] === 's2',
    'clicking the toast opens the alerted session, got ' + JSON.stringify(nhost.opened));

  // a session that already left the list must never be opened
  nhost.setList({ ids: [], byId: {}, phase: 'ready' });
  nhost.setStatus(new Map([['s9', status(false, approval('approval:51', { sessionId: 's9' }))]]));
  nhost.notifyStatus();
  const goneToast = nb.lastNotification();
  assert(goneToast !== toast, 'a second toast was raised for the vanished session');
  goneToast.onclick();
  assert(nhost.opened.length === 1, 'a session missing from the list is never opened');
  for (const c of [...nhost.cleanups]) c();

  // cleanup must unsubscribe; wait marks are already released by their own
  // cases above (the test button's marker self-releases on a 6s timer)
  for (const c of [...host.cleanups]) c();
  assert(host.listeners.status.length === 0, 'status unsubscribed after dispose');
  assert(host.listeners.list.length === 0, 'list unsubscribed after dispose');
}

async function bareHost() {
  console.log('\n— bare host (no uiSession: list rows drive done alerts) —');
  const b = bootBundle();
  const host = buildHost({ withUiSession: false });
  const { mod, win, doc, events, getTitle } = b;
  host.setList({ ids: ['bg1'], byId: { bg1: row('后台任务', true, false) }, phase: 'ready' });

  mod.apply(host.ctx);
  win.__dshNotify.onEvent = (kind, payload) => events.push({ kind, ...payload });
  assert(host.listeners.list.length === 1, 'list subscribed');
  assert(win.__dshNotify.debug().uiSession === 'unbound', 'debug() reports the status source unbound');
  doc.hidden = true; doc.visibilityState = 'hidden';

  // 1) running -> idle through the row itself fires "done"
  host.setList({ ids: ['bg1'], byId: { bg1: row('后台任务', false, false) }, phase: 'ready' });
  host.notifyList();
  const done = events.filter((e) => e.kind === 'done');
  assert(done.length === 1 && done[0].body.indexOf('后台任务') !== -1,
    'bare host still alerts reply-finished from list rows, got ' + JSON.stringify(done));

  // 2) doneHiddenOnly default suppresses it while visible
  events.length = 0;
  doc.hidden = false; doc.visibilityState = 'visible';
  host.setList({ ids: ['bg1'], byId: { bg1: row('后台任务', true, false) }, phase: 'ready' });
  host.notifyList();
  host.setList({ ids: ['bg1'], byId: { bg1: row('后台任务', false, false) }, phase: 'ready' });
  host.notifyList();
  assert(events.length === 0, 'bare host respects doneHiddenOnly');

  // cleanup
  for (const c of [...host.cleanups]) c();
  assert(host.listeners.list.length === 0, 'list unsubscribed after dispose');
}

(async () => {
  await fullHost();
  await bareHost();
  console.log('\nALL SMOKE TESTS PASSED ✔');
  // Exit explicitly: marker-release timers stay armed on purpose (they mirror
  // browser behaviour) and would otherwise hold the loop open.
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
