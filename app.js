"use strict";

const KEY = "codec-pomodoro-v1";
const RING_R = 92;
const RING_C = 2 * Math.PI * RING_R;

const PHASE = {
  focus: {
    label: "INFILTRACIÓN",
    freq: "140.85",
    line: "Canal listo. Elige un blanco y entra.",
    start: "Infiltración en curso. Corta el ruido.",
    banner: ["FASE CLEAR", "Infiltración registrada"],
  },
  short: {
    label: "PAUSA TÁCTICA",
    freq: "141.12",
    line: "Pausa corta. No abras otro frente.",
    start: "Pausa táctica. Recupera el pulso.",
    banner: ["CANAL LIBRE", "La pausa terminó"],
  },
  long: {
    label: "EXTRACCIÓN",
    freq: "141.80",
    line: "Ciclo largo. Aléjate del objetivo.",
    start: "Extracción. El ciclo quedó cerrado.",
    banner: ["CICLO CERRADO", "Extracción completa"],
  },
};

const PRIO = { routine: "RUTINA", priority: "PRIORIDAD", urgent: "URGENTE" };

const DEFAULTS = {
  settings: {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    cycleLength: 4,
    dailyGoal: 8,
    autoStart: false,
    sound: true,
    notify: false,
    autoClose: true,
    strict: false,
    callsign: "SNAKE",
  },
  missions: [],
  activeMissionId: null,
  phase: "focus",
  remaining: 25 * 60,
  planned: 25 * 60,
  running: false,
  endsAt: null,
  cyclePos: 0,
  cycleCharged: false,
  day: "",
  focusCountToday: 0,
  focusSecondsToday: 0,
  streak: 0,
  lastFocusDay: "",
  lifetimeFocus: 0,
  sessionInterrupts: { internal: 0, external: 0 },
  blockExtra: 0,
  history: [],
};

const ui = {
  filter: "open",
  editing: null,
  focusEdit: false,
  estimate: 1,
  priority: "routine",
  talkTimer: null,
  bannerTimer: null,
  glitchTimer: null,
  glitching: false,
  completing: false,
  armKey: null,
  armTimer: null,
  month: "",
  day: "",
  metrics: null,
  metricsLoading: false,
  metricsError: false,
  adding: null,
};

let state = structuredClone(DEFAULTS);
let booted = false;
let ready = false;
let expiredOnLoad = false;
let autoToken = 0;
let audioCtx = null;

const $ = (sel) => document.querySelector(sel);

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.min(b, Math.max(a, Math.round(n)));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function keyFromDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayKey() {
  return keyFromDate(new Date());
}

function shiftKey(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return keyFromDate(dt);
}

function fmt(sec) {
  const s = Math.max(0, sec | 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${pad(m)}:${pad(r)}`;
}

function fmtSpan(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function shiftMonth(key, delta) {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function monthRange(key) {
  const [year, month] = key.split("-").map(Number);
  return {
    from: new Date(year, month - 1, 1).getTime(),
    to: new Date(year, month, 1).getTime(),
  };
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("es", { month: "long", year: "numeric" }).toUpperCase();
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDay(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function startOfWeek(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

function heatWindow(month) {
  const [year, index] = month.split("-").map(Number);
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const monthEnd = new Date(year, index, 0);
  const end = monthEnd < todayStart ? monthEnd : todayStart;
  const start = startOfWeek(addDays(end, -364));
  return { start, end, from: start.getTime(), to: addDays(end, 1).getTime() };
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function blockLabel(count) {
  return `${count} ${count === 1 ? "bloque" : "bloques"}`;
}

function heatLevel(seconds) {
  if (seconds <= 0) return 0;
  if (seconds < 25 * 60) return 1;
  if (seconds < 60 * 60) return 2;
  if (seconds < 2 * 60 * 60) return 3;
  return 4;
}

function heatTip(date, info) {
  const when = date.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }).replace(".", "");
  if (!info || info.seconds <= 0) return `${when}: sin tiempo`;
  const extra = info.addedSeconds > 0 ? ` · +${fmtLong(info.addedSeconds)} añadidos` : "";
  return `${when}: ${fmtLong(info.seconds)} · ${blockLabel(info.blocks)}${extra}`;
}

function extendBlock(minutes) {
  if (state.phase !== "focus") {
    say("El tiempo extra se suma durante la infiltración.");
    return;
  }
  const room = 180 * 60 - state.planned;
  if (room < 60) {
    say("El bloque ya está al máximo.");
    return;
  }
  const seconds = Math.min(minutes * 60, room);
  state.remaining += seconds;
  state.planned += seconds;
  state.blockExtra = (state.blockExtra || 0) + seconds;
  if (state.running && state.endsAt) state.endsAt += seconds * 1000;
  save();
  renderStatic();
  paintTime();
  say(`+${fmtSpan(seconds)} en el bloque. Entran al mes cuando lo cierres.`);
}

function addMinutes(id, minutes) {
  const mission = byId(id);
  if (!mission) return;
  const seconds = minutes * 60;
  mission.addedSeconds = (mission.addedSeconds || 0) + seconds;
  const now = Date.now();
  if (keyFromDate(new Date(now)) === todayKey()) state.focusSecondsToday += seconds;
  pushHistory({
    phase: "extra",
    kind: "extra",
    title: mission.title,
    missionId: mission.id,
    seconds,
    at: now,
  });
  ui.adding = null;
  save();
  say(`+${minutes} min añadidos a ${mission.title}. El mes los incluye.`);
  renderStatic();
  renderLists();
}

let metricsToken = 0;

async function loadMetrics() {
  const token = ++metricsToken;
  const month = ui.month || currentMonthKey();
  ui.month = month;
  if (ui.day && ui.day.slice(0, 7) !== month) ui.day = "";
  const span = heatWindow(month);
  const focus = ui.day
    ? { from: parseDay(ui.day).getTime(), to: addDays(parseDay(ui.day), 1).getTime() }
    : monthRange(month);
  const { from, to } = focus;
  ui.metricsLoading = true;
  ui.metricsError = false;
  if (ui.filter === "metrics") renderMetrics();
  try {
    const response = await fetch(`/api/metrics?from=${from}&to=${to}&spanFrom=${span.from}&spanTo=${span.to}&tz=${encodeURIComponent(timeZone())}`);
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (token !== metricsToken) return;
    ui.metrics = data;
    ui.metricsLoading = false;
  } catch {
    if (token !== metricsToken) return;
    ui.metrics = null;
    ui.metricsLoading = false;
    ui.metricsError = true;
  }
  if (ui.filter === "metrics") renderMetrics();
}

function purgeHistory() {
  state.history = [];
  state.blockExtra = 0;
  state.missions.forEach((mission) => { mission.addedSeconds = 0; });
  const snapshot = structuredClone(state);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (!dbOnline) return;
    const response = await fetch("/api/sessions", { method: "DELETE" });
    if (!response.ok) throw new Error(String(response.status));
    await persist(snapshot);
    if (ui.filter === "metrics") await loadMetrics();
  }).catch(() => {
    say("No se pudo purgar el historial.");
  });
  say("Historial purgado.");
  renderStatic();
  renderLists();
}

function fmtLong(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m`;
}

function phaseSeconds(phase) {
  const mins = phase === "short" ? state.settings.shortMin : phase === "long" ? state.settings.longMin : state.settings.focusMin;
  return mins * 60;
}

function byId(id) {
  return state.missions.find((m) => m.id === id);
}

let dbOnline = true;
let saveQueue = Promise.resolve();

function readLegacy() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function readRemote() {
  const response = await fetch("/api/state", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(String(response.status));
  const body = await response.json();
  return body.state ?? null;
}

async function persist(snapshot) {
  const response = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw new Error(String(response.status));
}

function save() {
  if (!dbOnline) return;
  const snapshot = structuredClone(state);
  saveQueue = saveQueue
    .catch(() => {})
    .then(() => persist(snapshot))
    .then(() => {
      if (ui.filter === "metrics") return loadMetrics();
    })
    .catch(() => {
      say("La base no confirmó el último registro.");
    });
}

function cleanCallsign(value) {
  const text = String(value || "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .slice(0, 12);
  return text || "SNAKE";
}

function normalize(data) {
  const src = data && typeof data === "object" ? data : {};
  const settings = { ...DEFAULTS.settings, ...(src.settings || {}) };
  settings.focusMin = clamp(settings.focusMin, 1, 180);
  settings.shortMin = clamp(settings.shortMin, 1, 60);
  settings.longMin = clamp(settings.longMin, 1, 90);
  settings.cycleLength = clamp(settings.cycleLength, 2, 8);
  settings.dailyGoal = clamp(settings.dailyGoal, 1, 20);
  settings.autoStart = Boolean(settings.autoStart);
  settings.sound = settings.sound !== false;
  settings.notify = Boolean(settings.notify);
  settings.autoClose = settings.autoClose !== false;
  settings.strict = Boolean(settings.strict);
  settings.callsign = cleanCallsign(settings.callsign);

  const missions = (Array.isArray(src.missions) ? src.missions : []).filter((m) => m && m.id && m.title).map((m, i) => ({
    id: String(m.id),
    title: String(m.title).slice(0, 80),
    notes: String(m.notes || "").slice(0, 140),
    estimate: clamp(m.estimate || 1, 1, 12),
    donePoms: Math.max(0, m.donePoms | 0),
    addedSeconds: Math.max(0, m.addedSeconds | 0),
    priority: PRIO[m.priority] ? m.priority : "routine",
    status: m.status === "done" ? "done" : "open",
    order: Number.isFinite(m.order) ? m.order : i,
    created: m.created || Date.now(),
  }));

  const phase = PHASE[src.phase] ? src.phase : "focus";
  const plannedDefault = (phase === "short" ? settings.shortMin : phase === "long" ? settings.longMin : settings.focusMin) * 60;
  const si = src.sessionInterrupts || {};

  const next = {
    ...structuredClone(DEFAULTS),
    ...src,
    settings,
    missions,
    phase,
    activeMissionId: missions.some((m) => m.id === src.activeMissionId) ? src.activeMissionId : null,
    remaining: clamp(src.remaining ?? plannedDefault, 0, 180 * 60),
    planned: clamp(src.planned || plannedDefault, 1, 180 * 60),
    running: Boolean(src.running),
    endsAt: Number.isFinite(src.endsAt) ? src.endsAt : null,
    cyclePos: Math.max(0, src.cyclePos | 0),
    cycleCharged: Boolean(src.cycleCharged),
    day: src.day || "",
    focusCountToday: Math.max(0, src.focusCountToday | 0),
    focusSecondsToday: Math.max(0, src.focusSecondsToday | 0),
    streak: Math.max(0, src.streak | 0),
    lastFocusDay: src.lastFocusDay || "",
    lifetimeFocus: Math.max(0, src.lifetimeFocus | 0),
    blockExtra: Math.max(0, src.blockExtra | 0),
    sessionInterrupts: {
      internal: Math.max(0, si.internal | 0),
      external: Math.max(0, si.external | 0),
    },
    history: (Array.isArray(src.history) ? src.history : []).slice(-400).map((h) => ({
      id: String(h.id || uid()),
      phase: h.phase === "extra" ? "extra" : (PHASE[h.phase] ? h.phase : "focus"),
      title: String(h.title || "Sin blanco").slice(0, 80),
      seconds: Math.max(0, h.seconds | 0),
      internal: Math.max(0, h.internal | 0),
      external: Math.max(0, h.external | 0),
      at: h.at || Date.now(),
      missionId: h.missionId ? String(h.missionId).slice(0, 40) : null,
      kind: h.kind === "extra" || h.phase === "extra" ? "extra" : "block",
      extraSeconds: Math.max(0, h.extraSeconds | 0),
    })),
  };

  if (next.cyclePos > settings.cycleLength) next.cyclePos = 0;
  if (next.running && !next.endsAt) next.running = false;
  next.missions.sort((a, b) => a.order - b.order || a.created - b.created);
  next.missions.forEach((m, i) => { m.order = i; });
  return next;
}

function rollover() {
  const today = todayKey();
  if (!state.day) {
    state.day = today;
    return false;
  }
  if (state.day === today) return false;
  state.day = today;
  state.focusCountToday = 0;
  state.focusSecondsToday = 0;
  return true;
}

function effectiveStreak() {
  if (!state.lastFocusDay) return 0;
  const today = todayKey();
  if (state.lastFocusDay === today || state.lastFocusDay === shiftKey(today, -1)) return state.streak;
  return 0;
}

function noteFocusDay(dayKey) {
  if (state.lastFocusDay === dayKey) return;
  const prev = shiftKey(dayKey, -1);
  state.streak = state.lastFocusDay === prev ? state.streak + 1 : 1;
  state.lastFocusDay = dayKey;
}

function say(text) {
  $("#codec").textContent = text;
  const wave = $("#wave");
  wave.classList.add("talking");
  clearTimeout(ui.talkTimer);
  ui.talkTimer = setTimeout(() => wave.classList.remove("talking"), 2200);
}

function shake(el) {
  if (!el) return;
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

function audio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function tone(ctx, freq, t, dur, type, gain) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function safeAudio(fn) {
  if (!state.settings.sound) return;
  try { fn(); } catch { /* sin audio */ }
}

function playStart() {
  safeAudio(() => {
    const ctx = audio();
    const t = ctx.currentTime;
    tone(ctx, 880, t, 0.06, "square", 0.04);
    tone(ctx, 1320, t + 0.08, 0.1, "square", 0.045);
  });
}

function playClear(phase) {
  safeAudio(() => {
    const ctx = audio();
    const t = ctx.currentTime;
    if (phase === "focus") {
      tone(ctx, 740, t, 0.09, "square", 0.05);
      tone(ctx, 620, t + 0.11, 0.09, "square", 0.05);
      tone(ctx, 494, t + 0.22, 0.16, "square", 0.05);
    } else {
      tone(ctx, 523, t, 0.1, "sine", 0.05);
      tone(ctx, 784, t + 0.12, 0.16, "sine", 0.05);
    }
  });
}

function playHit() {
  safeAudio(() => {
    const ctx = audio();
    tone(ctx, 240, ctx.currentTime, 0.08, "square", 0.04);
  });
}

function notify(title, body) {
  if (!state.settings.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(title, { body }); } catch { /* permiso revocado */ }
}

function glitch() {
  const el = $("#freq");
  const finalText = PHASE[state.phase].freq;
  let n = 0;
  ui.glitching = true;
  clearInterval(ui.glitchTimer);
  ui.glitchTimer = setInterval(() => {
    el.textContent = (120 + Math.random() * 30).toFixed(2);
    n += 1;
    if (n > 7) {
      clearInterval(ui.glitchTimer);
      ui.glitching = false;
      el.textContent = finalText;
    }
  }, 45);
}

function showBanner(title, sub, opts = {}) {
  $("#banner-title").textContent = title;
  $("#banner-sub").textContent = sub || "";
  const gif = $("#banner-gif");
  const src = opts.image || (opts.salute ? "boss-clear.png" : "");
  if (src) {
    gif.hidden = false;
    gif.alt = opts.alt || "Saludo al cerrar la infiltración";
    gif.src = `${src}?t=${Date.now()}`;
  } else if (gif) {
    gif.hidden = true;
    gif.removeAttribute("src");
  }
  const banner = $("#banner");
  banner.classList.add("show");
  const screen = $("#screen");
  screen.classList.remove("flashing");
  void screen.offsetWidth;
  screen.classList.add("flashing");
  clearTimeout(ui.bannerTimer);
  ui.bannerTimer = setTimeout(() => {
    banner.classList.remove("show");
    if (gif) gif.hidden = true;
  }, src ? 3400 : 1700);
}

function cancelAuto() {
  autoToken += 1;
}

function scheduleAuto() {
  const token = ++autoToken;
  setTimeout(() => {
    if (token !== autoToken || state.running) return;
    start({ auto: true });
  }, 1400);
}

function pushHistory(entry) {
  state.history.push({
    id: entry.id || uid(),
    phase: entry.phase === "extra" ? "extra" : (PHASE[entry.phase] ? entry.phase : "focus"),
    title: entry.title || "Sin blanco",
    seconds: entry.seconds,
    internal: entry.internal || 0,
    external: entry.external || 0,
    at: entry.at || Date.now(),
    missionId: entry.missionId || null,
    kind: entry.kind === "extra" ? "extra" : "block",
    extraSeconds: entry.extraSeconds || 0,
  });
  if (state.history.length > 400) state.history.splice(0, state.history.length - 400);
}

function recordFocus(endedAt) {
  const ended = endedAt || Date.now();
  const key = keyFromDate(new Date(ended));
  const seconds = state.planned || phaseSeconds("focus");
  const extraSeconds = Math.min(seconds, state.blockExtra || 0);
  if (key === todayKey()) {
    state.focusCountToday += 1;
    state.focusSecondsToday += seconds;
  }
  noteFocusDay(key);
  state.lifetimeFocus += 1;

  let title = "Sin blanco";
  let closed = false;
  const mission = byId(state.activeMissionId);
  if (mission) {
    title = mission.title;
    mission.donePoms += 1;
    if (mission.status !== "done" && state.settings.autoClose && mission.donePoms >= mission.estimate) {
      mission.status = "done";
      closed = true;
      state.activeMissionId = null;
    }
  }
  pushHistory({
    phase: "focus",
    title,
    seconds,
    at: ended,
    missionId: mission?.id || null,
    kind: "block",
    extraSeconds,
    internal: state.sessionInterrupts.internal,
    external: state.sessionInterrupts.external,
  });
  state.blockExtra = 0;
  return { closed, title, extraSeconds };
}

function goNext({ record, endedAt }) {
  const finished = state.phase;
  let result = null;
  if (record && finished === "focus") result = recordFocus(endedAt);
  else if (record) {
    pushHistory({
      phase: finished,
      title: PHASE[finished].label,
      seconds: state.planned || phaseSeconds(finished),
      at: endedAt,
      kind: "block",
    });
  }

  if (finished === "focus" && record) {
    if (state.cyclePos + 1 >= state.settings.cycleLength) {
      state.cyclePos = 0;
      state.cycleCharged = true;
      state.phase = "long";
    } else {
      state.cyclePos += 1;
      state.cycleCharged = false;
      state.phase = "short";
    }
  } else if (finished === "focus") {
    state.cycleCharged = false;
    state.phase = "short";
  } else {
    state.cycleCharged = false;
    state.phase = "focus";
  }

  state.remaining = phaseSeconds(state.phase);
  state.planned = state.remaining;
  state.blockExtra = 0;
  state.sessionInterrupts = { internal: 0, external: 0 };
  return { finished, result };
}

function announce(finished, result) {
  const [title, sub] = PHASE[finished].banner;
  const line = result?.closed
    ? `Objetivo cumplido · ${result.title}`
    : (result?.extraSeconds ? `${sub} Incluye +${fmtSpan(result.extraSeconds)} añadidos.` : sub);
  showBanner(title, line, { salute: finished === "focus" });
  say(result?.closed ? `Objetivo cumplido: ${result.title}` : sub);
  playClear(finished);
  notify(title, line);
}

function completePhase(opts = {}) {
  if (ui.completing) return;
  ui.completing = true;
  cancelAuto();
  const endedAt = state.endsAt || Date.now();
  state.running = false;
  state.endsAt = null;
  const { finished, result } = goNext({ record: true, endedAt });
  save();
  announce(finished, result);
  renderStatic();
  renderLists();
  paintTime();
  glitch();
  if (state.settings.autoStart && !opts.fromLoad) scheduleAuto();
  ui.completing = false;
}

function start(opts = {}) {
  cancelAuto();
  if (state.running) return;
  if (state.remaining <= 0) state.remaining = phaseSeconds(state.phase);
  if (state.phase === "focus" && !state.activeMissionId) {
    if (state.settings.strict) {
      say("Asigna un blanco antes de infiltrarte.");
      shake($("#composer"));
      $("#task-title").focus();
      return;
    }
    say("Sin blanco asignado. El bloque contará como tiempo general.");
  } else {
    say(PHASE[state.phase].start);
  }
  const clip = freshClip();
  state.running = true;
  state.endsAt = Date.now() + state.remaining * 1000;
  if (!state.planned) state.planned = phaseSeconds(state.phase);
  save();
  playStart();
  renderStatic();
  paintTime();
  if (clip) showPhaseClip(clip);
}

const PHASE_CLIP = {
  focus: { title: "INFILTRACIÓN", image: "focus-snake.gif", alt: "Infiltración" },
  short: { title: "PAUSA TÁCTICA", image: "pause-snake.gif", alt: "Pausa táctica" },
  long: { title: "EXTRACCIÓN", image: "extract-snake.gif", alt: "Extracción" },
};

function freshClip() {
  if (!PHASE_CLIP[state.phase]) return "";
  const full = state.planned || phaseSeconds(state.phase);
  return state.remaining >= full ? state.phase : "";
}

function showPhaseClip(phase) {
  const clip = PHASE_CLIP[phase];
  if (!clip) return;
  const reveal = () => {
    if (state.phase !== phase || !state.running) return;
    showBanner(clip.title, PHASE[phase].start, { image: clip.image, alt: clip.alt });
  };
  if ($("#banner").classList.contains("show")) setTimeout(reveal, 2000);
  else reveal();
}

function pause() {
  cancelAuto();
  if (!state.running) return;
  state.remaining = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
  state.running = false;
  state.endsAt = null;
  save();
  say("Reloj en espera. La misión sigue abierta.");
  renderStatic();
  paintTime();
}

function toggle() {
  if (state.running) pause();
  else start();
}

function abortTimer() {
  cancelAuto();
  state.running = false;
  state.endsAt = null;
  state.remaining = phaseSeconds(state.phase);
  state.planned = state.remaining;
  state.blockExtra = 0;
  state.sessionInterrupts = { internal: 0, external: 0 };
  save();
  say("Contador abortado.");
  renderStatic();
  paintTime();
}

function skip() {
  cancelAuto();
  state.running = false;
  state.endsAt = null;
  goNext({ record: false });
  save();
  say("Fase saltada. Sin registro.");
  glitch();
  renderStatic();
  paintTime();
}

function selectPhase(phase) {
  if (!PHASE[phase] || phase === state.phase) return;
  cancelAuto();
  state.running = false;
  state.endsAt = null;
  state.phase = phase;
  if (phase !== "long") state.cycleCharged = false;
  state.remaining = phaseSeconds(phase);
  state.planned = state.remaining;
  state.blockExtra = 0;
  state.sessionInterrupts = { internal: 0, external: 0 };
  save();
  say(PHASE[phase].line);
  glitch();
  renderStatic();
  paintTime();
}

function interfere(kind) {
  if (!(state.running && state.phase === "focus")) {
    say("Las interferencias solo se marcan en infiltración en curso.");
    return;
  }
  state.sessionInterrupts[kind] += 1;
  save();
  renderStatic();
  say(kind === "internal"
    ? "Interferencia interna. Mantén el objetivo."
    : "Interferencia externa. No cambies de canal.");
  playHit();
}

function visibleMissions() {
  return state.missions
    .filter((m) => (ui.filter === "done" ? m.status === "done" : m.status !== "done"))
    .sort((a, b) => a.order - b.order);
}

function addMission(title, notes) {
  const mission = {
    id: uid(),
    title: title.slice(0, 80),
    notes: notes.slice(0, 140),
    estimate: ui.estimate,
    donePoms: 0,
    priority: ui.priority,
    status: "open",
    order: -1,
    created: Date.now(),
  };
  state.missions.push(mission);
  state.missions.sort((a, b) => a.order - b.order || a.created - b.created);
  state.missions.forEach((m, i) => { m.order = i; });
  const pinned = !state.activeMissionId;
  if (pinned) state.activeMissionId = mission.id;
  if (ui.filter === "done" || ui.filter === "log") ui.filter = "open";
  save();
  say(pinned ? `Blanco fijado: ${mission.title}` : "Actividad en cola.");
  renderStatic();
  renderLists();
}

function requestArm(key) {
  if (ui.armKey === key) {
    clearTimeout(ui.armTimer);
    ui.armKey = null;
    return true;
  }
  ui.armKey = key;
  clearTimeout(ui.armTimer);
  ui.armTimer = setTimeout(() => {
    ui.armKey = null;
    renderLists();
    syncPurge();
  }, 2400);
  return false;
}

function deleteMission(id) {
  state.missions = state.missions.filter((m) => m.id !== id);
  if (state.activeMissionId === id) state.activeMissionId = null;
  save();
  say("Actividad retirada del registro.");
  renderStatic();
  renderLists();
}

function toggleDone(id) {
  const mission = byId(id);
  if (!mission) return;
  mission.status = mission.status === "done" ? "open" : "done";
  if (mission.status === "done" && state.activeMissionId === id) state.activeMissionId = null;
  save();
  say(mission.status === "done" ? "Actividad marcada como lista." : "Actividad reabierta.");
  renderStatic();
  renderLists();
}

function moveMission(id, dir) {
  const list = visibleMissions();
  const index = list.findIndex((m) => m.id === id);
  const swap = index + dir;
  if (index < 0 || swap < 0 || swap >= list.length) return;
  const order = list[index].order;
  list[index].order = list[swap].order;
  list[swap].order = order;
  save();
  renderLists();
}

function beginEdit(id) {
  ui.editing = id;
  ui.focusEdit = true;
  renderLists();
}

function saveEdit(id) {
  const mission = byId(id);
  const row = document.querySelector(`[data-id="${id}"]`);
  if (!mission || !row) return;
  const title = row.querySelector(".edit-title")?.value.trim() || "";
  const notes = row.querySelector(".edit-note")?.value.trim() || "";
  if (!title) {
    say("Identifica la actividad.");
    return;
  }
  mission.title = title.slice(0, 80);
  mission.notes = notes.slice(0, 140);
  ui.editing = null;
  save();
  say("Actividad actualizada.");
  renderStatic();
  renderLists();
}

function setActive(id) {
  const mission = byId(id);
  if (!mission) return;
  if (mission.status === "done") {
    say("Reabre la actividad si quieres fijarla como blanco.");
    return;
  }
  state.activeMissionId = id;
  save();
  say(`Blanco fijado: ${mission.title}`);
  renderStatic();
  renderLists();
}

function unlock(id) {
  if (state.activeMissionId !== id) {
    setActive(id);
    return;
  }
  state.activeMissionId = null;
  save();
  say("Blanco liberado.");
  renderStatic();
  renderLists();
}

function pipNodes(done, total, host) {
  host.replaceChildren();
  const count = Math.min(total, 12);
  for (let i = 0; i < count; i += 1) {
    const mark = document.createElement("i");
    if (i < done) mark.className = "on";
    host.appendChild(mark);
  }
}

function missionNode(mission) {
  const li = document.createElement("li");
  li.className = "mission" + (mission.id === state.activeMissionId ? " is-active" : "") + (mission.status === "done" ? " is-done" : "");
  if (ui.editing === mission.id) li.classList.add("is-edit");
  li.dataset.id = mission.id;
  li.dataset.priority = mission.priority;

  const mark = document.createElement("button");
  mark.type = "button";
  mark.className = "mark";
  mark.dataset.act = "lock";
  mark.textContent = mission.id === state.activeMissionId ? "►" : "□";
  if (mission.status === "done") {
    mark.disabled = true;
    mark.setAttribute("aria-label", "Actividad lista");
  } else {
    mark.setAttribute("aria-label", mission.id === state.activeMissionId ? "Liberar blanco" : "Fijar blanco");
  }

  const body = document.createElement("div");
  body.className = "body";
  if (ui.editing === mission.id) {
    const title = document.createElement("input");
    title.className = "edit-title";
    title.maxLength = 80;
    title.value = mission.title;
    const note = document.createElement("input");
    note.className = "edit-note";
    note.maxLength = 140;
    note.value = mission.notes;
    note.placeholder = "Nota de campo";
    body.append(title, note);
  } else {
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = mission.title;
    body.append(title);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const label = document.createElement("span");
  label.textContent = `${mission.donePoms}/${mission.estimate} · ${PRIO[mission.priority]}`;
  if (mission.addedSeconds) label.textContent += ` · +${fmtSpan(mission.addedSeconds)}`;
  if (mission.status === "done") label.textContent += " · CLEAR";
  const pips = document.createElement("span");
  pips.className = "pips";
  pipNodes(mission.donePoms, mission.estimate, pips);
  meta.append(label, pips);
  if (mission.notes && ui.editing !== mission.id) {
    const note = document.createElement("div");
    note.textContent = mission.notes;
    meta.append(note);
  }
  if (ui.adding === mission.id && ui.editing !== mission.id) {
    const add = document.createElement("div");
    add.className = "add-time";
    [5, 10, 15, 25].forEach((minutes) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.act = "add-min";
      button.dataset.min = String(minutes);
      button.textContent = `+${minutes}`;
      add.append(button);
    });
    meta.append(add);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const armed = ui.armKey === `del:${mission.id}`;
  const buttons = ui.editing === mission.id
    ? [["save", "OK"], ["cancel", "NO"]]
    : [["up", "▲"], ["down", "▼"], ["edit", "EDT"], ["mins", "MIN"], ["done", mission.status === "done" ? "REA" : "CLR"], ["delete", armed ? "SI" : "DEL"]];
  buttons.forEach(([act, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.act = act;
    button.textContent = text;
    actions.append(button);
  });

  li.append(mark, body, meta, actions);
  return li;
}

function dayLabel(ts) {
  const key = keyFromDate(new Date(ts));
  const today = todayKey();
  if (key === today) return "HOY";
  if (key === shiftKey(today, -1)) return "AYER";
  return new Date(ts).toLocaleDateString("es", { day: "2-digit", month: "short" }).toUpperCase();
}

function renderMissions() {
  const list = $("#list");
  list.replaceChildren();
  const items = visibleMissions();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = ui.filter === "done"
      ? "Ninguna actividad lista."
      : "Sin objetivos en el canal. Registra una actividad.";
    list.append(empty);
    return;
  }
  items.forEach((mission) => list.append(missionNode(mission)));
  if (ui.focusEdit) {
    const input = list.querySelector(".edit-title");
    input?.focus();
    input?.select();
    ui.focusEdit = false;
  }
}

function renderLog() {
  const list = $("#list");
  list.replaceChildren();
  const items = state.history.slice().reverse();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Sin registros en el canal.";
    list.append(empty);
    return;
  }
  let lastDay = "";
  items.forEach((entry) => {
    const label = dayLabel(entry.at);
    if (label !== lastDay) {
      lastDay = label;
      const day = document.createElement("li");
      day.className = "day";
      day.textContent = label;
      list.append(day);
    }
    const li = document.createElement("li");
    li.className = "log";
    li.dataset.phase = entry.phase;
    const time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
    const name = document.createElement("b");
    const labels = { focus: "INFILTRACIÓN", short: "PAUSA TÁCTICA", long: "EXTRACCIÓN", extra: "TIEMPO AÑADIDO" };
    name.textContent = labels[entry.phase] || entry.phase;
    const dur = document.createElement("small");
    const marks = [];
    if (entry.extraSeconds) marks.push(`+${fmtSpan(entry.extraSeconds)}`);
    if (entry.internal) marks.push(`INT ${entry.internal}`);
    if (entry.external) marks.push(`EXT ${entry.external}`);
    dur.textContent = marks.length ? `${fmt(entry.seconds)} · ${marks.join(" ")}` : fmt(entry.seconds);
    const title = document.createElement("em");
    title.textContent = entry.title;
    li.append(time, name, dur, title);
    list.append(li);
  });
}

function renderTabs() {
  const open = state.missions.filter((m) => m.status !== "done").length;
  const done = state.missions.length - open;
  const tabs = [
    ["open", `ABIERTAS ${open}`],
    ["done", `LISTAS ${done}`],
    ["log", "REGISTRO"],
    ["metrics", "MES"],
  ];
  tabs.forEach(([id, text]) => {
    const button = $(`#tab-${id}`);
    button.textContent = text;
    const on = ui.filter === id;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const view = ui.filter === "log" ? "log" : ui.filter === "metrics" ? "metrics" : "missions";
  $("#panel").dataset.view = view;
  const layout = document.querySelector(".layout");
  if (layout) layout.dataset.view = view;
  const head = $("#metrics-head");
  if (head) head.hidden = ui.filter !== "metrics";
  syncPurge();
}

function syncPurge() {
  $("#purge").textContent = ui.armKey === "purge" ? "CONFIRMAR" : "PURGAR";
}

function renderHeat(list) {
  const month = ui.month || currentMonthKey();
  const span = heatWindow(month);
  const byDay = new Map((ui.metrics?.days || []).map((day) => [day.day, day]));
  const weeks = [];
  for (let cursor = new Date(span.start); cursor <= span.end; cursor = addDays(cursor, 7)) {
    const week = [];
    for (let index = 0; index < 7; index += 1) {
      const day = addDays(cursor, index);
      if (day > span.end) break;
      week.push(day);
    }
    if (week.length) weeks.push(week);
  }
  let spanSeconds = 0;
  byDay.forEach((info) => { spanSeconds += info.seconds; });

  const item = document.createElement("li");
  item.className = "heat";
  const total = document.createElement("p");
  total.className = "heat-total";
  const fromLabel = span.start.toLocaleDateString("es", { month: "short", year: "numeric" }).replace(".", "");
  const toLabel = span.end.toLocaleDateString("es", { month: "short", year: "numeric" }).replace(".", "");
  total.textContent = `${fmtLong(spanSeconds)} · ${fromLabel} – ${toLabel}`;

  const board = document.createElement("div");
  board.className = "heat-board";
  const dows = document.createElement("div");
  dows.className = "heat-dows";
  dows.setAttribute("aria-hidden", "true");
  ["L", "M", "X", "J", "V", "S", "D"].forEach((name, index) => {
    const mark = document.createElement("span");
    mark.textContent = index % 2 === 0 && index < 6 ? name : "";
    dows.append(mark);
  });

  const scroller = document.createElement("div");
  scroller.className = "heat-scroll";
  const months = document.createElement("div");
  months.className = "heat-months";
  const monthNames = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
  let lastColumn = -4;
  weeks.forEach((week, index) => {
    const first = week.find((day) => day.getDate() === 1) || (index === 0 ? week[0] : null);
    if (!first || index - lastColumn < 2) return;
    const name = document.createElement("span");
    name.textContent = monthNames[first.getMonth()];
    name.style.gridColumn = String(index + 1);
    if (dayKey(first).slice(0, 7) === month) name.className = "is-on";
    months.append(name);
    lastColumn = index;
  });

  const grid = document.createElement("div");
  grid.className = "heat-grid";
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", "Historial de tiempo por día");
  let focusDay = ui.day;
  weeks.forEach((week) => {
    week.forEach((date) => {
      const key = dayKey(date);
      const info = byDay.get(key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "heat-cell";
      button.dataset.day = key;
      button.dataset.level = String(heatLevel(info?.seconds || 0));
      button.tabIndex = -1;
      button.title = heatTip(date, info);
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", key === ui.day ? "true" : "false");
      if (key.slice(0, 7) === month) button.classList.add("is-month");
      if (key === ui.day) button.classList.add("is-day");
      grid.append(button);
    });
  });
  const current = grid.querySelector(`[data-day="${focusDay}"]`) || grid.lastElementChild;
  if (current) current.tabIndex = 0;

  scroller.append(months, grid);
  board.append(dows, scroller);
  const legend = document.createElement("p");
  legend.className = "heat-legend";
  const less = document.createElement("span");
  less.textContent = "MENOS";
  legend.append(less);
  for (let level = 0; level <= 4; level += 1) {
    const swatch = document.createElement("i");
    swatch.dataset.level = String(level);
    legend.append(swatch);
  }
  const more = document.createElement("span");
  more.textContent = "MÁS";
  legend.append(more);
  item.append(total, board, legend);
  list.append(item);
  const anchor = grid.querySelector(".is-day") || grid.querySelector(".is-month") || current;
  if (anchor) {
    const left = anchor.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    scroller.scrollLeft = Math.max(0, left - 28);
  }
}

function renderMetrics() {
  const label = $("#month-label");
  const next = $("#month-next");
  const month = ui.month || currentMonthKey();
  if (label) {
    label.textContent = ui.day
      ? parseDay(ui.day).toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" }).toUpperCase()
      : monthLabel(month);
  }
  if (next) next.disabled = month >= currentMonthKey();
  const list = $("#list");
  list.replaceChildren();
  if (ui.metricsLoading && !ui.metrics) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Leyendo el mes…";
    list.append(empty);
    return;
  }
  if (ui.metricsError || !ui.metrics) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Sin enlace con las métricas.";
    list.append(empty);
    return;
  }
  renderHeat(list);
  const totals = ui.metrics.totals;
  const summary = document.createElement("li");
  summary.className = "metric-summary";
  [
    ["TIEMPO", fmtLong(totals.seconds)],
    ["AÑADIDO", fmtLong(totals.addedSeconds)],
    ["BLOQUES", String(totals.blocks)],
    ["ACTIVIDADES", String(totals.activities)],
  ].forEach(([name, value]) => {
    const cell = document.createElement("div");
    const k = document.createElement("span");
    k.textContent = name;
    const v = document.createElement("strong");
    v.textContent = value;
    cell.append(k, v);
    summary.append(cell);
  });
  list.append(summary);
  if (!ui.metrics.activities.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = ui.day ? "Sin tiempo registrado este día." : "Sin tiempo registrado en este mes.";
    list.append(empty);
    return;
  }
  const max = Math.max(...ui.metrics.activities.map((item) => item.seconds), 1);
  ui.metrics.activities.forEach((item) => {
    const li = document.createElement("li");
    li.className = "metric";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const meta = document.createElement("span");
    const bits = [blockLabel(item.blocks), fmtLong(item.seconds)];
    if (item.estimate) bits.push(`estimado ${item.estimate}`);
    if (item.addedSeconds > 0) bits.push(`incluye +${fmtLong(item.addedSeconds)}`);
    meta.textContent = bits.join(" · ");
    const bar = document.createElement("i");
    bar.style.width = `${Math.max(4, Math.round((item.seconds / max) * 100))}%`;
    li.append(title, meta, bar);
    list.append(li);
  });
}

function renderLists() {
  renderTabs();
  if (ui.filter === "log") renderLog();
  else if (ui.filter === "metrics") renderMetrics();
  else renderMissions();
}

function runState() {
  if (state.running) return "live";
  if (state.remaining < phaseSeconds(state.phase)) return "hold";
  return "standby";
}

function alertLevel() {
  if (!state.running) return "none";
  if (state.remaining <= 10 && state.remaining > 0) return "alert";
  if (state.remaining <= 60) return "caution";
  return "none";
}

function pipCount() {
  if (state.phase === "long" && state.cycleCharged) return state.settings.cycleLength;
  return Math.min(state.cyclePos, state.settings.cycleLength);
}

function paintRun() {
  const alert = alertLevel();
  const run = runState();
  document.body.dataset.alert = alert;
  document.body.dataset.run = run;
  document.body.dataset.phase = state.phase;
  const led = $("#led");
  led.className = "led";
  if (alert === "alert") led.classList.add("alert");
  else if (alert === "caution" || run === "hold") led.classList.add("hold");
  else if (run === "live") led.classList.add("live");

  const tag = $("#alert-tag");
  if (alert === "alert") {
    tag.hidden = false;
    tag.textContent = "! ALERT !";
  } else if (alert === "caution") {
    tag.hidden = false;
    tag.textContent = "CAUTION";
  } else tag.hidden = true;

  $("#status").textContent = run === "live" ? "EN CURSO" : run === "hold" ? "EN ESPERA" : "LISTO";
  $("#rec").classList.toggle("on", state.running);
  $("#sig").className = "sig" + (run === "live" ? " live" : run === "hold" ? " hold" : "");
}

function paintTime() {
  $("#time").textContent = fmt(state.remaining);
  const total = Math.max(1, state.planned || phaseSeconds(state.phase));
  const ratio = Math.min(1, Math.max(0, state.remaining / total));
  const ring = $("#ring");
  ring.style.strokeDasharray = `${RING_C}`;
  ring.style.strokeDashoffset = `${RING_C * ratio}`;
  const label = PHASE[state.phase].label;
  document.title = `${fmt(state.remaining)} ${label}`;
  $("#timer").setAttribute("aria-label", `${label}, ${fmt(state.remaining)} restantes`);
}

function paintClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("es-ES", { hour12: false });
}

function renderStatic() {
  $("#callsign").textContent = state.settings.callsign;
  if (!ui.glitching) $("#freq").textContent = PHASE[state.phase].freq;
  $("#phase-label").textContent = PHASE[state.phase].label;

  const mission = byId(state.activeMissionId);
  const target = $("#target");
  if (mission) {
    target.textContent = `BLANCO: ${mission.title}`;
    target.dataset.priority = mission.priority;
  } else {
    target.textContent = "BLANCO: —";
    target.dataset.priority = "";
  }

  ["focus", "short", "long"].forEach((phase) => {
    const button = $(`#ph-${phase}`);
    button.classList.toggle("is-on", phase === state.phase);
    button.querySelector(".du").textContent = fmt(phaseSeconds(phase));
    button.setAttribute("aria-pressed", phase === state.phase ? "true" : "false");
  });

  const toggle = $("#toggle");
  toggle.textContent = state.running ? "PAUSA" : "INICIAR";
  toggle.classList.toggle("live", state.running);

  const sound = $("#toggle-sound");
  sound.classList.toggle("is-on", state.settings.sound);
  sound.setAttribute("aria-pressed", state.settings.sound ? "true" : "false");

  const cycle = $("#cycle");
  cycle.replaceChildren();
  const filled = pipCount();
  for (let i = 0; i < state.settings.cycleLength; i += 1) {
    const mark = document.createElement("i");
    if (i < filled) mark.className = "on";
    cycle.append(mark);
  }

  $("#int-count").textContent = `INT ${pad(state.sessionInterrupts.internal)}`;
  $("#ext-count").textContent = `EXT ${pad(state.sessionInterrupts.external)}`;
  const canMark = state.running && state.phase === "focus";
  $("#btn-int").disabled = !canMark;
  $("#btn-ext").disabled = !canMark;
  document.querySelectorAll("[data-extend]").forEach((button) => {
    button.disabled = state.phase !== "focus";
  });
  const added = $("#added-note");
  if (added) {
    added.hidden = !(state.blockExtra > 0);
    added.textContent = state.blockExtra > 0 ? `+${fmtSpan(state.blockExtra)} EN ESTE BLOQUE` : "";
  }

  const goal = Math.max(1, state.settings.dailyGoal);
  $("#stat-today").textContent = `${state.focusCountToday}/${goal}`;
  $("#stat-focus").textContent = fmtLong(state.focusSecondsToday);
  $("#stat-streak").textContent = String(effectiveStreak());
  $("#stat-life").textContent = String(state.lifetimeFocus);
  $("#goal-fill").style.width = `${Math.min(100, (state.focusCountToday / goal) * 100)}%`;

  $("#est-val").textContent = String(ui.estimate);
  document.querySelectorAll("[data-prio]").forEach((button) => {
    const on = button.dataset.prio === ui.priority;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });

  paintRun();
  renderTabs();
}

function tick() {
  paintClock();
  if (rollover()) {
    save();
    renderStatic();
  }
  if (state.running && state.endsAt) {
    const left = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
    if (left <= 0) {
      if (ready) completePhase();
      return;
    }
    state.remaining = left;
  }
  paintTime();
  paintRun();
}

function openSettings() {
  const form = $("#settings-form");
  form.querySelector("#set-callsign").value = state.settings.callsign;
  form.querySelector("#set-focus").value = state.settings.focusMin;
  form.querySelector("#set-short").value = state.settings.shortMin;
  form.querySelector("#set-long").value = state.settings.longMin;
  form.querySelector("#set-cycle").value = state.settings.cycleLength;
  form.querySelector("#set-goal").value = state.settings.dailyGoal;
  form.querySelector("#set-auto").checked = state.settings.autoStart;
  form.querySelector("#set-sound").checked = state.settings.sound;
  form.querySelector("#set-notify").checked = state.settings.notify;
  form.querySelector("#set-close").checked = state.settings.autoClose;
  form.querySelector("#set-strict").checked = state.settings.strict;
  if (!("Notification" in window)) $("#perm-note").textContent = "Este navegador no muestra avisos de escritorio.";
  else if (Notification.permission === "denied") $("#perm-note").textContent = "Los avisos están bloqueados en el navegador.";
  else if (Notification.permission === "granted") $("#perm-note").textContent = "Avisos de escritorio autorizados.";
  else $("#perm-note").textContent = "Al activar los avisos, el navegador pedirá permiso.";
  $("#settings").hidden = false;
  form.querySelector("#set-callsign").focus();
}

function closeSettings() {
  $("#settings").hidden = true;
}

function applySettings(event) {
  event.preventDefault();
  const next = {
    ...state.settings,
    callsign: cleanCallsign($("#set-callsign").value),
    focusMin: clamp($("#set-focus").value, 1, 180),
    shortMin: clamp($("#set-short").value, 1, 60),
    longMin: clamp($("#set-long").value, 1, 90),
    cycleLength: clamp($("#set-cycle").value, 2, 8),
    dailyGoal: clamp($("#set-goal").value, 1, 20),
    autoStart: $("#set-auto").checked,
    sound: $("#set-sound").checked,
    notify: $("#set-notify").checked,
    autoClose: $("#set-close").checked,
    strict: $("#set-strict").checked,
  };
  const wasFull = state.remaining >= state.planned;
  state.settings = next;
  if (state.cyclePos >= next.cycleLength) state.cyclePos = 0;
  if (!state.running) {
    const full = phaseSeconds(state.phase);
    state.planned = full;
    state.remaining = wasFull ? full : Math.min(state.remaining, full);
  }
  save();
  closeSettings();
  say(state.running ? "Parámetros grabados. El reloj en curso no cambia." : "Parámetros grabados.");
  renderStatic();
  paintTime();
  if (next.notify && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(() => {
      $("#perm-note").textContent = Notification.permission === "granted"
        ? "Avisos de escritorio autorizados."
        : "Aviso no autorizado.";
    });
  }
}

function typingTarget(el) {
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable;
}

function finishBoot() {
  if (booted) return;
  booted = true;
  const boot = $("#boot");
  if (!boot) return;
  boot.classList.add("hide");
  setTimeout(() => boot.remove(), 500);
}

function armReady() {
  finishBoot();
  if (ready) return;
  ready = true;
  if (expiredOnLoad) {
    expiredOnLoad = false;
    completePhase({ fromLoad: true });
  }
}

function bind() {
  $("#boot").addEventListener("click", armReady);

  $("#toggle").addEventListener("click", toggle);
  $("#abort").addEventListener("click", abortTimer);
  $("#skip").addEventListener("click", skip);
  $("#btn-int").addEventListener("click", () => interfere("internal"));
  $("#btn-ext").addEventListener("click", () => interfere("external"));
  document.querySelectorAll(".freq-btn").forEach((button) => {
    button.addEventListener("click", () => selectPhase(button.dataset.phase));
  });

  $("#toggle-sound").addEventListener("click", () => {
    state.settings.sound = !state.settings.sound;
    save();
    renderStatic();
    if (state.settings.sound) playStart();
  });
  $("#open-settings").addEventListener("click", openSettings);
  $("#close-settings").addEventListener("click", closeSettings);
  $("#settings").addEventListener("click", (event) => {
    if (event.target === $("#settings")) closeSettings();
  });
  $("#settings-form").addEventListener("submit", applySettings);

  $("#est-dec").addEventListener("click", () => {
    ui.estimate = Math.max(1, ui.estimate - 1);
    renderStatic();
  });
  $("#est-inc").addEventListener("click", () => {
    ui.estimate = Math.min(12, ui.estimate + 1);
    renderStatic();
  });
  document.querySelectorAll("[data-prio]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.priority = button.dataset.prio;
      renderStatic();
    });
  });

  $("#composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = $("#task-title").value.trim();
    const notes = $("#task-note").value.trim();
    if (!title) {
      say("Identifica la actividad.");
      shake($("#composer"));
      $("#task-title").focus();
      return;
    }
    addMission(title, notes);
    $("#task-title").value = "";
    $("#task-note").value = "";
    $("#task-title").focus();
  });

  $("#tab-open").addEventListener("click", () => { ui.filter = "open"; ui.editing = null; ui.adding = null; renderLists(); });
  $("#tab-done").addEventListener("click", () => { ui.filter = "done"; ui.editing = null; ui.adding = null; renderLists(); });
  $("#tab-log").addEventListener("click", () => { ui.filter = "log"; ui.editing = null; ui.adding = null; renderLists(); });
  $("#tab-metrics").addEventListener("click", () => {
    ui.filter = "metrics";
    ui.editing = null;
    ui.adding = null;
    if (!ui.month) ui.month = currentMonthKey();
    renderLists();
    loadMetrics();
  });
  $("#month-prev").addEventListener("click", () => {
    ui.day = "";
    ui.month = shiftMonth(ui.month || currentMonthKey(), -1);
    loadMetrics();
  });
  $("#month-next").addEventListener("click", () => {
    const next = shiftMonth(ui.month || currentMonthKey(), 1);
    if (next > currentMonthKey()) return;
    ui.day = "";
    ui.month = next;
    loadMetrics();
  });
  document.querySelectorAll("[data-extend]").forEach((button) => {
    button.addEventListener("click", () => extendBlock(Number(button.dataset.extend)));
  });
  $("#purge").addEventListener("click", () => {
    if (!requestArm("purge")) {
      syncPurge();
      return;
    }
    purgeHistory();
  });

  $("#list").addEventListener("click", (event) => {
    const cell = event.target.closest(".heat-cell");
    if (cell) {
      const day = cell.dataset.day;
      const month = day.slice(0, 7);
      if (month > currentMonthKey()) return;
      ui.day = ui.day === day ? "" : day;
      ui.month = month;
      loadMetrics();
      return;
    }
    const row = event.target.closest(".mission");
    if (!row) return;
    if (event.target.closest("input")) return;
    const id = row.dataset.id;
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (!act) {
      setActive(id);
      return;
    }
    if (act === "lock") unlock(id);
    else if (act === "edit") beginEdit(id);
    else if (act === "cancel") { ui.editing = null; renderLists(); }
    else if (act === "save") saveEdit(id);
    else if (act === "done") toggleDone(id);
    else if (act === "mins") {
      ui.adding = ui.adding === id ? null : id;
      renderLists();
    } else if (act === "add-min") addMinutes(id, Number(event.target.closest("[data-min]")?.dataset.min));
    else if (act === "up") moveMission(id, -1);
    else if (act === "down") moveMission(id, 1);
    else if (act === "delete") {
      if (!requestArm(`del:${id}`)) renderLists();
      else deleteMission(id);
    }
  });

  $("#list").addEventListener("keydown", (event) => {
    const cell = event.target.closest(".heat-cell");
    if (cell) {
      const move = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
      if (move) {
        event.preventDefault();
        const next = document.querySelector(`.heat-cell[data-day="${dayKey(addDays(parseDay(cell.dataset.day), move))}"]`);
        if (!next) return;
        cell.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
      }
      return;
    }
    const row = event.target.closest(".mission");
    if (!row || !event.target.closest("input")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      saveEdit(row.dataset.id);
    } else if (event.key === "Escape") {
      ui.editing = null;
      renderLists();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!ready) {
      armReady();
      return;
    }
    if (typingTarget(event.target)) return;
    if (!$("#settings").hidden) {
      if (event.key === "Escape") closeSettings();
      return;
    }
    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      toggle();
    } else if (event.key === "r" || event.key === "R") abortTimer();
    else if (event.key === "s" || event.key === "S") skip();
    else if (event.key === "n" || event.key === "N") $("#task-title").focus();
    else if (event.key === "i" || event.key === "I") interfere("internal");
    else if (event.key === "e" || event.key === "E") interfere("external");
    else if (event.key === "1") selectPhase("focus");
    else if (event.key === "2") selectPhase("short");
    else if (event.key === "3") selectPhase("long");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.running && state.endsAt) {
      state.remaining = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
      save();
      return;
    }
    tick();
  });

  window.addEventListener("pointerdown", () => {
    if (state.settings.sound) {
      try { audio(); } catch { /* gesto ignorado */ }
    }
  }, { passive: true });
}

async function main() {
  let stored = null;
  let migrated = false;
  try {
    stored = await readRemote();
    const legacy = readLegacy();
    if (!stored && legacy) {
      stored = legacy;
      migrated = true;
    }
  } catch {
    dbOnline = false;
  }
  state = normalize(stored);
  ui.month = currentMonthKey();
  if (migrated) {
    try { localStorage.removeItem(KEY); } catch { /* el navegador no guarda */ }
  }
  const dayChanged = rollover();
  if (dbOnline && (migrated || dayChanged)) save();
  expiredOnLoad = Boolean(state.running && state.endsAt && Date.now() >= state.endsAt);
  if (state.running && state.endsAt && !expiredOnLoad) {
    state.remaining = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
  }
  bind();
  renderStatic();
  renderLists();
  paintTime();
  paintClock();
  $("#codec").textContent = dbOnline
    ? PHASE[state.phase].line
    : "Sin enlace con la base de datos.";
  setInterval(tick, 250);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(armReady, reduce ? 250 : 1450);
}

main();
