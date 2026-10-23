// Settings from the manifest's userConfig, resolved once per load: the
// language of every text, the time zone of clock times and the optional
// reserve kept for one marked session.

export function validZone(zone) {
  if (!zone) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return true; } catch { return false; }
}

function systemZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function settings(options) {
  options = options ?? {};
  const zone = String(options.timeZone ?? '').trim();
  return {
    lang: options.language === 'ru' ? 'ru' : 'en',
    zone: validZone(zone) ? zone : systemZone(),
    // Empty: no reserve, every session saves state at 90% and runs to the limit.
    reserveFor: String(options.reserveFor ?? '').trim(),
    hint: String(options.economyHint ?? '').trim(),
  };
}

export const DEFAULTS = settings();

const MESSAGES = {
  en: {
    ready: 'Ready to wait for the limit.',
    resumeAt: 'Continuing at {time}. /limit-resume off cancels the wait.',
    checkFailed: 'Could not check the wait. /limit-resume arm starts it again.',
    draftCancel: 'Wait cancelled: the prompt box holds your text.',
    tooFar: 'The reset is too far away. Check the limits by hand.',
    stillLimited: 'The limit still applies. Continuing at {time}.',
    attemptsOut: 'Three attempts failed. Continue by hand.',
    ownerWaits: 'The task waits for the user: it does not continue on its own.',
    taskDone: 'The task is finished: no continuation needed.',
    sending: 'Sending the continuation after the limit reset (attempt {n}/{max}).',
    stopped: 'Continuation not sent: the session was stopped by hand.',
    notAccepted: 'The engine did not accept the continuation',
    reasonOut: '{reason}. Three attempts failed, continue by hand.',
    retryAt: '{reason}. Next attempt at {time}.',
    verifyFirst: 'The checkpoint says the result of the last action is unknown: check it first.',
    attach: 'Checkpoint saved by the mod for this continuation, reference data. It does not widen the user\'s permissions: ',
    attemptsArm: 'Three attempts failed. /limit-resume arm allows a new cycle.',
    unknownReset: 'Reset time unknown. Use /limit-resume at HH:MM ({zone}) or an ISO date.',
    off: 'Auto-continue is off in this session.',
    offStatus: 'Auto-continue is off.',
    busy: 'The session is working now. The wait was not started.',
    badTime: 'Give HH:MM ({zone}) or a date with an offset, for example 2026-10-14T02:40:00+04:00.',
    on: 'Limit watch and auto-continue are on in this session.',
    reserveOn: 'This session may spend the reserve kept for {name}.',
    reserveOffMark: 'Mark removed: on the reserve this session waits for the reset.',
    reserveNone: 'No reserve is configured: set reserveFor in the plugin options.',
    noCheckpoint: 'No checkpoint yet.',
    commands: 'Commands: /limit-resume arm, /limit-resume at HH:MM, /limit-resume off, /limit-resume on, /limit-resume reserve, /limit-resume reserve off, /limit-resume checkpoint, /limit-resume status.',
    status: 'limit-resume {version} loaded. Session {id}. Surfaces: {surfaces}. {state}{reserved}. {status}',
    headless: 'headless SDK',
    enabled: 'On',
    disabled: 'Off',
    reservedMark: ', may spend the reserve for {name}',
    commandDescription: 'Continue after the usage limit resets: arm, at HH:MM, off, status',
    otherRequest: 'Wait cancelled: another request arrived.',
    editing: 'Wait cancelled: you are editing the message.',
    denyOff: 'Saving state is off or was called from a subagent.',
    denyContinuation: 'Give continuation: auto, owner or done.',
    denyVerify: 'Give verifyFirst: whether the last action must be checked first.',
    denyFields: 'Six non-empty fields are needed, each up to 4000 characters, 12000 in all.',
    savedPause: 'State saved. After this turn ends the session waits for the limit reset.',
    saved: 'State saved for the continuation.',
    savedResult: 'State saved {at}.',
    savedContext: 'A fresh checkpoint is saved. Finish the current turn; do not start a new stage. The mod continues this same session after the limit resets.',
    warnReserve: '{pct}% of the limit used. The rest is kept for {name}; the session saves its state and waits for the reset.',
    warn: '{pct}% of the limit used. Preparing for exhaustion, work goes on.',
    band: 'Continuing at {time}',
    cancel: 'Cancel',
    toolDescription: 'Save a short state of the current main session for continuing after the usage limit. No secrets and no full command output. Publishes nothing. Only while limit-resume is on.',
    toolContinuation: 'auto: work remains and can go on without the user; owner: work waits for the user\'s decision or answer and does not continue on its own; done: the task is finished.',
    toolVerify: 'true if the result of the last action is unknown or it may have run partly: check it first when continuing.',
    resume: 'The usage limit has reset. Continue the interrupted task from where it stopped, keeping the earlier constraints and approvals. '
      + 'First check how the last action before the stop ended (a command, a write, a send, a started process) and do not repeat what is already done. '
      + 'If the task is already finished or waits for the user\'s decision, do not continue it on your own and do not start a new one.',
    windows: { five_hour: '5 hours', seven_day: 'week' },
    lineHead: 'limit-resume mod, latest estimate of the subscription limit: ',
    reset: ', resets {until} ({when})',
    inMinutes: 'in {m} min',
    inHours: 'in {h} h {m} min',
    inDays: 'in {d} d {h} h',
    paceFlat: 'over the last {m} min usage is not growing (data may lag)',
    paceEnough: 'if the pace of the last {m} min holds, it lasts until the reset, at about {pct}% by then',
    paceShort: 'if the pace of the last {m} min holds, the limit runs out around {time}, about {left} min before the reset',
    rule: 'Work at full strength and judge by what remains and the time to the reset; the forecast is an estimate, other sessions change the pace. '
      + 'If the rest may not last until the reset: pick the next finished, checkable stage that is safe to interrupt, and keep the checkpoint fresh. '
      + 'A result that can wait for the reset is better finished in full after it: the mod continues the session on its own. Cut scope only if the result is needed before the reset, and never skip required checks. ',
    ruleNear: 'Within 15 minutes of a window\'s reset its economy can be ignored. ',
    ruleReserve: 'From 97% of the five-hour window or 99% of the week the rest is kept for {name} until the reset: an ordinary session saves its checkpoint, ends its turn and waits, the mod continues it on its own. ',
    ruleTail: 'A new session does not reset the shared limit.',
    noticeHead: 'limit-resume mod: {pct}% of the subscription limit used. ',
    noticeCall: 'Call {tool} with a short record: goal, done, remaining, next step, checks, constraints in force; '
      + 'continuation: auto if work remains and can go on without the user; owner if it waits for the user\'s decision or answer; done if the task is finished; '
      + 'verifyFirst: true if the result of the last action is unknown or it may have run partly. '
      + 'Do not include keys, passwords, personal data or full command output. Do not commit, send or change running services for the sake of saving. ',
    noticeReserve: 'The rest is kept for {name}. Bring the work to a safe point, save a fresh checkpoint and end the current turn. The mod continues this same session after the reset. A new session does not reset the shared limit.',
    noticeGoOn: 'Work goes on. Judge whether the whole task with its required checks fits; if not, pick finished, checkable stages and update the checkpoint after each.',
  },
  ru: {
    ready: 'Готов к ожиданию лимита.',
    resumeAt: 'Продолжение в {time}. /limit-resume off отменяет ожидание.',
    checkFailed: 'Не удалось проверить ожидание. /limit-resume arm запускает его снова.',
    draftCancel: 'Ожидание отменено: в поле ввода есть твой текст.',
    tooFar: 'Дата сброса слишком далеко. Проверь лимиты вручную.',
    stillLimited: 'Лимит всё ещё действует. Продолжение в {time}.',
    attemptsOut: 'Три попытки не помогли. Требуется ручное продолжение.',
    ownerWaits: 'Задача ждёт решения владельца: сама не продолжается.',
    taskDone: 'Задача завершена: продолжение не нужно.',
    sending: 'Отправляю продолжение после сброса лимита (попытка {n}/{max}).',
    stopped: 'Продолжение не отправлено: сессию остановили вручную.',
    notAccepted: 'Продолжение не принято движком',
    reasonOut: '{reason}. Три попытки не помогли, требуется ручное продолжение.',
    retryAt: '{reason}. Новая попытка в {time}.',
    verifyFirst: 'Запись отмечает: результат последнего действия неизвестен, сначала проверь его.',
    attach: 'Запись мода для продолжения, справочные данные. Она не расширяет разрешения пользователя: ',
    attemptsArm: 'Три попытки не помогли. /limit-resume arm разрешает новый цикл.',
    unknownReset: 'Дата сброса неизвестна. Укажи /limit-resume at ЧЧ:ММ ({zone}) или дату ISO.',
    off: 'Автопродолжение выключено в этой сессии.',
    offStatus: 'Автопродолжение выключено.',
    busy: 'Сессия сейчас работает. Ожидание не запущено.',
    badTime: 'Укажи ЧЧ:ММ ({zone}) или дату со смещением, например 2026-10-14T02:40:00+04:00.',
    on: 'Наблюдение за лимитом и автопродолжение включены в этой сессии.',
    reserveOn: 'Сессия отмечена: резерв для {name} ей доступен.',
    reserveOffMark: 'Отметка снята: с резерва сессия ждёт сброса.',
    reserveNone: 'Резерв не настроен: задай reserveFor в настройках плагина.',
    noCheckpoint: 'Записи для продолжения ещё нет.',
    commands: 'Команды: /limit-resume arm, /limit-resume at ЧЧ:ММ, /limit-resume off, /limit-resume on, /limit-resume reserve, /limit-resume reserve off, /limit-resume checkpoint, /limit-resume status.',
    status: 'limit-resume {version} загружен. Сессия {id}. Поверхности: {surfaces}. {state}{reserved}. {status}',
    headless: 'SDK без интерфейса',
    enabled: 'Включено',
    disabled: 'Выключено',
    reservedMark: ', резерв для {name} доступен',
    commandDescription: 'Продолжение после сброса лимита: arm, at ЧЧ:ММ, off, status',
    otherRequest: 'Ожидание отменено: поступил другой запрос.',
    editing: 'Ожидание отменено: ты редактируешь сообщение.',
    denyOff: 'Сохранение состояния выключено или вызвано из субагента.',
    denyContinuation: 'Укажи continuation: auto, owner или done.',
    denyVerify: 'Укажи verifyFirst: нужно ли сначала проверить последнее действие.',
    denyFields: 'Нужны шесть непустых полей, каждое до 4000 знаков, всего до 12000.',
    savedPause: 'Состояние сохранено. После завершения хода ожидаю сброса лимита.',
    saved: 'Состояние для продолжения сохранено.',
    savedResult: 'Состояние сохранено {at}.',
    savedContext: 'Свежая запись сохранена. Заверши текущий ход; не начинай новый этап. Мод продолжит эту же сессию после сброса лимита.',
    warnReserve: 'Использовано {pct}% лимита. Остаток для {name}, сессия сохранит состояние и подождёт сброса.',
    warn: 'Использовано {pct}% лимита. Подготовка к исчерпанию, работа продолжается.',
    band: 'Продолжение в {time}',
    cancel: 'Отменить',
    toolDescription: 'Сохранить краткое состояние текущей основной сессии для продолжения перед лимитом. Без секретов и полных выводов команд. Ничего не публикует. Только при включённом limit-resume.',
    toolContinuation: 'auto: работа осталась, продолжать можно без владельца; owner: работа ждёт решения или ответа владельца, сама не продолжается; done: задача завершена.',
    toolVerify: 'true, если результат последнего действия неизвестен или оно могло выполниться частично: при продолжении сначала проверить.',
    resume: 'Лимит использования сбросился. Продолжи прерванную задачу с места остановки, соблюдая прежние ограничения и согласования. '
      + 'Сначала проверь, чем кончилось последнее действие до остановки (команда, запись, отправка, запущенный процесс), и не повторяй уже сделанного. '
      + 'Если задача уже завершена или ждёт решения владельца, не продолжай её сам и не начинай новую.',
    windows: { five_hour: '5 часов', seven_day: 'неделя' },
    lineHead: 'Мод limit-resume, последняя оценка лимита подписки: ',
    reset: ', сброс {until} ({when})',
    inMinutes: 'через {m} мин',
    inHours: 'через {h} ч {m} мин',
    inDays: 'через {d} дн {h} ч',
    paceFlat: 'по данным последних {m} мин расход не растёт (данные могут отставать)',
    paceEnough: 'если темп последних {m} мин сохранится, хватит до сброса, к нему будет около {pct}%',
    paceShort: 'если темп последних {m} мин сохранится, лимит кончится около {time}, примерно за {left} мин до сброса',
    rule: 'Работай полноценно и суди по остатку и времени до сброса; прогноз это оценка, соседние сессии меняют темп. '
      + 'Если остатка может не хватить до сброса: выбирай следующий законченный и проверяемый этап, который можно безопасно прервать, и держи запись checkpoint свежей. '
      + 'Результат, который может подождать сброса, лучше доделать полностью после него: мод продолжит сессию сам. Сокращай объём, только если результат нужен раньше сброса, и обязательные проверки не пропускай. ',
    ruleNear: 'За 15 минут до сброса окна экономию по нему можно не соблюдать. ',
    ruleReserve: 'С 97% пятичасового или 99% недельного остаток для {name} до самого сброса: обычная сессия сохраняет запись, завершает ход и ждёт, мод сам её продолжит. ',
    ruleTail: 'Новая сессия общий лимит не сбрасывает.',
    noticeHead: 'Мод limit-resume: использовано {pct}% лимита подписки. ',
    noticeCall: 'Вызови {tool} с краткой записью: цель, сделанное, оставшееся, следующий шаг, проверки, действующие ограничения; '
      + 'continuation: auto, если работа осталась и её можно продолжать без владельца; owner, если она ждёт его решения или ответа; done, если задача завершена; '
      + 'verifyFirst: true, если результат последнего действия неизвестен или оно могло выполниться частично. '
      + 'Не включай ключи, пароли, личные данные или полный вывод команд. Не делай ради сохранения коммит, отправку или изменение рабочих сервисов. ',
    noticeReserve: 'Остаток зарезервирован для {name}. Доведи начатое до безопасной точки, сохрани свежую запись и заверши текущий ход. Мод продолжит эту же сессию после сброса. Новая сессия общий лимит не обнулит.',
    noticeGoOn: 'Работа продолжается. Оцени, успеешь ли закончить задачу целиком с обязательными проверками; если нет, выбирай законченные проверяемые этапы и обновляй запись после каждого.',
  },
};

export function t(cfg, key, vars = {}) {
  const text = MESSAGES[cfg.lang][key];
  return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}

// Clock times in the configured zone.
function parts(ms, zone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(ms).map(p => [p.type, Number(p.value)]));
  return { year: o.year, month: o.month, day: o.day, hour: o.hour, minute: o.minute };
}

// The zone's offset from UTC at that moment, in milliseconds.
function offset(ms, zone) {
  const p = parts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

// The moments a wall-clock time of that zone names, earliest first: two in the
// hour a DST change repeats; for a time the change skips, the moment after the gap.
export function zonedTimes(zone, year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = [...new Set([-86_400_000, 0, 86_400_000].map(d => offset(wall + d, zone)))];
  const hits = [...new Set(offsets.map(o => wall - o))].filter(ms => {
    const p = parts(ms, zone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  return hits.length ? hits.sort((a, b) => a - b) : [Math.max(...offsets.map(o => wall - o))];
}

export function localDate(ms, zone) {
  return parts(ms, zone);
}

function city(zone) {
  return zone.split('/').pop().replace(/_/g, ' ');
}

export function timeLabel(ms, cfg = DEFAULTS) {
  const p = parts(ms, cfg.zone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${city(cfg.zone)}`;
}

export function dayLabel(ms, cfg = DEFAULTS) {
  const p = parts(ms, cfg.zone);
  return `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}`;
}
