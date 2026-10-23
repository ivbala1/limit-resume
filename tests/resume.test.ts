import { expect, mock, test } from 'claude-code/testing';
import { settings } from '../hooks/config.js';
const RU = { options: { language: 'ru', timeZone: 'Asia/Dubai', reserveFor: 'ассистента', economyHint: 'Разведку можно отдать другому агенту.' } };
const CFG = settings(RU.options);
import { clockTime, exhaustedReset, isLimitError, textReset, resumeText } from '../hooks/logic.js';

const NOW = Date.parse('2026-10-13T22:20:00Z');
const RESET = NOW + 120_000;
const ERROR = "You're out of usage credits · resets 2:22am (Asia/Dubai)";
const START = { cwd: '/work', surface: 'desktop', isInteractive: true } as const;

function fixture(on, initial = {}) {
  const clock = mock.clock(on, { now: NOW });
  const saved = new Map(Object.entries({ 'session:test-session': { enabled: true, pending: null, attempts: 0 }, ...initial }));
  const sent: string[] = [];
  const logs: string[] = [];
  const state = { draft: '', limits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(RESET).toISOString() }] };
  on('session.id', () => ({ value: 'test-session' }));
  on('session.surfaces', () => ({ value: [] }));
  on('session.attach', ($, e) => ({ clientId: e.clientId }));
  on('session.usage', () => ({ value: { context: { window: 200_000 }, rateLimits: state.limits } }));
  on('session.messages', () => ({ value: [{ role: 'assistant', text: ERROR, toolUses: [] }] }));
  on('store.get', ($, e) => ({ value: saved.get(e.key) }));
  on('store.set', ($, e) => { saved.set(e.key, e.value); return { value: undefined }; });
  on('prompt.read', () => ({ value: { text: state.draft, cursor: 0 } }));
  on('command.register', () => ({ value: undefined }));
  on('tool.register', ($, e) => ({ value: { tool: 'mcp__limit-resume__' + e.name } }));
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined }; });
  on('prompt.submit', ($, e) => { sent.push(e.text); return { text: e.text }; });
  on('session.start', () => ({ cwd: '/work' }));
  on('classic.StopFailure', () => ({}));
  on('turn.complete', () => ({ text: '' }));
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('prompt.edit', ($, e) => ({ text: e.text, cursor: e.cursor }));
  on('session.end', () => ({ sessionId: 'test-session' }));
  on('session.append', ($, e) => ({ message: e.message, uuid: e.uuid }));
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['existing band'] }));
  return { clock, saved, sent, logs, state };
}

async function fail($, text = ERROR, error = 'rate_limit') {
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', session_id: 'test-session', cwd: '/work', transcript_path: '/work/test.jsonl', error, last_assistant_message: text });
}

test('Out of usage credits resumes once after reset plus grace, not early', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($, ERROR, 'billing_error');
  await f.clock.advance(179_999);
  expect(f.sent).toEqual([]);
  await f.clock.advance(1);
  expect(f.sent.length).toBe(1);
  expect(f.sent[0]).toContain(resumeText(CFG));
  await f.clock.advance(600_000);
  expect(f.sent.length).toBe(1);
});

test('two failure notifications do not create two resumes', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  await $.turn.complete({ turnId: 'turn', answer: ERROR, durationMs: 0, isAborted: false, reason: 'error' });
  await f.clock.advance(180_000);
  expect(f.sent.length).toBe(1);
});

test('a successful answer mentioning a limit cannot start a resume', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.turn.complete({ turnId: 'turn', answer: ERROR, durationMs: 0, isAborted: false, reason: 'answer' });
  await f.clock.advance(360_000);
  expect(f.sent).toEqual([]);
});

test('ordinary API errors and subagent errors are not resumed', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($, 'API Error: Connection failed', 'server_error');
  await $.turn.complete({ turnId: 'sub', agentId: 'worker', answer: ERROR, durationMs: 0, isAborted: false, reason: 'error' });
  await f.clock.advance(360_000);
  expect(f.sent).toEqual([]);
});

test('off cancels a pending timer and saves the choice for this session', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  await $.command.run({ command: 'limit-resume', args: 'off' });
  await f.clock.advance(360_000);
  expect(f.sent).toEqual([]);
  expect(f.saved.get('session:test-session')).toMatchObject({ enabled: false, pending: null });
});

test('a new request, including native auto-continue, cancels the pending retry', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  await $.prompt.submit({ text: 'Continue', wait: false, origin: { kind: 'auto-continuation' } });
  await f.clock.advance(360_000);
  expect(f.sent).toEqual(['Continue']);
});

test('an unsent draft prevents the automatic request', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  f.state.draft = 'my unsent text';
  await f.clock.advance(180_000);
  expect(f.sent).toEqual([]);
  expect(f.saved.get('session:test-session')).toMatchObject({ pending: null });
});

test('working sessions and user interruptions never resume', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  await $.turn.start({ turnId: 'other', text: 'new work' });
  await f.clock.advance(180_000);
  expect(f.sent).toEqual([]);
  await $.turn.complete({ turnId: 'other', answer: '', durationMs: 0, isAborted: true, reason: 'aborted' });
  await f.clock.advance(360_000);
  expect(f.sent).toEqual([]);
});

test('the later weekly reset takes priority over the five-hour reset', RU, async ($, on) => {
  const f = fixture(on);
  f.state.limits.push({ kind: 'seven_day', percentUsed: 100, resetsAt: new Date(NOW + 3_600_000).toISOString() });
  await $.session.start(START);
  await fail($);
  await f.clock.advance(180_000);
  expect(f.sent).toEqual([]);
  await f.clock.advance(3_480_000);
  expect(f.sent.length).toBe(1);
});

test('a moved reset time postpones the request without spending an attempt', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  f.state.limits[0].resetsAt = new Date(NOW + 600_000).toISOString();
  await f.clock.advance(180_000);
  expect(f.sent).toEqual([]);
  await f.clock.advance(480_000);
  expect(f.sent.length).toBe(1);
});

test('hot-reload restores one pending timer with a key unique to the session', RU, async ($, on) => {
  const f = fixture(on, { 'session:test-session': { enabled: true, attempts: 0, pending: { resetAt: RESET, deadline: RESET + 60_000 } }, 'session:other-session': { enabled: false } });
  await $.session.start(START);
  await f.clock.advance(180_000);
  expect(f.sent.length).toBe(1);
  expect(f.saved.get('session:other-session')).toEqual({ enabled: false });
});

test('three failed retries stop the automatic cycle', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  await f.clock.advance(180_000);
  for (let attempt = 1; attempt < 3; attempt++) {
    await $.turn.start({ turnId: `retry-${attempt}`, text: resumeText(CFG) });
    await fail($);
    await $.turn.complete({ turnId: `retry-${attempt}`, answer: ERROR, durationMs: 0, isAborted: false, reason: 'error' });
    await f.clock.advance(60_000 * 2 ** attempt);
  }
  expect(f.sent.length).toBe(3);
  await $.turn.start({ turnId: 'retry-3', text: resumeText(CFG) });
  await fail($);
  await $.turn.complete({ turnId: 'retry-3', answer: ERROR, durationMs: 0, isAborted: false, reason: 'error' });
  await f.clock.advance(3_600_000);
  expect(f.sent.length).toBe(3);
});

test('no session in print mode can schedule automatic work', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await fail($);
  await f.clock.advance(360_000);
  expect(f.sent).toEqual([]);
});

test('Desktop attaching after SDK startup can resume the selected session', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-app' });
  await fail($);
  await f.clock.advance(180_000);
  expect(f.sent.length).toBe(1);
});

test('Desktop with a noninteractive engine still supports the local command', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.command.run({ command: 'limit-resume', args: 'at 02:22' });
  await f.clock.advance(180_000);
  expect(f.sent.length).toBe(1);
});

test('unknown reset times do not cause repeated blind requests', RU, async ($, on) => {
  const f = fixture(on);
  f.state.limits = [];
  await $.session.start(START);
  await fail($, "You're out of usage credits");
  await f.clock.advance(86_400_000);
  expect(f.sent).toEqual([]);
});

test('an explicit time can arm an already stopped session without a model call', RU, async ($, on) => {
  const f = fixture(on);
  f.state.limits = [];
  await $.session.start(START);
  await $.command.run({ command: 'limit-resume', args: 'at 02:22' });
  await f.clock.advance(180_000);
  expect(f.sent.length).toBe(1);
});

test('the desktop countdown preserves the existing band and can be cancelled', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await fail($);
  const ui = await $.ui.mount({ plugin: 'limit-resume', component: 'AbovePrompt', requestId: 'band', surface: 'desktop', viewport: { columns: 100, rows: 30 }, props: { hasSurvey: false, isWorking: false, bodyColumns: 100, maxRows: 5, scroll: { offset: 0, bodyRows: 1 }, view: {} } });
  expect(await ui.find({ type: 'Text', text: 'existing band' })).toBeDefined();
  expect(await ui.find({ type: 'Button', key: 'limit-resume-cancel' })).toBeDefined();
  await ui.press({ key: 'limit-resume-cancel' });
  await f.clock.advance(180_000);
  expect(f.sent).toEqual([]);
  await ui.unmount();
});

test('parsers preserve midnight, 12am/12pm and named and unknown time zones', RU, async () => {
  expect(isLimitError('An article says: usage limit reached')).toBe(false);
  expect(isLimitError("API Error: You're out of usage credits")).toBe(true);
  expect(clockTime('02:22', NOW, CFG.zone)).toBe(RESET);
  expect(clockTime('12am', NOW, CFG.zone)).toBe(Date.parse('2026-10-14T20:00:00Z'));
  expect(clockTime('12pm', NOW, CFG.zone)).toBe(Date.parse('2026-10-14T08:00:00Z'));
  expect(clockTime('25:00', NOW, CFG.zone)).toBe(null);
  expect(textReset(ERROR, NOW, CFG.zone)).toBe(RESET);
  expect(textReset("You've hit your weekly limit · resets 3pm", NOW, CFG.zone)).toBe(null);
  expect(textReset("You've hit your session limit · resets 3pm (America/New_York)", NOW, CFG.zone)).toBe(Date.parse('2026-10-14T19:00:00Z'));
  expect(textReset("You've hit your session limit · resets 3pm (Not/A_Zone)", NOW, CFG.zone)).toBe(null);
  expect(textReset("You've hit your session limit · resets 3pm", NOW, 'Europe/Berlin')).toBe(Date.parse('2026-10-14T13:00:00Z'));
  expect(exhaustedReset([{ kind: 'five_hour', percentUsed: 80, resetsAt: new Date(RESET).toISOString() }])).toBe(null);
});

test('clock times follow DST: a skipped hour moves past the gap, a repeated hour is not skipped', async () => {
  const ny = 'America/New_York';
  // 8 March 2026: 02:00-03:00 does not exist; 02:30 lands at 03:30 EDT.
  expect(clockTime('02:30', Date.parse('2026-03-08T05:00:00Z'), ny)).toBe(Date.parse('2026-03-08T07:30:00Z'));
  // 1 November 2026: 01:30 happens twice; after the first one the second is next.
  expect(clockTime('01:30', Date.parse('2026-11-01T05:45:00Z'), ny)).toBe(Date.parse('2026-11-01T06:30:00Z'));
  expect(clockTime('01:30', Date.parse('2026-11-01T04:00:00Z'), ny)).toBe(Date.parse('2026-11-01T05:30:00Z'));
  // Half-hour zone.
  expect(clockTime('14:00', Date.parse('2026-10-14T03:00:00Z'), 'Asia/Kolkata')).toBe(Date.parse('2026-10-14T08:30:00Z'));
});

test('a zone without a slash in the engine message is honoured', async () => {
  expect(textReset("You've hit your session limit · resets 3pm (UTC)", NOW, 'Asia/Dubai')).toBe(Date.parse('2026-10-14T15:00:00Z'));
});
