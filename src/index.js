function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization"
    }
  });
}

function bad(msg, status = 400, details) {
  return json({ ok: false, error: msg, details }, status);
}

function parsePersonRoute(pathname) {
  // /v1/persons/:personId/state
  // /v1/persons/:personId/events:batch
  const m = pathname.match(/^\/v1\/persons\/([^/]+)\/(state|events:batch)$/);
  if (!m) return null;
  return { personId: decodeURIComponent(m[1]), action: m[2] };
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

function getBearer(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function requirePersonaAuth(req, env, personId) {
  const token = getBearer(req);
  if (!token) return { ok: false, status: 401, error: "Missing Authorization: Bearer <token>" };
  if (!env.DB) return { ok: false, status: 500, error: "Missing D1 binding DB" };
  if (!env.AUTH_PEPPER) return { ok: false, status: 500, error: "Missing secret AUTH_PEPPER" };

  const hash = await sha256Hex(`${personId}:${token}:${env.AUTH_PEPPER}`);
  const row = await env.DB
    .prepare("SELECT 1 FROM persona_keys WHERE person_id = ? AND api_key_hash = ? LIMIT 1")
    .bind(personId, hash)
    .first();

  if (!row) return { ok: false, status: 403, error: "Invalid token for this person_id" };
  return { ok: true };
}

function defaultLifeState() {
  return {
    tz: "UTC",
    constraints: { sleep_target_min: 450 },
    context_now: { mode: "unknown", energy_est: 0 },
    tasks: {},
    people: {},
    recent_memories: [],
    decision_style: { prefers_time_over_money: 0, prefers_low_stress: 0, prefers_routine: 0 }
  };
}

function validateEvent(e) {
  if (!e || typeof e !== "object") return "Event must be an object";
  if (typeof e.event_id !== "string" || e.event_id.length < 8) return "Invalid event_id";
  if (typeof e.ts !== "number") return "Invalid ts";
  if (typeof e.kind !== "string" || !e.kind) return "Invalid kind";
  if (typeof e.schema_v !== "number") return "Invalid schema_v";
  if (e.payload == null || typeof e.payload !== "object") return "Invalid payload";
  return null;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function computeUrgency(task, now) {
  const ageH = (now - task.created_ts) / 3_600_000;
  const priority = (task.priority ?? 0) * 2;
  let due = 0;
  if (task.due_ts) {
    const hoursLeft = (task.due_ts - now) / 3_600_000;
    due = hoursLeft <= 0 ? 10 : clamp(6 / (hoursLeft + 1), 0, 6);
  }
  return clamp(priority + due + clamp(ageH / 48, 0, 3), 0, 15);
}

function applyEvent(state, e, now) {
  state.tasks ??= {};
  state.people ??= {};
  state.recent_memories ??= [];

  const p = e.payload;

  switch (e.kind) {
    case "task.created": {
      if (!p.id || !p.title) break;
      state.tasks[p.id] = {
        title: p.title,
        due_ts: p.due_ts,
        priority: p.priority ?? 0,
        status: "open",
        created_ts: e.ts,
        updated_ts: now,
        urgency: 0
      };
      state.tasks[p.id].urgency = computeUrgency(state.tasks[p.id], now);
      break;
    }
    case "task.completed": {
      if (!p.id) break;
      const t = state.tasks[p.id];
      if (t) { t.status = "done"; t.updated_ts = now; t.urgency = 0; }
      break;
    }
    case "memory.note": {
      if (!p.text) break;
      state.recent_memories.unshift({ ts: e.ts, text: p.text });
      state.recent_memories = state.recent_memories.slice(0, 50);
      break;
    }
    case "decision.outcome": {
      const why = String(p?.why ?? "").toLowerCase();
      if (why.includes("routine")) state.decision_style.prefers_routine = clamp(state.decision_style.prefers_routine + 0.1, -1, 1);
      if (why.includes("stress") || why.includes("calm")) state.decision_style.prefers_low_stress = clamp(state.decision_style.prefers_low_stress + 0.1, -1, 1);
      if (why.includes("time") || why.includes("fast")) state.decision_style.prefers_time_over_money = clamp(state.decision_style.prefers_time_over_money + 0.1, -1, 1);
      break;
    }
  }

  const openIds = Object.keys(state.tasks).filter(id => state.tasks[id].status === "open").slice(0, 100);
  for (const id of openIds) state.tasks[id].urgency = computeUrgency(state.tasks[id], now);

  return state;
}

function trimSeen(seenMap, keepN) {
  const entries = Object.entries(seenMap);
  if (entries.length <= keepN) return seenMap;
  entries.sort((a, b) => a[1] - b[1]);
  const drop = entries.length - keepN;
  for (let i = 0; i < drop; i++) delete seenMap[entries[i][0]];
  return seenMap;
}

// Durable Object "brain" (one per person_id)
export class LifeDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    const personId = req.headers.get("x-person-id") || "unknown";

    if (req.method === "GET" && url.pathname === "/state") {
      const cursor = (await this.state.storage.get("cursor")) ?? 0;
      const lifeState = (await this.state.storage.get("life_state")) ?? defaultLifeState();
      return json({ ok: true, cursor, state: lifeState, server_time: Date.now() });
    }

    if (req.method === "POST" && url.pathname === "/events:batch") {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.events)) return bad("Expected JSON: { events: [...] }");

      let cursor = (await this.state.storage.get("cursor")) ?? 0;
      let lifeState = (await this.state.storage.get("life_state")) ?? defaultLifeState();
      let seen = (await this.state.storage.get("seen_event_ids")) ?? {};
      const now = Date.now();

      const accepted = [];
      const rejected = [];

      if (body.events.length > 100) return bad("Too many events (max 100).");

      for (const e of body.events) {
        const err = validateEvent(e);
        if (err) { rejected.push({ event_id: e?.event_id, reason: err }); continue; }

        if (seen[e.event_id]) {
          accepted.push({ event_id: e.event_id, cursor: seen[e.event_id], deduped: true });
          continue;
        }

        cursor += 1;
        lifeState = applyEvent(lifeState, e, now);

        seen[e.event_id] = cursor;
        accepted.push({ event_id: e.event_id, cursor });
      }

      seen = trimSeen(seen, 500);

      await this.state.storage.put("cursor", cursor);
      await this.state.storage.put("life_state", lifeState);
      await this.state.storage.put("seen_event_ids", seen);

      // Persist accepted events to D1 (best-effort)
      if (this.env.DB && accepted.length > 0) {
        const stmts = [];
        for (const a of accepted) {
          if (a.deduped) continue;
          const e = body.events.find(x => x.event_id === a.event_id);
          if (!e) continue;

          stmts.push(
            this.env.DB.prepare(
              "INSERT OR IGNORE INTO person_events (person_id, cursor, event_id, ts, server_ts, kind, schema_v, payload_json) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(
              personId,
              a.cursor,
              e.event_id,
              e.ts,
              now,
              e.kind,
              e.schema_v,
              JSON.stringify(e.payload)
            )
          );
        }
        if (stmts.length) await this.env.DB.batch(stmts);
      }

      return json({ ok: true, cursor, accepted, rejected });
    }

    return bad("Not found", 404);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    // Health
    if (url.pathname === "/v1/health") return json({ ok: true, server_time: Date.now() });

    // Admin: create/register a persona key
    if (req.method === "POST") {
      const m = url.pathname.match(/^\/v1\/persons\/([^/]+)\/keys$/);
      if (m) {
        const personId = decodeURIComponent(m[1]);
        const master = getBearer(req);
        if (!master || master !== env.MASTER_KEY) return bad("Forbidden", 403);

        const body = await readJson(req);
        const token = body?.token;
        if (!token || typeof token !== "string" || token.length < 12) {
          return bad("Expected JSON: { token: \"long-random-string\" }");
        }
        if (!env.DB) return bad("Missing D1 binding DB", 500);
        if (!env.AUTH_PEPPER) return bad("Missing secret AUTH_PEPPER", 500);

        const now = Date.now();

        await env.DB.prepare(
          "INSERT INTO persons (person_id, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(person_id) DO UPDATE SET updated_at=excluded.updated_at"
        ).bind(personId, now, now, "{}").run();

        const hash = await sha256Hex(`${personId}:${token}:${env.AUTH_PEPPER}`);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO persona_keys (person_id, api_key_hash, created_at) VALUES (?, ?, ?)"
        ).bind(personId, hash, now).run();

        return json({ ok: true, person_id: personId });
      }
    }

    // Person routes -> DO
    const parsed = parsePersonRoute(url.pathname);
    if (!parsed) return bad("Not found", 404);
    if (!env.LIFE_DO) return bad("Missing Durable Object binding LIFE_DO", 500);

    // Require auth for writes
    if (parsed.action === "events:batch") {
      const auth = await requirePersonaAuth(req, env, parsed.personId);
      if (!auth.ok) return bad(auth.error, auth.status);
    }

    const id = env.LIFE_DO.idFromName(parsed.personId);
    const stub = env.LIFE_DO.get(id);

    const innerUrl = new URL(req.url);
    innerUrl.pathname = parsed.action === "state" ? "/state" : "/events:batch";

    const headers = new Headers(req.headers);
    headers.set("x-person-id", parsed.personId);

    return stub.fetch(new Request(innerUrl.toString(), {
      method: req.method,
      headers,
      body: req.method === "GET" ? null : req.body
    }));
  }
};
