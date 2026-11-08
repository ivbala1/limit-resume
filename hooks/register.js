import { CHECKPOINT_TOOL, CHECKPOINT_FIELDS, CONTINUATIONS, budgetWindow, budgetLine, checkpointNotice, cleanCheckpoint, trackPace, RESERVE } from './budget.js';
import { resumeText as baseResumeText, GRACE_MS, MAX_ATTEMPTS, MAX_WAIT_MS, isLimitError, exhaustedReset, clockTime, textReset, nextDeadline } from './logic.js';
import { DEFAULTS, settings, t, timeLabel as zonedLabel } from './config.js';

const VERSION = '0.7.1';
let cfg = DEFAULTS;
const say = (key, vars) => t(cfg, key, vars);
const timeLabel = ms => zonedLabel(ms, cfg);

let sessionId = null;
let enabled = false;
let interactive = false;
let working = false;
let pending = null;
let attempts = 0;
let generation = 0;
let timer = null;
let firing = false;
let ownSubmission = false;
let lastError = '';
let status = '';
let monitor = false;
let selectedForBackground = false;
let warned = {};
let checkpoint = null;
let latestBudget = null;
// Recent samples of the five-hour window: the pace for the forecast.
let paceSamples = [];
let pauseAfterTurn = false;
let optedOut = false;
// Set explicitly by the owner: this session may spend the configured reserve.
let reserved = false;
// Number of turns that were not our continuation: a checkpoint saved under an earlier number describes an older task.
let ownerTurn = 0;

function cancelTimer() {
  generation += 1;
  timer?.cancel();
  timer = null;
  pending = null;
  firing = false;
}

async function save($) {
  if (!sessionId) return;
  await $.store.set(`session:${sessionId}`, { enabled, optedOut, reserved, paceSamples, ownerTurn, ownSubmission, pending, attempts, monitor, selectedForBackground, warned, checkpoint, pauseAfterTurn, latestBudget });
}

async function show($, message) {
  status = message;
  $.ui.invalidate('ui.render');
  await $.ui.log(message);
}

async function cancel($, message, resetAttempts = true) {
  cancelTimer();
  if (resetAttempts) attempts = 0;
  await save($);
  if (message) await show($, message);
}

async function ensureSession($) {
  const id = await $.session.id();
  if (id !== sessionId) await load($, id);
  // On by default: an interactive session joins background resume unless the owner opted out.
  if (interactive && enabled && !selectedForBackground) {
    monitor = true;
    selectedForBackground = true;
    await registerCheckpoint($);
    await save($);
  }
}

async function load($, id) {
  cancelTimer();
  sessionId = id;
  working = false;
  ownSubmission = false;
  lastError = '';
  const saved = await $.store.get(`session:${id}`);
  optedOut = saved?.optedOut === true;
  reserved = saved?.reserved === true;
  ownerTurn = Number.isInteger(saved?.ownerTurn) ? saved.ownerTurn : 0;
  enabled = !optedOut;
  monitor = enabled;
  // A continuation submitted before a reload is still ours when its turn starts.
  ownSubmission = enabled && saved?.ownSubmission === true;
  selectedForBackground = saved?.selectedForBackground === true;
  if (enabled && selectedForBackground) interactive = true;
  warned = saved?.warned ?? {};
  checkpoint = saved?.checkpoint ?? null;
  // A reserve turned off in the options must not come back from the store.
  pauseAfterTurn = Boolean(cfg.reserveFor) && saved?.pauseAfterTurn === true;
  latestBudget = saved?.latestBudget?.level === RESERVE && !cfg.reserveFor ? null : saved?.latestBudget ?? null;
  paceSamples = Array.isArray(saved?.paceSamples) ? saved.paceSamples : [];
  attempts = Number.isInteger(saved?.attempts) ? Math.min(saved.attempts, MAX_ATTEMPTS) : 0;
  const now = await $.clock.now();
  if (enabled && saved?.pending && Number.isFinite(saved.pending.deadline)
      && saved.pending.deadline <= now + MAX_WAIT_MS && attempts < MAX_ATTEMPTS) {
    // A pause for a reserve that is turned off now: nothing to wait for, continue shortly.
    const released = saved.pending.reserve && !cfg.reserveFor;
    pending = released ? { resetAt: now, deadline: Math.min(saved.pending.deadline, now + GRACE_MS) } : saved.pending;
    schedule($);
    // Saved at once: a later reload must not push the shortened deadline again.
    if (released) await save($);
    await show($, say('resumeAt', { time: timeLabel(pending.deadline) }));
  }
}

function schedule($) {
  const token = generation;
  timer?.cancel();
  // A short local poll also handles a computer waking after the reset.
  timer = $.clock.every(15_000, async () => {
    try { await check($, token); }
    catch { if (token === generation) await cancel($, say('checkFailed')); }
  });
}

async function check($, token) {
  if (token !== generation || !pending || !enabled || !interactive || working || firing) return;
  const now = await $.clock.now();
  if (now < pending.deadline) return;
  firing = true;
  const [draft, usage] = await Promise.all([$.prompt.read(), $.session.usage()]);
  if (token !== generation || !pending || !enabled || working) { firing = false; return; }
  if (draft.text.trim()) {
    await cancel($, say('draftCancel'));
    return;
  }
  const later = exhaustedReset(usage.rateLimits);
  if (later !== null && later + 60_000 > now && later > pending.resetAt) {
    const deadline = nextDeadline(later, now, attempts);
    if (deadline === null) { await cancel($, say('tooFar')); return; }
    pending = { resetAt: later, deadline };
    firing = false;
    await save($);
    await show($, say('stillLimited', { time: timeLabel(deadline) }));
    return;
  }
  if (attempts >= MAX_ATTEMPTS) { await cancel($, say('attemptsOut'), false); return; }
  if (freshCheckpoint() && ['owner', 'done'].includes(checkpoint.continuation)) {
    await cancel($, say(checkpoint.continuation === 'owner' ? 'ownerWaits' : 'taskDone'));
    return;
  }
  attempts += 1;
  const resetAt = pending.resetAt;
  // Claim the attempt before submitting: a reload cannot send it twice. The
  // engine keeps an accepted prompt queued, so a reload does not lose it either.
  cancelTimer();
  ownSubmission = true;
  const claim = generation;
  await save($);
  await show($, say('sending', { n: attempts, max: MAX_ATTEMPTS }));
  // A new request or `off` during these awaits cancels the claim.
  if (claim !== generation || !enabled || working) { ownSubmission = false; return; }
  let accepted;
  try {
    // Resolves when the continuation's turn starts (mods API), or with { drop }.
    accepted = await $.prompt.submit({ text: resumeText() });
  } catch (err) {
    accepted = { drop: String(err?.message ?? err) };
  }
  if (accepted && accepted.drop === undefined) return;
  // The owner may have written or turned the mod off while submit waited.
  if (claim !== generation || !enabled) return;
  ownSubmission = false;
  const reason = String(accepted?.drop ?? '');
  // The owner stopped the session: continuing on our own would override that.
  if (reason.includes('the session was stopped')) {
    await cancel($, say('stopped'), false);
    return;
  }
  await retryLater($, resetAt, say('notAccepted'), claim);
}

async function retryLater($, resetAt, reason, claim) {
  if (attempts >= MAX_ATTEMPTS) { await cancel($, say('reasonOut', { reason }), false); return; }
  const now = await $.clock.now();
  if (claim !== generation || !enabled) return;
  cancelTimer();
  pending = { resetAt, deadline: now + 60_000 * 2 ** attempts };
  schedule($);
  await save($);
  await show($, say('retryAt', { reason, time: timeLabel(pending.deadline) }));
}

function freshCheckpoint() {
  return Boolean(checkpoint) && checkpoint.turn === ownerTurn;
}

// Attach the checkpoint only if it was saved after the owner's last message.
function resumeText() {
  const base = baseResumeText(cfg);
  if (!freshCheckpoint()) return base;
  const first = checkpoint.verifyFirst ? '\n\n' + say('verifyFirst') : '';
  return base + first + '\n\n' + say('attach') + JSON.stringify(checkpoint);
}

async function arm($, text, explicit = false, override = null, reserve = false) {
  await ensureSession($);
  if (!interactive || !enabled || working) return false;
  if (attempts >= MAX_ATTEMPTS) { await show($, say('attemptsArm')); return false; }
  if (!explicit && !isLimitError(text)) return false;
  const now = await $.clock.now();
  const usage = await $.session.usage();
  const resetAt = override ?? exhaustedReset(usage.rateLimits) ?? textReset(text, now, cfg.zone);
  const deadline = nextDeadline(resetAt, now, attempts);
  if (resetAt === null || deadline === null) {
    await show($, say('unknownReset', { zone: cfg.zone }));
    return false;
  }
  if (pending?.resetAt === resetAt) return true;
  cancelTimer();
  pending = reserve ? { resetAt, deadline, reserve } : { resetAt, deadline };
  schedule($);
  await save($);
  await show($, say('resumeAt', { time: timeLabel(deadline) }));
  return true;
}

async function registerCheckpoint($) {
await $.tool.register({ name: 'checkpoint', description: say('toolDescription'), isDeferred: false, inputSchema: { type: 'object', properties: { ...Object.fromEntries(CHECKPOINT_FIELDS.map(k => [k, { type: 'string', maxLength: 4000 }])), continuation: { type: 'string', enum: CONTINUATIONS, description: say('toolContinuation') }, verifyFirst: { type: 'boolean', description: say('toolVerify') } }, required: [...CHECKPOINT_FIELDS, 'continuation', 'verifyFirst'], additionalProperties: false } });
}

async function control($, raw) {
    await ensureSession($);
    const args = raw.trim();
    if (args === 'off') {
      optedOut = true;
      enabled = false;
      monitor = false;
      selectedForBackground = false;
      pauseAfterTurn = false;
      await cancel($, say('off'));
    } else if (args === 'arm' || args.startsWith('at ')) {
      if (working) return { text: say('busy') };
      let override = null;
      if (args.startsWith('at ')) {
        const time = args.slice(3).trim();
        const now = await $.clock.now();
        override = /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(time) ? Date.parse(time) : clockTime(time, now, cfg.zone);
        if (!Number.isFinite(override)) return { text: say('badTime', { zone: cfg.zone }) };
      }
      optedOut = false;
      enabled = true;
      monitor = true;
      selectedForBackground = true;
      await registerCheckpoint($);
      attempts = 0;
      if (!lastError) {
        const messages = await $.session.messages();
        const last = messages.at(-1);
        if (last?.role === 'assistant' && isLimitError(last.text)) lastError = last.text;
      }
      await arm($, lastError, true, override);
    } else if (args === 'on') {
      optedOut = false;
      enabled = true;
      monitor = true;
      selectedForBackground = true;
      await registerCheckpoint($);
      attempts = 0;
      await save($);
      await show($, say('on'));
    } else if (args === 'reserve' || args === 'reserve off') {
      if (!cfg.reserveFor) return { text: say('reserveNone') };
      reserved = args === 'reserve';
      if (reserved) pauseAfterTurn = false;
      await save($);
      await show($, reserved ? say('reserveOn', { name: cfg.reserveFor }) : say('reserveOffMark'));
    } else if (args === 'checkpoint') {
      return { text: checkpoint ? JSON.stringify(checkpoint, null, 2) : say('noCheckpoint') };
    } else if (args && args !== 'status') {
      return { text: say('commands') };
    }
    const surfaces = await $.session.surfaces();
    return { text: say('status', { version: VERSION, id: sessionId, surfaces: surfaces.join(', ') || say('headless'), state: say(enabled ? 'enabled' : 'disabled'), reserved: reserved && cfg.reserveFor ? say('reservedMark', { name: cfg.reserveFor }) : '', status: status || say('ready') }) };

}

async function measureBudget($, limits) {
  if (!interactive || !enabled || !monitor) return;
  const now = await $.clock.now();
  const previous = latestBudget;
  paceSamples = trackPace(paceSamples, limits, now);
  latestBudget = budgetWindow(limits, now, cfg);
  if (!latestBudget) { pauseAfterTurn = false; if (previous) await save($); return; }
  // Retain only active window keys. A later window can warn again.
  const keys = new Set((limits ?? []).map(w => `${w.kind}:${w.resetsAt}`));
  warned = Object.fromEntries(Object.entries(warned).filter(([k]) => keys.has(k)));
  if (JSON.stringify(previous) !== JSON.stringify(latestBudget)) await save($);
}

export function register(on, options = {}) {
  cfg = settings(options);
  on('session.start', async ($, e, next) => {
    // Desktop can start its SDK host before attaching the graphical client.
    interactive = e.surface === 'desktop' || (e.isInteractive && e.surface === 'terminal');
    const result = await next(e);
    if (!interactive) interactive = (await $.session.surfaces()).includes('desktop');
    await $.command.register({ name: 'limit-resume', description: say('commandDescription'), argumentHint: 'on | arm | at HH:MM | off | reserve | status | checkpoint', immediate: true });
    await ensureSession($);
    if (enabled && monitor && interactive) await registerCheckpoint($);
    return result;
  });

  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    const result = await next(e);
    interactive = true;
    await ensureSession($);
    return result;
  });

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e);
    if (!e.agent_id && interactive) {
      working = false;
      const text = e.last_assistant_message ?? '';
      if (['rate_limit', 'billing_error'].includes(e.error) && isLimitError(text)) {
        lastError = text;
        await arm($, text);
      }
    }
    return result;
  });

  on('session.append', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && e.origin.kind === 'model' && e.origin.model === '<synthetic>') {
      const text = e.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (isLimitError(text)) lastError = text;
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || !interactive) return result;
    working = false;
    ownSubmission = false;
    if (e.reason === 'error' && !e.isAborted) {
      await arm($, isLimitError(e.answer) ? e.answer : lastError);
    } else {
      lastError = '';
      if (pauseAfterTurn && enabled && monitor && e.reason === 'answer' && latestBudget) {
        pauseAfterTurn = false;
        await arm($, '', true, latestBudget.resetAt, true);
        return result;
      }
      await cancel($, null);
      status = say(enabled ? 'ready' : 'offStatus');
    }
    return result;
  });

  on('prompt.submit', async ($, e, next) => {
    // Desktop may send a custom slash command as client-composed text.
    // Only a standalone command from the human-facing transport is local.
    const local = /^\/limit-resume(?:[ \t]+([^\r\n]*))?[ \t]*$/.exec(e.text);
    if (local && !e.attachments?.length && ['composer', 'sdk', 'bridge'].includes(e.origin.kind)) {
      interactive = true;
      const reply = await control($, local[1] ?? 'status');
      return { drop: reply.text };
    }
    if (interactive && !(e.origin.kind === 'plugin' && e.origin.name === 'limit-resume')) {
      ownSubmission = false;
      pauseAfterTurn = false;
      lastError = '';
      await cancel($, pending ? say('otherRequest') : null);
    }
    if (interactive && enabled && monitor) {
      // The budget line is advisory: a failed read must never block the owner's message.
      let line = null;
      try {
        await ensureSession($);
        const [usage, now] = [await $.session.usage(), await $.clock.now()];
        paceSamples = trackPace(paceSamples, usage.rateLimits, now);
        line = budgetLine(usage.rateLimits, now, paceSamples, cfg);
      } catch {}
      if (line) return next({ ...e, context: [...(e.context ?? []), line] });
    }
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    if (!e.agentId && interactive) {
      await ensureSession($);
      const ours = ownSubmission;
      // Any turn that is not our continuation is new work: a checkpoint saved
      // before it describes an older task.
      if (!ours) ownerTurn += 1;
      cancelTimer();
      if (!ours) attempts = 0;
      working = true;
      lastError = '';
      await save($);
    }
    return next(e);
  });

  on('prompt.edit', async ($, e, next) => {
    if ((pending || ownSubmission) && (e.text?.trim() || e.inputText?.trim())) {
      ownSubmission = false;
      await cancel($, say('editing'));
    }
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    const waiting = pending;
    cancelTimer();
    if (e.reason === 'other' && waiting) pending = waiting;
    await save($);
    sessionId = null;
    working = false;
    return next(e);
  });

  on('command.run', { command: 'limit-resume' }, ($, e) => control($, e.args));

  on('session.measure', async ($, e, next) => {
    const result = await next(e);
    await measureBudget($, e.rateLimits);
    return result;
  });

  on('tool.call', async ($, e, next) => {
    if (e.tool === CHECKPOINT_TOOL) {
      if (e.agentId || !interactive || !enabled || !monitor) return { deny: say('denyOff') };
      const summary = cleanCheckpoint(e);
      if (!CONTINUATIONS.includes(e.continuation)) return { deny: say('denyContinuation') };
      if (typeof e.verifyFirst !== 'boolean') return { deny: say('denyVerify') };
      if (!summary) return { deny: say('denyFields') };
      const now = await $.clock.now();
      const usage = await $.session.usage();
      await measureBudget($, usage.rateLimits);
      checkpoint = { sessionId, turn: ownerTurn, savedAt: new Date(now).toISOString(), ...summary, continuation: e.continuation, verifyFirst: e.verifyFirst };
      pauseAfterTurn = e.continuation === 'auto' && latestBudget?.level === RESERVE && !reserved;
      await save($);
      await show($, say(pauseAfterTurn ? 'savedPause' : 'saved'));
      // A registered tool answers with text: the engine refuses an object as its output.
      const result = say('savedResult', { at: checkpoint.savedAt });
      return pauseAfterTurn ? { result, context: [say('savedContext')] } : { result };
    }
    const result = await next(e);
    if (!e.agentId && interactive && enabled && monitor && !result.deny) {
      const usage = await $.session.usage();
      await measureBudget($, usage.rateLimits);
      if (latestBudget && (warned[latestBudget.key] ?? 0) < latestBudget.level) {
        warned[latestBudget.key] = latestBudget.level;
        await save($);
        await show($, latestBudget.level === RESERVE && !reserved ? say('warnReserve', { pct: latestBudget.percent, name: cfg.reserveFor }) : say('warn', { pct: latestBudget.percent }));
        return { ...result, context: [...(result.context ?? []), checkpointNotice(latestBudget, reserved, cfg)] };
      }
    }
    return result;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'desktop') { interactive = true; await ensureSession($); }
    const base = await next(e);
    // A band in every session would be noise: show it while waiting or from 70%.
    if ((!pending && !(enabled && latestBudget)) || e.props.hasSurvey) return base;
    const { Box, Text, Button } = $.ui.resolve(e);
    return h(Box, { flexDirection: 'column' }, base,
      h(Box, { flexDirection: 'row', columnGap: 1 },
        h(Text, { color: 'warning' }, pending ? say('band', { time: timeLabel(pending.deadline) }) : `limit-resume: ${status || say('ready')}`),
        h(Button, { key: 'limit-resume-cancel', label: say('cancel'), onPress: async () => { optedOut = true; enabled = false; monitor = false; selectedForBackground = false; pauseAfterTurn = false; await cancel($, say('off')); } })));
  });
}
