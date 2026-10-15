import express from "express";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8757;
const DATABASE_URL = process.env.DATABASE_URL;

const PHASES = new Set(["focus", "short", "long"]);
const PRIORITIES = new Set(["routine", "priority", "urgent"]);
const HIDDEN = new Set([
  "/server.js",
  "/package.json",
  "/package-lock.json",
  "/Dockerfile",
  "/docker-compose.yml",
]);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function text(value, max, fallback = "") {
  const clean = String(value ?? fallback).replace(/\u0000/g, "").trim();
  return clean.slice(0, max);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  let lastError = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await wait(1000);
    }
  }
  throw lastError;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS timer (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      phase TEXT NOT NULL,
      remaining INTEGER NOT NULL,
      planned INTEGER NOT NULL,
      running BOOLEAN NOT NULL,
      ends_at BIGINT,
      cycle_pos INTEGER NOT NULL,
      cycle_charged BOOLEAN NOT NULL,
      day TEXT NOT NULL DEFAULT '',
      focus_count_today INTEGER NOT NULL,
      focus_seconds_today INTEGER NOT NULL,
      streak INTEGER NOT NULL,
      last_focus_day TEXT NOT NULL DEFAULT '',
      lifetime_focus INTEGER NOT NULL,
      active_mission_id TEXT,
      interrupt_internal INTEGER NOT NULL,
      interrupt_external INTEGER NOT NULL,
      focus_min INTEGER NOT NULL,
      short_min INTEGER NOT NULL,
      long_min INTEGER NOT NULL,
      cycle_length INTEGER NOT NULL,
      daily_goal INTEGER NOT NULL,
      auto_start BOOLEAN NOT NULL,
      sound BOOLEAN NOT NULL,
      notify BOOLEAN NOT NULL,
      auto_close BOOLEAN NOT NULL,
      strict BOOLEAN NOT NULL,
      callsign TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      estimate INTEGER NOT NULL,
      done_poms INTEGER NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      title TEXT NOT NULL,
      seconds INTEGER NOT NULL,
      internal INTEGER NOT NULL,
      external INTEGER NOT NULL,
      at BIGINT NOT NULL
    );

    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mission_id TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'block';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS extra_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS added_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE timer ADD COLUMN IF NOT EXISTS block_extra INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS sessions_at_idx ON sessions (at);
  `);
}

function toState(timer, missions, history) {
  return {
    settings: {
      focusMin: timer.focus_min,
      shortMin: timer.short_min,
      longMin: timer.long_min,
      cycleLength: timer.cycle_length,
      dailyGoal: timer.daily_goal,
      autoStart: timer.auto_start,
      sound: timer.sound,
      notify: timer.notify,
      autoClose: timer.auto_close,
      strict: timer.strict,
      callsign: timer.callsign,
    },
    missions: missions.map((mission) => ({
      id: mission.id,
      title: mission.title,
      notes: mission.notes,
      estimate: mission.estimate,
      donePoms: mission.done_poms,
      priority: mission.priority,
      status: mission.status,
      order: mission.sort_order,
      created: Number(mission.created),
      addedSeconds: mission.added_seconds || 0,
    })),
    activeMissionId: timer.active_mission_id,
    phase: timer.phase,
    remaining: timer.remaining,
    planned: timer.planned,
    running: timer.running,
    endsAt: timer.ends_at == null ? null : Number(timer.ends_at),
    cyclePos: timer.cycle_pos,
    cycleCharged: timer.cycle_charged,
    day: timer.day,
    focusCountToday: timer.focus_count_today,
    focusSecondsToday: timer.focus_seconds_today,
    streak: timer.streak,
    lastFocusDay: timer.last_focus_day,
    lifetimeFocus: timer.lifetime_focus,
    blockExtra: timer.block_extra || 0,
    sessionInterrupts: {
      internal: timer.interrupt_internal,
      external: timer.interrupt_external,
    },
    history: history.map((entry) => ({
      id: entry.id,
      phase: entry.phase,
      title: entry.title,
      seconds: entry.seconds,
      internal: entry.internal,
      external: entry.external,
      at: Number(entry.at),
      missionId: entry.mission_id,
      kind: entry.kind === "extra" ? "extra" : "block",
      extraSeconds: entry.extra_seconds || 0,
    })),
  };
}

function sanitize(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const settings = body.settings || {};
  const interrupts = body.sessionInterrupts || {};
  const phase = PHASES.has(body.phase) ? body.phase : "focus";
  const seenMissions = new Set();
  const missions = (Array.isArray(body.missions) ? body.missions : []).slice(0, 300).flatMap((mission, index) => {
    const id = text(mission.id, 40) || `m${index}`;
    if (seenMissions.has(id)) return [];
    seenMissions.add(id);
    return [{
      id,
      title: text(mission.title, 80, "Sin título"),
      notes: text(mission.notes, 140),
      estimate: clamp(mission.estimate, 1, 12, 1),
      donePoms: clamp(mission.donePoms, 0, 999, 0),
      addedSeconds: clamp(mission.addedSeconds, 0, 7 * 24 * 3600, 0),
      priority: PRIORITIES.has(mission.priority) ? mission.priority : "routine",
      status: mission.status === "done" ? "done" : "open",
      order: Number.isFinite(Number(mission.order)) ? Math.round(Number(mission.order)) : index,
      created: clamp(mission.created, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    }];
  }).filter((mission) => mission.title);

  const seenHistory = new Set();
  const history = (Array.isArray(body.history) ? body.history : []).slice(-400).flatMap((entry, index) => {
    const id = text(entry.id, 40) || `h${index}`;
    if (seenHistory.has(id)) return [];
    seenHistory.add(id);
    return [{
      id,
      phase: entry.phase === "extra" ? "extra" : (PHASES.has(entry.phase) ? entry.phase : "focus"),
      title: text(entry.title, 80, "Sin blanco"),
      seconds: clamp(entry.seconds, 0, 180 * 60, 0),
      internal: clamp(entry.internal, 0, 999, 0),
      external: clamp(entry.external, 0, 999, 0),
      at: clamp(entry.at, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      missionId: text(entry.missionId, 40) || null,
      kind: entry.kind === "extra" || entry.phase === "extra" ? "extra" : "block",
      extraSeconds: clamp(entry.extraSeconds, 0, 180 * 60, 0),
    }];
  });

  const active = text(body.activeMissionId, 40);
  return {
    phase,
    remaining: clamp(body.remaining, 0, 180 * 60, 25 * 60),
    planned: clamp(body.planned, 1, 180 * 60, 25 * 60),
    running: Boolean(body.running),
    endsAt: body.endsAt == null ? null : clamp(body.endsAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    cyclePos: clamp(body.cyclePos, 0, 8, 0),
    cycleCharged: Boolean(body.cycleCharged),
    day: text(body.day, 10),
    focusCountToday: clamp(body.focusCountToday, 0, 999, 0),
    focusSecondsToday: clamp(body.focusSecondsToday, 0, 7 * 24 * 3600, 0),
    streak: clamp(body.streak, 0, 9999, 0),
    lastFocusDay: text(body.lastFocusDay, 10),
    lifetimeFocus: clamp(body.lifetimeFocus, 0, 1000000, 0),
    blockExtra: clamp(body.blockExtra, 0, 180 * 60, 0),
    activeMissionId: missions.some((mission) => mission.id === active) ? active : null,
    interruptInternal: clamp(interrupts.internal, 0, 999, 0),
    interruptExternal: clamp(interrupts.external, 0, 999, 0),
    focusMin: clamp(settings.focusMin, 1, 180, 25),
    shortMin: clamp(settings.shortMin, 1, 60, 5),
    longMin: clamp(settings.longMin, 1, 90, 15),
    cycleLength: clamp(settings.cycleLength, 2, 8, 4),
    dailyGoal: clamp(settings.dailyGoal, 1, 20, 8),
    autoStart: Boolean(settings.autoStart),
    sound: settings.sound !== false,
    notify: Boolean(settings.notify),
    autoClose: settings.autoClose !== false,
    strict: Boolean(settings.strict),
    callsign: text(settings.callsign, 12, "SNAKE").toUpperCase() || "SNAKE",
    missions,
    history,
  };
}

async function readState(pool) {
  const timer = await pool.query("SELECT * FROM timer WHERE id = 1");
  if (!timer.rowCount) return null;
  const missions = await pool.query("SELECT * FROM missions ORDER BY sort_order, created");
  const history = await pool.query(`
    SELECT * FROM (
      SELECT * FROM sessions ORDER BY at DESC, id DESC LIMIT 200
    ) recent
    ORDER BY at, id
  `);
  return toState(timer.rows[0], missions.rows, history.rows);
}

async function writeState(pool, state) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO timer (
        id, phase, remaining, planned, running, ends_at, cycle_pos, cycle_charged,
        day, focus_count_today, focus_seconds_today, streak, last_focus_day, lifetime_focus,
        active_mission_id, interrupt_internal, interrupt_external,
        focus_min, short_min, long_min, cycle_length, daily_goal,
        auto_start, sound, notify, auto_close, strict, callsign, block_extra, updated_at
      ) VALUES (
        1, $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26, $27, $28, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        phase = EXCLUDED.phase,
        remaining = EXCLUDED.remaining,
        planned = EXCLUDED.planned,
        running = EXCLUDED.running,
        ends_at = EXCLUDED.ends_at,
        cycle_pos = EXCLUDED.cycle_pos,
        cycle_charged = EXCLUDED.cycle_charged,
        day = EXCLUDED.day,
        focus_count_today = EXCLUDED.focus_count_today,
        focus_seconds_today = EXCLUDED.focus_seconds_today,
        streak = EXCLUDED.streak,
        last_focus_day = EXCLUDED.last_focus_day,
        lifetime_focus = EXCLUDED.lifetime_focus,
        active_mission_id = EXCLUDED.active_mission_id,
        interrupt_internal = EXCLUDED.interrupt_internal,
        interrupt_external = EXCLUDED.interrupt_external,
        focus_min = EXCLUDED.focus_min,
        short_min = EXCLUDED.short_min,
        long_min = EXCLUDED.long_min,
        cycle_length = EXCLUDED.cycle_length,
        daily_goal = EXCLUDED.daily_goal,
        auto_start = EXCLUDED.auto_start,
        sound = EXCLUDED.sound,
        notify = EXCLUDED.notify,
        auto_close = EXCLUDED.auto_close,
        strict = EXCLUDED.strict,
        callsign = EXCLUDED.callsign,
        block_extra = EXCLUDED.block_extra,
        updated_at = NOW()`,
      [
        state.phase, state.remaining, state.planned, state.running, state.endsAt, state.cyclePos, state.cycleCharged,
        state.day, state.focusCountToday, state.focusSecondsToday, state.streak, state.lastFocusDay, state.lifetimeFocus,
        state.activeMissionId, state.interruptInternal, state.interruptExternal,
        state.focusMin, state.shortMin, state.longMin, state.cycleLength, state.dailyGoal,
        state.autoStart, state.sound, state.notify, state.autoClose, state.strict, state.callsign, state.blockExtra,
      ],
    );
    await client.query("DELETE FROM missions");
    for (const mission of state.missions) {
      await client.query(
        `INSERT INTO missions (id, title, notes, estimate, done_poms, priority, status, sort_order, created, added_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [mission.id, mission.title, mission.notes, mission.estimate, mission.donePoms, mission.priority, mission.status, mission.order, mission.created, mission.addedSeconds],
      );
    }
    for (const entry of state.history) {
      await client.query(
        `INSERT INTO sessions (id, phase, title, seconds, internal, external, at, mission_id, kind, extra_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           phase = EXCLUDED.phase,
           title = EXCLUDED.title,
           seconds = EXCLUDED.seconds,
           internal = EXCLUDED.internal,
           external = EXCLUDED.external,
           at = EXCLUDED.at,
           mission_id = EXCLUDED.mission_id,
           kind = EXCLUDED.kind,
           extra_seconds = EXCLUDED.extra_seconds`,
        [entry.id, entry.phase, entry.title, entry.seconds, entry.internal, entry.external, entry.at, entry.missionId, entry.kind, entry.extraSeconds],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const pool = await connect();
await migrate(pool);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/api/state", async (_req, res, next) => {
  try {
    res.json({ state: await readState(pool) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/state", async (req, res, next) => {
  try {
    const state = sanitize(req.body);
    if (!state) {
      res.status(400).json({ error: "Estado inválido" });
      return;
    }
    await writeState(pool, state);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

function timeZone(value) {
  const zone = String(value || "UTC");
  if (!/^[A-Za-z0-9_+/\\-]{1,64}$/.test(zone)) return "UTC";
  return zone;
}

async function knownZone(zone) {
  const found = await pool.query("SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1", [zone]);
  return found.rowCount ? zone : "UTC";
}

app.get("/api/metrics", async (req, res, next) => {
  try {
    const from = clamp(req.query.from, 0, Number.MAX_SAFE_INTEGER, 0);
    const to = clamp(req.query.to, 0, Number.MAX_SAFE_INTEGER, 0);
    const spanFrom = clamp(req.query.spanFrom, 0, Number.MAX_SAFE_INTEGER, from);
    const spanTo = clamp(req.query.spanTo, 0, Number.MAX_SAFE_INTEGER, to);
    if (!(to > from) || !(spanTo > spanFrom)) {
      res.status(400).json({ error: "Rango inválido" });
      return;
    }
    const zone = await knownZone(timeZone(req.query.tz));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || "")) ? String(req.query.day) : "";
    const activityFrom = day ? spanFrom : from;
    const activityTo = day ? spanTo : to;
    const result = await pool.query(
      `SELECT
         COALESCE(NULLIF(s.mission_id, ''), 'title:' || s.title) AS group_id,
         COALESCE(MAX(m.title), MAX(s.title)) AS title,
         MAX(m.estimate) AS estimate,
         MAX(m.status) AS status,
         MAX(m.priority) AS priority,
         COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS block_seconds,
         COALESCE(SUM(LEAST(s.extra_seconds, s.seconds)) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS block_extra,
         COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'extra'), 0)::int AS added_only,
         COALESCE(COUNT(*) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS blocks
       FROM sessions s
       LEFT JOIN missions m ON m.id = s.mission_id
       WHERE s.at >= $1 AND s.at < $2
         AND ((s.kind = 'block' AND s.phase = 'focus') OR s.kind = 'extra')
         AND ($4 = '' OR to_char(timezone($3, to_timestamp(s.at / 1000.0)), 'YYYY-MM-DD') = $4)
       GROUP BY COALESCE(NULLIF(s.mission_id, ''), 'title:' || s.title)
       ORDER BY (
         COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)
         + COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'extra'), 0)
       ) DESC`,
      [activityFrom, activityTo, zone, day],
    );
    const activities = result.rows.map((row) => {
      const blockSeconds = Number(row.block_seconds) || 0;
      const addedOnly = Number(row.added_only) || 0;
      const blockExtra = Number(row.block_extra) || 0;
      return {
        missionId: String(row.group_id).startsWith("title:") ? null : row.group_id,
        title: row.title || "Sin blanco",
        estimate: row.estimate == null ? null : Number(row.estimate),
        status: row.status,
        priority: row.priority,
        blocks: Number(row.blocks) || 0,
        seconds: blockSeconds + addedOnly,
        addedSeconds: blockExtra + addedOnly,
      };
    }).filter((item) => item.seconds > 0);
    const totals = activities.reduce((sum, item) => ({
      seconds: sum.seconds + item.seconds,
      addedSeconds: sum.addedSeconds + item.addedSeconds,
      blocks: sum.blocks + item.blocks,
      activities: activities.length,
    }), { seconds: 0, addedSeconds: 0, blocks: 0, activities: 0 });
    const daysResult = await pool.query(
      `SELECT
         to_char(timezone($3, to_timestamp(s.at / 1000.0)), 'YYYY-MM-DD') AS day,
         COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS block_seconds,
         COALESCE(SUM(LEAST(s.extra_seconds, s.seconds)) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS block_extra,
         COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'extra'), 0)::int AS added_only,
         COALESCE(COUNT(*) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS blocks
       FROM sessions s
       WHERE s.at >= $1 AND s.at < $2
         AND ((s.kind = 'block' AND s.phase = 'focus') OR s.kind = 'extra')
       GROUP BY 1
       ORDER BY 1`,
      [spanFrom, spanTo, zone],
    );
    const days = daysResult.rows.map((row) => {
      const blockSeconds = Number(row.block_seconds) || 0;
      const addedOnly = Number(row.added_only) || 0;
      const blockExtra = Number(row.block_extra) || 0;
      return {
        day: row.day,
        blocks: Number(row.blocks) || 0,
        seconds: blockSeconds + addedOnly,
        addedSeconds: blockExtra + addedOnly,
      };
    }).filter((item) => item.seconds > 0);
    const entriesResult = await pool.query(
      `SELECT
         to_char(timezone($3, to_timestamp(s.at / 1000.0)), 'YYYY-MM-DD') AS day,
         COALESCE(NULLIF(s.mission_id, ''), 'title:' || s.title) AS group_id,
         COALESCE(MAX(m.title), MAX(s.title)) AS title,
         MAX(m.estimate) AS estimate,
         MAX(m.status) AS status,
         MAX(m.priority) AS priority,
         COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS block_seconds,
         COALESCE(SUM(LEAST(s.extra_seconds, s.seconds)) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS block_extra,
         COALESCE(SUM(s.seconds) FILTER (WHERE s.kind = 'extra'), 0)::int AS added_only,
         COALESCE(COUNT(*) FILTER (WHERE s.kind = 'block' AND s.phase = 'focus'), 0)::int AS blocks
       FROM sessions s
       LEFT JOIN missions m ON m.id = s.mission_id
       WHERE s.at >= $1 AND s.at < $2
         AND ((s.kind = 'block' AND s.phase = 'focus') OR s.kind = 'extra')
       GROUP BY 1, 2`,
      [spanFrom, spanTo, zone],
    );
    const entries = entriesResult.rows.map((row) => {
      const blockSeconds = Number(row.block_seconds) || 0;
      const addedOnly = Number(row.added_only) || 0;
      const blockExtra = Number(row.block_extra) || 0;
      return {
        day: row.day,
        missionId: String(row.group_id).startsWith("title:") ? null : row.group_id,
        title: row.title || "Sin blanco",
        estimate: row.estimate == null ? null : Number(row.estimate),
        status: row.status,
        priority: row.priority,
        blocks: Number(row.blocks) || 0,
        seconds: blockSeconds + addedOnly,
        addedSeconds: blockExtra + addedOnly,
      };
    }).filter((item) => item.seconds > 0);
    res.set("Cache-Control", "no-store");
    res.json({ from, to, day, totals, activities, days, entries, span: { from: spanFrom, to: spanTo } });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sessions", async (_req, res, next) => {
  try {
    await pool.query("DELETE FROM sessions");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  if (HIDDEN.has(req.path)) {
    res.status(404).end();
    return;
  }
  next();
});
app.use(express.static(ROOT, { index: "index.html", maxAge: 0 }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Fallo de base de datos" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`codec listening on ${PORT}`);
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
