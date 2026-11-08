import { DEFAULTS, localDate, t, validZone, zonedTimes } from './config.js';
export { timeLabel } from './config.js';

export const resumeText = (cfg = DEFAULTS) => t(cfg, 'resume');
export const GRACE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const MAX_WAIT_MS = 8 * 24 * 60 * 60_000;

export function isLimitError(text) {
  if (typeof text !== 'string') return false;
  const clean = text.replace(/^Claude Code returned an error result:\s*/i, '')
    .replace(/^API Error:?\s*(?:\d{3}\s*)?/i, '').trim();
  // Wording drifts between releases (session, 5-hour...): match the shape, not a word list.
  return /^(?![^\n]*\b(?:context|token|output)\b)(?:you(?:['’]ve| have) (?:hit|reached) (?:your|the) [\w‑ -]*limit|you['’]re out of (?:usage credits|extra usage)|out of usage credits|(?:[\w-]+ ){0,2}(?:usage|session|weekly|daily|opus|sonnet|[\w‑-]*hour(?:ly)?|[\w‑-]*day) limit (?:reached|exceeded)|rate limit reached|(?:[\w-]+ ){0,3}limit\s*[·∙|:-]\s*resets?\s+(?:at\s+)?\d)/i.test(clean);
}

export function exhaustedReset(limits, now = -Infinity) {
  const resets = (limits ?? []).filter(r =>
    ['five_hour', 'seven_day'].includes(r.kind) && r.percentUsed >= 100
  ).map(r => Date.parse(r.resetsAt ?? '')).filter(t => Number.isFinite(t) && t > now);
  return resets.length ? Math.max(...resets) : null;
}

// Only an engine error, or an explicit /limit-resume command, reaches this parser.
// Structured ISO reset times take priority. Avoid guessing dates for weekly limits.
export function clockTime(text, now, zone = DEFAULTS.zone) {
  const match = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (minutes > 59 || (match[3] ? hours < 1 || hours > 12 : hours > 23)) return null;
  if (match[3]) hours = hours % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  const today = localDate(now, zone);
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const moments = [...zonedTimes(zone, today.year, today.month, today.day, hours, minutes),
    ...zonedTimes(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hours, minutes)];
  return moments.find(ms => ms >= now - 5 * 60_000) ?? null;
}

// The engine names the zone of its reset time; without one the configured zone is assumed.
export function textReset(text, now, zone = DEFAULTS.zone) {
  if (!isLimitError(text) || /week|seven.day|7.?day|7d\b|168/i.test(text)) return null;
  const tokens = [...text.matchAll(/\(([^()\s]+)\)/g)].map(m => m[1]);
  const named = tokens.find(validZone);
  // A zone the runtime does not know: better no time than a wrong one.
  if (!named && tokens.some(x => x.includes('/'))) return null;
  const match = text.match(/(?:resets?|reset at)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?!\w|\s+[a-z])/i);
  return match ? clockTime(match[1], now, named ?? zone) : null;
}

export function nextDeadline(resetAt, now, attempts) {
  if (!Number.isFinite(resetAt) || resetAt > now + MAX_WAIT_MS) return null;
  return Math.max(resetAt + GRACE_MS, now + GRACE_MS * Math.max(1, 2 ** attempts));
}
