import { expect, mock, test } from 'claude-code/testing';
import { settings } from '../hooks/config.js';
const RU = { options: { language: 'ru', timeZone: 'Asia/Dubai', reserveFor: 'ассистента', economyHint: 'Разведку можно отдать другому агенту.' } };
const CFG = settings(RU.options);

const ERROR = "You've hit your session limit · resets 2:40am (Asia/Dubai)";

function setup(on, saved?) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-13T22:20:00Z') });
  const sent: string[] = [];
  const data = new Map(saved ? [['session:s', saved]] : []);
  on('session.start', () => ({ cwd: '/work' }));
  on('session.surfaces', () => ({ value: [] }));
  on('session.id', () => ({ value: 's' }));
  on('session.usage', () => ({ value: { context: { window: 200_000 }, rateLimits: [] } }));
  on('session.messages', () => ({ value: [] }));
  on('store.get', ($, e) => ({ value: data.get(e.key) }));
  on('store.set', ($, e) => { data.set(e.key, e.value); return { value: undefined }; });
  on('command.register', () => ({ value: undefined }));
  on('tool.register', ($, e) => ({ value: { tool: 'mcp__limit-resume__' + e.name } }));
  on('ui.log', () => ({ value: undefined }));
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }));
  on('classic.StopFailure', () => ({}));
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('prompt.submit', ($, e) => { sent.push(e.text); return { text: e.text }; });
  return { clock, sent, data };
}

async function hitLimit($) {
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: ERROR, session_id: 's', cwd: '/work', transcript_path: '/work/test.jsonl' });
}

test('a new interactive session is on by default and resumes after the reset', RU, async ($, on) => {
  const f = setup(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  await hitLimit($);
  await f.clock.advance(3_600_000);
  expect(f.sent.length).toBe(1);
  expect(f.data.get('session:s')).toMatchObject({ enabled: true, selectedForBackground: true });
});

test('a session left disabled by an earlier version is adopted', RU, async ($, on) => {
  const f = setup(on, { enabled: false, pending: null, attempts: 0 });
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  await hitLimit($);
  await f.clock.advance(3_600_000);
  expect(f.sent.length).toBe(1);
});

test('headless runs such as bots and timers are never selected', RU, async ($, on) => {
  const f = setup(on);
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await hitLimit($);
  await f.clock.advance(3_600_000);
  expect(f.sent).toEqual([]);
  expect(f.data.get('session:s')?.selectedForBackground ?? false).toBe(false);
});

test('off is remembered across a reload of the session', RU, async ($, on) => {
  const f = setup(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  await $.command.run({ command: 'limit-resume', args: 'off' });
  await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's', cwd: '/work' } });
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  await hitLimit($);
  await f.clock.advance(3_600_000);
  expect(f.sent).toEqual([]);
  expect((await $.command.run({ command: 'limit-resume', args: 'status' })).text).toContain('Выключено');
});
