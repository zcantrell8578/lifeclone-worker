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

function parsePath(pathname) {
  const m = pathname.match(/^\/v1\/persons\/([^/]+)\/(state|events:batch)$/);
  if (!m) return null;
  return { personId: decodeURIComponent(m[1]), action: m[2] };
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
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

      return json({ ok: true, cursor, accepted, rejected });
    }

    return bad("Not found", 404);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    if (url.pathname === "/v1/health") {
      return json({ ok: true, server_time: Date.now() });
    }

    const parsed = parsePath(url.pathname);
    if (!parsed) return bad("Not found", 404);

    if (!env.LIFE_DO) return bad("Missing Durable Object binding LIFE_DO", 500);

    const id = env.LIFE_DO.idFromName(parsed.personId);
    const stub = env.LIFE_DO.get(id);

    const inner = new URL(req.url);
    inner.pathname = parsed.action === "state" ? "/state" : "/events:batch";

    return stub.fetch(new Request(inner.toString(), req));
  }
};

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
