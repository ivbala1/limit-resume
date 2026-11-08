import { expect, mock, test } from 'claude-code/testing';
import { settings } from '../hooks/config.js';
const RU = { options: { language: 'ru', timeZone: 'Asia/Dubai', reserveFor: 'ассистента', economyHint: 'Разведку можно отдать другому агенту.' } };
const CFG = settings(RU.options);
import { budgetLine, budgetWindow, trackPace, CHECKPOINT_TOOL } from '../hooks/budget.js';

const NOW = Date.parse('2026-10-13T22:20:00Z');
const RESET = NOW + 1_200_000;
const SUMMARY = { goal: 'Проверить проект', completed: 'Правка сохранена', remaining: 'Проверить тесты', nextStep: 'Запустить проверки', checks: 'Пока не запускались', constraints: 'Ничего не отправлять', continuation: 'auto', verifyFirst: false };

function setup(on, extra = {}) {
  const clock = mock.clock(on, { now: NOW });
  const data = new Map([['session:budget-session', { enabled: true, monitor: true, ...extra }]]);
  const state = { limits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: new Date(RESET).toISOString() }], submitted: [] as string[], contexts: [] as string[][], dropSubmit: false, dropReason: 'blocked', submitDelay: 0 };
  on('session.start', () => ({ cwd: '/work' }));
  on('session.id', () => ({ value: 'budget-session' }));
  on('session.surfaces', () => ({ value: [] }));
  on('session.messages', () => ({ value: [] }));
  on('session.usage', () => ({ value: { context: { window: 1_000_000 }, rateLimits: state.limits } }));
  on('session.measure', ($, e) => ({ changed: e.changed }));
  on('store.get', ($, e) => ({ value: data.get(e.key) }));
  on('store.set', ($, e) => { data.set(e.key, e.value); return { value: undefined }; });
  on('command.register', () => ({ value: undefined }));
  on('tool.register', ($, e) => ({ value: { tool: 'mcp__limit-resume__' + e.name } }));
  on('tool.call', () => ({ result: { file: 'unchanged result' }, context: ['existing note'] }));
  on('ui.log', () => ({ value: undefined }));
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }));
  // Like the engine: an accepted automatic continuation starts a turn.
  on('prompt.submit', async ($, e) => { state.submitted.push(e.text); state.contexts.push(e.context ?? []); if (state.submitDelay && e.origin?.kind === 'plugin') await clock.sleep(state.submitDelay); return state.dropSubmit ? { drop: state.dropReason } : { text: e.text }; });
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('classic.StopFailure', () => ({}));
  on('session.detach', ($, e) => ({ clientId: e.clientId }));
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('prompt.edit', ($, e) => ({ text: e.text, cursor: e.cursor }));
  return { clock, data, state };
}

async function read($, agentId?) { return $.tool.call({ tool: 'Read', file_path: '/work/file', ...(agentId ? { agentId } : {}) }); }
async function finish($) { await $.turn.complete({ turnId: 'main', answer: 'Состояние сохранено', durationMs: 1, isAborted: false, reason: 'answer' }); }

test('client-composed SDK command is consumed locally before reaching the model', RU, async ($, on) => {
  const f = setup(on, { enabled: false, monitor: false });
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  const answer = await $.prompt.submit({ text: '/limit-resume on', wait: false, origin: { kind: 'sdk' } });
  expect(answer.drop).toContain('0.7.1 загружен');
  expect(f.state.submitted).toEqual([]);
  expect(f.data.get('session:budget-session')).toMatchObject({ enabled: true, monitor: true });
});

test('quotations and peer messages cannot operate the local controller', RU, async ($, on) => {
  const f = setup(on, { enabled: false, monitor: false, optedOut: true });
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.prompt.submit({ text: 'Объясни /limit-resume on', wait: false, origin: { kind: 'sdk' } });
  await $.prompt.submit({ text: '/limit-resume on', wait: false, origin: { kind: 'auto-continuation' } });
  expect(f.state.submitted.length).toBe(2);
  expect(f.data.get('session:budget-session')).toMatchObject({ enabled: false });
});

test('90 percent asks once for a checkpoint and preserves the native tool result', RU, async ($, on) => {
  const f = setup(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  const first = await read($);
  const second = await read($);
  expect(first.result).toEqual({ file: 'unchanged result' });
  expect(first.context[0]).toBe('existing note');
  expect(first.context[1]).toContain(CHECKPOINT_TOOL);
  expect(second.context).toEqual(['existing note']);
  expect(f.state.submitted).toEqual([]);
});

test('97 percent checkpoint pauses at turn end and resumes in the background with the saved state', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 97;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Работай' });
  await read($);
  const saved = await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY });
  // The test host does not check a registered tool's output shape; the engine refuses an object.
  expect(typeof saved.result).toBe('string');
  expect(saved.result).toContain('Состояние сохранено');
  expect(saved.context?.[0]).toContain('Заверши текущий ход');
  await $.session.detach({ clientId: 'desktop', surface: 'desktop', reason: 'detach' });
  await f.clock.advance(100_000);
  expect(f.state.submitted).toEqual([]);
  await finish($);
  await f.clock.advance(1_200_000);
  expect(f.state.submitted.length).toBe(1);
  expect(f.state.submitted[0]).toContain('Проверить тесты');
  expect(f.data.get('session:budget-session').checkpoint.sessionId).toBe('budget-session');
});

test('a completed task does not resume just because its checkpoint was saved at 97 percent', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 97;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await read($);
  const saved = await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY, continuation: 'done' });
  expect(typeof saved.result).toBe('string');
  expect(saved.context).toBeUndefined();
  await finish($);
  await f.clock.advance(1_000_000);
  expect(f.state.submitted).toEqual([]);
});

test('only the selected main session can save its checkpoint', RU, async ($, on) => {
  const f = setup(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  const result = await $.tool.call({ tool: CHECKPOINT_TOOL, agentId: 'worker', ...SUMMARY });
  expect(result.deny).toContain('субагента');
  expect(f.data.get('session:budget-session').checkpoint ?? null).toBe(null);
  expect((await read($, 'worker')).context).toEqual(['existing note']);
});

test('an enabled SDK session keeps its timer when no Desktop surface is attached', RU, async ($, on) => {
  const f = setup(on, { enabled: false });
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await $.prompt.submit({ text: '/limit-resume at 02:30', wait: false, origin: { kind: 'sdk' } });
  await f.clock.advance(660_000);
  expect(f.state.submitted.length).toBe(1);
});

test('reopening a selected session restores the wait before any Desktop tab is visited', RU, async ($, on) => {
  const f = setup(on, { enabled: true, selectedForBackground: true, pending: { resetAt: RESET, deadline: RESET + 60_000 } });
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await f.clock.advance(1_300_000);
  expect(f.state.submitted.length).toBe(1);
});

test('the first typed character cancels a waiting timer', RU, async ($, on) => {
  const f = setup(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.command.run({ command: 'limit-resume', args: 'at 02:30' });
  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'a' });
  await f.clock.advance(660_000);
  expect(f.state.submitted).toEqual([]);
});

test('closing the host preserves a waiting deadline but clear discards it', RU, async ($, on) => {
  const f = setup(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.command.run({ command: 'limit-resume', args: 'at 02:30' });
  await $.session.end({ reason: 'other', sessionId: 'budget-session', resume: { id: 'budget-session', cwd: '/work' } });
  expect(f.data.get('session:budget-session').pending.deadline).toBe(NOW + 660_000);
  await f.clock.advance(660_000);
  expect(f.state.submitted).toEqual([]);
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await $.session.end({ reason: 'clear', sessionId: 'budget-session', resume: { id: 'budget-session', cwd: '/work' } });
  expect(f.data.get('session:budget-session').pending).toBe(null);
});

test('unknown telemetry is never treated as a depleted budget or context handoff', RU, async () => {
  expect(budgetWindow([], NOW)).toBe(null);
  expect(budgetWindow([{ kind: 'five_hour', percentUsed: 99 }], NOW)).toBe(null);
  expect(budgetWindow([{ kind: 'context', percentUsed: 99, resetsAt: new Date(RESET).toISOString() }], NOW)).toBe(null);
  expect(budgetWindow([{ kind: 'five_hour', percentUsed: 99, resetsAt: new Date(NOW - 1).toISOString() }], NOW)).toBe(null);
});

test('70 percent restricts nothing; near the reset economy is lifted but the reserve holds', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 72;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  expect((await read($)).context).toEqual(['existing note']);
  f.state.limits[0].percentUsed = 93;
  f.state.limits[0].resetsAt = new Date(NOW + 10 * 60_000).toISOString();
  expect((await read($)).context).toEqual(['existing note']);
  f.state.limits[0].percentUsed = 98;
  expect((await read($)).context[1]).toContain('зарезервирован для ассистента');
});

test('the forecast says when the pace runs out before the reset', RU, async () => {
  const reset = new Date(NOW + 3 * 3_600_000).toISOString();
  const lim = p => [{ kind: 'five_hour', percentUsed: p, resetsAt: reset }];
  let samples = trackPace([], lim(50), NOW);
  samples = trackPace(samples, lim(60), NOW + 20 * 60_000);
  const fast = budgetLine(lim(60), NOW + 20 * 60_000, samples, CFG);
  expect(fast).toContain('лимит кончится около');
  expect(fast).toContain('другому агенту');
  let slow = trackPace([], lim(30), NOW);
  slow = trackPace(slow, lim(31), NOW + 30 * 60_000);
  const calm = budgetLine(lim(31), NOW + 30 * 60_000, slow, CFG);
  expect(calm).toContain('хватит до сброса');
  expect(calm).not.toContain('Работай полноценно');
});

test('every owner prompt carries the current budget of both windows', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits = [
    { kind: 'five_hour', percentUsed: 62.4, resetsAt: new Date(RESET).toISOString() },
    { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-17T10:00:00Z' },
  ];
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.prompt.submit({ text: 'Сделай задачу', wait: false, origin: { kind: 'composer' } });
  expect(f.state.contexts[0][0]).toContain('5 часов 62%, сброс через 20 мин (02:40 Dubai)');
  expect(f.state.contexts[0][0]).toContain('неделя 41%, сброс через 3 дн 11 ч (17.10 14:00 Dubai)');
  expect(f.state.contexts[0][0]).not.toContain('Работай полноценно');
});

test('an opted-out session gets no budget line', RU, async ($, on) => {
  const f = setup(on, { optedOut: true });
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.prompt.submit({ text: 'Сделай задачу', wait: false, origin: { kind: 'composer' } });
  expect(f.state.contexts[0]).toEqual([]);
});

async function savedTurn($, f) {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Работай' });
  const notice = await read($);
  await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY });
  await finish($);
  await f.clock.advance(700_000);
  return notice;
}

test('95 percent prepares for exhaustion but keeps working', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 96;
  const notice = await savedTurn($, f);
  expect(notice.context[1]).toContain('Работа продолжается');
  expect(f.state.submitted).toEqual([]);
});

test('a session marked with reserve spends the reserve instead of pausing', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 98;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.command.run({ command: 'limit-resume', args: 'reserve' });
  await $.turn.start({ turnId: 'main', text: 'Работай' });
  expect((await read($)).context[1]).toContain('Работа продолжается');
  await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY });
  await finish($);
  await f.clock.advance(700_000);
  expect(f.state.submitted).toEqual([]);
  expect(f.data.get('session:budget-session').reserved).toBe(true);
});

test('the weekly window reserves only from 99 percent and waits for its own reset', RU, async ($, on) => {
  const week = NOW + 3 * 86_400_000;
  expect(budgetWindow([{ kind: 'seven_day', percentUsed: 98, resetsAt: new Date(week).toISOString() }], NOW, CFG).level).toBe(90);
  const both = budgetWindow([
    { kind: 'five_hour', percentUsed: 97, resetsAt: new Date(RESET).toISOString() },
    { kind: 'seven_day', percentUsed: 99, resetsAt: new Date(week).toISOString() },
  ], NOW, CFG);
  expect(both.level).toBe(97);
  expect(both.resetAt).toBe(week);
});

test('the economy hint appears only when Claude is at 70 percent or more', RU, async () => {
  const at = p => budgetLine([{ kind: 'five_hour', percentUsed: p, resetsAt: new Date(RESET).toISOString() }], NOW, [], CFG);
  expect(at(40)).not.toContain('другому агенту');
  expect(at(71)).toContain('другому агенту');
});

async function pauseAtReserve($, f) {
  f.state.limits[0].percentUsed = 98;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Работай' });
  await read($);
  await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY });
  await finish($);
}

test('a dropped continuation is retried within the attempt limit, not counted as started', RU, async ($, on) => {
  const f = setup(on);
  f.state.dropSubmit = true;
  await pauseAtReserve($, f);
  await f.clock.advance(3_600_000);
  expect(f.state.submitted.length).toBe(3);
});

test('a checkpoint older than the owner\'s last message is not attached to the continuation', RU, async ($, on) => {
  const f = setup(on);
  await pauseAtReserve($, f);
  await $.prompt.submit({ text: 'Новая задача', wait: false, origin: { kind: 'composer' } });
  await $.turn.start({ turnId: 'new', text: 'Новая задача' });
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 2:40am (Asia/Dubai)", session_id: 'budget-session', cwd: '/work', transcript_path: '/work/t.jsonl' });
  await f.clock.advance(3_600_000);
  const resume = f.state.submitted.filter(t => t.startsWith('Лимит использования сбросился'));
  expect(resume.length).toBe(1);
  expect(resume[0]).not.toContain('Проверить тесты');
  expect(resume[0]).toContain('Сначала проверь, чем кончилось последнее действие');
});

test('a task waiting for the owner is not continued automatically', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 98;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Работай' });
  await read($);
  await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY, continuation: 'owner' });
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 2:40am (Asia/Dubai)", session_id: 'budget-session', cwd: '/work', transcript_path: '/work/t.jsonl' });
  await f.clock.advance(3_600_000);
  expect(f.state.submitted).toEqual([]);
});

test('verifyFirst is spelled out in the continuation', RU, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 98;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Работай' });
  await read($);
  await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY, verifyFirst: true });
  await finish($);
  await f.clock.advance(3_600_000);
  expect(f.state.submitted[0]).toContain('результат последнего действия неизвестен');
});

test('a continuation refused because the owner stopped the session is not retried', RU, async ($, on) => {
  const f = setup(on);
  f.state.dropSubmit = true;
  f.state.dropReason = 'the session was stopped and nobody has sent input since';
  await pauseAtReserve($, f);
  await f.clock.advance(3_600_000);
  expect(f.state.submitted.length).toBe(1);
  expect(f.data.get('session:budget-session').pending).toBe(null);
});

test('after a reload the mod still owns its submitted continuation', RU, async ($, on) => {
  const f = setup(on, { ownSubmission: true, attempts: 2 });
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'resume', text: 'Лимит использования сбросился.' });
  expect(f.data.get('session:budget-session').attempts).toBe(2);
});

test('a late drop after the owner wrote does not restart the wait', RU, async ($, on) => {
  const f = setup(on);
  f.state.dropSubmit = true;
  f.state.submitDelay = 30_000;
  await pauseAtReserve($, f);
  await f.clock.advance(1_270_000);
  expect(f.state.submitted.length).toBe(1);
  await $.prompt.submit({ text: 'Сам продолжу', wait: false, origin: { kind: 'composer' } });
  await f.clock.advance(3_600_000);
  expect(f.state.submitted.filter(t => t.startsWith('Лимит использования')).length).toBe(1);
  expect(f.data.get('session:budget-session').pending).toBe(null);
});

test('defaults: English, no reserve, so 98 percent keeps working and never pauses', async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 98;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Work' });
  const notice = (await read($)).context[1];
  expect(notice).toContain('Work goes on');
  expect(notice).not.toContain('kept for');
  await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY });
  await finish($);
  await f.clock.advance(700_000);
  expect(f.state.submitted).toEqual([]);
  const status = await $.command.run({ command: 'limit-resume', args: 'status' });
  expect(status.text).toContain('limit-resume 0.7.1 loaded');
  const mark = await $.command.run({ command: 'limit-resume', args: 'reserve' });
  expect(mark.text).toContain('No reserve is configured');
  expect(f.data.get('session:budget-session').reserved).toBe(false);
});

test('an English reserve names who it is kept for and pauses an unmarked session', { options: { reserveFor: 'my assistant' } }, async ($, on) => {
  const f = setup(on);
  f.state.limits[0].percentUsed = 98;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Work' });
  expect((await read($)).context[1]).toContain('The rest is kept for my assistant');
  await $.tool.call({ tool: CHECKPOINT_TOOL, ...SUMMARY });
  await finish($);
  await f.clock.advance(1_200_000 + 120_000);
  expect(f.state.submitted.length).toBe(1);
  expect(f.state.submitted[0]).toContain('The usage limit has reset');
});

test('the configured zone and hint shape the budget line; a bad zone falls back to the system one', async () => {
  const cfg = settings({ timeZone: 'Europe/Berlin', economyHint: 'Hand scouting to a cheaper model.' });
  const line = budgetLine([{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(RESET).toISOString() }], NOW, [], cfg);
  expect(line).toContain('5 hours 71%, resets in 20 min (00:40 Berlin)');
  expect(line).toContain('Hand scouting to a cheaper model.');
  expect(line).not.toContain('kept for');
  expect(settings({ timeZone: 'Not/A_Zone' }).zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(settings({}).lang).toBe('en');
});

test('a reserve pause saved earlier does not come back once the reserve is turned off', async ($, on) => {
  const f = setup(on, { pauseAfterTurn: true, latestBudget: { key: 'k', level: 97, percent: 98, resetAt: RESET } });
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  await $.turn.start({ turnId: 'main', text: 'Work' });
  await finish($);
  expect(f.data.get('session:budget-session').pauseAfterTurn).toBe(false);
  expect(f.state.submitted).toEqual([]);
});

test('a wait for a reserve that is turned off now continues within a minute', async ($, on) => {
  const f = setup(on, { pending: { resetAt: RESET, deadline: RESET + 60_000, reserve: true } });
  f.state.limits[0].percentUsed = 98;
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: false });
  const saved = f.data.get('session:budget-session').pending;
  expect(saved.reserve).toBeUndefined();
  expect(saved.deadline).toBe(NOW + 60_000);
  await f.clock.advance(75_000);
  expect(f.state.submitted.length).toBe(1);
});
