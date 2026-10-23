import { DEFAULTS, dayLabel, t, timeLabel } from './config.js';

export const CHECKPOINT_TOOL = 'mcp__limit-resume__checkpoint';
export const CHECKPOINT_FIELDS = ['goal', 'completed', 'remaining', 'nextStep', 'checks', 'constraints'];
export const CONTINUATIONS = ['auto', 'owner', 'done'];

// Work at full strength and judge by the remaining budget and the time to the
// reset. Hard steps only far from the reset: at 90% save state; with a reserve
// configured, from 97% of the five-hour window or 99% of the week only the
// marked session spends the rest. Within NEAR_RESET_MS of the reset economy is lifted.
export const RESERVE = 97;
const SAVE_AT = 90;
const RESERVE_AT = { five_hour: 97, seven_day: 99 };
export const NEAR_RESET_MS = 15 * 60_000;
const PACE_SPAN_MS = 60 * 60_000;
const PACE_MIN_MS = 5 * 60_000;

function windowLevel(w, now, cfg) {
  // The reserve holds up to the reset; only economy is lifted near it.
  if (cfg.reserveFor && w.percentUsed >= RESERVE_AT[w.kind]) return RESERVE;
  if (Date.parse(w.resetsAt) - now <= NEAR_RESET_MS) return 0;
  return w.percentUsed >= SAVE_AT ? SAVE_AT : 0;
}

export function budgetWindow(limits, now, cfg = DEFAULTS) {
  const windows = (limits ?? []).filter(w => w.kind in RESERVE_AT
    && Number.isFinite(w.percentUsed) && Number.isFinite(Date.parse(w.resetsAt)) && Date.parse(w.resetsAt) > now)
    .map(w => ({ ...w, level: windowLevel(w, now, cfg) })).filter(w => w.level);
  if (!windows.length) return null;
  windows.sort((a, b) => b.level - a.level || b.percentUsed - a.percentUsed || Date.parse(b.resetsAt) - Date.parse(a.resetsAt));
  const w = windows[0];
  // Wait for every window that blocks: a five-hour reset does not lift the weekly reserve.
  return { key: `${w.kind}:${w.resetsAt}`, level: w.level,
    percent: w.percentUsed, resetAt: Math.max(...windows.filter(x => x.level === w.level).map(x => Date.parse(x.resetsAt))) };
}

// Samples of the five-hour window for the pace: the last hour of this session.
export function trackPace(samples, limits, now) {
  const w = (limits ?? []).find(x => x.kind === 'five_hour' && Number.isFinite(x.percentUsed));
  if (!w) return samples ?? [];
  let list = (samples ?? []).filter(x => x.resetsAt === w.resetsAt && now - x.at <= PACE_SPAN_MS && x.pct <= w.percentUsed);
  const last = list.at(-1);
  if (!last || last.pct !== w.percentUsed || now - last.at >= 2 * 60_000) list = [...list, { at: now, pct: w.percentUsed, resetsAt: w.resetsAt }];
  return list.slice(-40);
}

// Forecast for the five-hour window from the observed pace, or null while unknown.
export function forecast(samples, limits, now, cfg = DEFAULTS) {
  const w = (limits ?? []).find(x => x.kind === 'five_hour' && Number.isFinite(x.percentUsed));
  const list = (samples ?? []).filter(x => w && x.resetsAt === w.resetsAt);
  if (!w || list.length < 2) return null;
  const span = list.at(-1).at - list[0].at;
  if (span < PACE_MIN_MS) return null;
  const pace = (list.at(-1).pct - list[0].pct) / span;
  const reset = Date.parse(w.resetsAt);
  const m = Math.round(span / 60_000);
  if (pace <= 0) return { short: false, text: t(cfg, 'paceFlat', { m }) };
  const out = now + (100 - w.percentUsed) / pace;
  if (out >= reset) return { short: false, text: t(cfg, 'paceEnough', { m, pct: Math.min(100, Math.round(w.percentUsed + pace * (reset - now))) }) };
  return { short: true, text: t(cfg, 'paceShort', { m, time: timeLabel(out, cfg), left: Math.round((reset - out) / 60_000) }) };
}

export function savingRule(cfg = DEFAULTS) {
  return t(cfg, 'rule') + (cfg.hint ? cfg.hint + ' ' : '') + t(cfg, 'ruleNear')
    + (cfg.reserveFor ? t(cfg, 'ruleReserve', { name: cfg.reserveFor }) : '') + t(cfg, 'ruleTail');
}

function untilLabel(ms, now, cfg) {
  const minutes = Math.max(0, Math.round((ms - now) / 60_000));
  if (minutes < 120) return t(cfg, 'inMinutes', { m: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? t(cfg, 'inHours', { h: hours, m: minutes % 60 }) : t(cfg, 'inDays', { d: Math.floor(hours / 24), h: hours % 24 });
}

// One line per owner turn: the agent plans against the remaining budget.
export function budgetLine(limits, now, samples = [], cfg = DEFAULTS) {
  const names = t(cfg, 'windows');
  const windows = (limits ?? []).filter(w => names[w.kind] && Number.isFinite(w.percentUsed));
  const parts = windows.map(w => {
    const reset = Date.parse(w.resetsAt ?? '');
    const when = Number.isFinite(reset) && reset > now
      ? t(cfg, 'reset', { until: untilLabel(reset, now, cfg), when: (w.kind === 'seven_day' ? dayLabel(reset, cfg) + ' ' : '') + timeLabel(reset, cfg) }) : '';
    return `${names[w.kind]} ${Math.round(w.percentUsed)}%${when}`;
  });
  if (!parts.length) return null;
  const f = forecast(samples, limits, now, cfg);
  // The rule costs tokens: only when the budget may matter.
  const relevant = f?.short || windows.some(w => w.percentUsed >= 70);
  return `${t(cfg, 'lineHead')}${parts.join('; ')}${f ? '; ' + f.text : ''}.`
    + (relevant ? ' ' + savingRule(cfg) : '');
}

export function checkpointNotice(w, reserved = false, cfg = DEFAULTS) {
  const reserve = w.level === RESERVE && !reserved;
  return t(cfg, 'noticeHead', { pct: w.percent }) + t(cfg, 'noticeCall', { tool: CHECKPOINT_TOOL })
    + (reserve ? t(cfg, 'noticeReserve', { name: cfg.reserveFor }) : t(cfg, 'noticeGoOn'));
}

export function cleanCheckpoint(input) {
  const result = {};
  let size = 0;
  for (const field of CHECKPOINT_FIELDS) {
    if (typeof input[field] !== 'string' || !input[field].trim()) return null;
    const text = input[field].trim();
    if (text.length > 4000) return null;
    size += text.length;
    result[field] = text;
  }
  return size <= 12000 ? result : null;
}
