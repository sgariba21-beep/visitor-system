import { supabase } from "./supabaseClient";
import { offlineDb } from "./offlineDb";

// Races a promise against a timeout. Offline (or on a flaky connection),
// Supabase requests can hang; this lets the UI move on after `ms`,
// trusting the outbox to durably retry the write/read later.
export async function withOfflineTimeout(promise, ms = 2500) {
  let timedOut = false;
  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve(undefined);
    }, ms);
  });

  const settled = await Promise.race([
    promise.then((r) => ({ ok: !r.error, data: r.data, error: r.error })),
    timeout,
  ]);

  if (timedOut || !settled) return { ok: false, timedOut: true };
  return settled;
}

// ── Cache warming ────────────────────────────────────────────────────────
// Replaces Firestore's automatic offline cache warm: fetches today's visits
// (with their joined visit_students) and active students, and mirrors them
// into Dexie so Gate-page reads can fall back to them when offline.
//
// Today's visit list is PII for every visitor that day, so it's fetched
// through the PIN-gated gate_list_today_visits RPC rather than a raw table
// select — visits_anon_select no longer exists (see 0012_gate_read_rpcs).
export async function warmCache(pin) {
  const [visitsRes, studentsRes] = await Promise.all([
    supabase.rpc("gate_list_today_visits", { p_pin: pin }),
    // students is no longer anon-readable directly (see
    // 0013_student_id_verification) — search_active_students('') lists
    // all active students without exposing student_id.
    supabase.rpc("search_active_students", { p_query: "" }),
  ]);

  if (!visitsRes.error && visitsRes.data) {
    await offlineDb.visits.clear();
    await offlineDb.visits.bulkPut(visitsRes.data);
  }
  if (!studentsRes.error && studentsRes.data) {
    await offlineDb.students.clear();
    await offlineDb.students.bulkPut(studentsRes.data);
  }

  return { visitsOk: !visitsRes.error, studentsOk: !studentsRes.error, visitsError: visitsRes.error };
}

export function getCachedVisits() {
  return offlineDb.visits.toArray();
}

export function getCachedStudents() {
  return offlineDb.students.toArray();
}

// Keeps the local mirror consistent with an optimistic UI update, so a
// reload while still offline reflects the latest known state rather than
// stale pre-action data.
export async function updateCachedVisit(id, patch) {
  const existing = await offlineDb.visits.get(id);
  if (existing) await offlineDb.visits.put({ ...existing, ...patch });
}

// ── Reads with local fallback ───────────────────────────────────────────
// A single visit by its exact token is scoped to whoever already holds
// that token (a capability, not a broad listing), so no PIN is required.
export async function lookupVisitByToken(token) {
  const remote = await withOfflineTimeout(
    supabase.rpc("get_visit_by_token", { p_qr_token: token }),
    2000
  );
  if (remote.ok && remote.data) return remote.data;

  return offlineDb.visits.where("qr_token").equals(token).first();
}

// ── Gate PIN caching ─────────────────────────────────────────────────────
// The server never hands back the real PIN value (verify_gate_pin only
// returns true/false, and gate_settings.pin is no longer anon-readable).
// So instead of fetching "the correct PIN", we cache the PIN the user
// typed *after* the server has confirmed it's correct — that's how the
// PIN screen keeps working offline, without the value ever being readable
// by anyone who hasn't already typed the right one at least once online.
export async function getCachedPin() {
  const row = await offlineDb.settings.get("gate_pin");
  return row?.value ?? null;
}

export async function cacheConfirmedPin(pin) {
  await offlineDb.settings.put({ key: "gate_pin", value: pin });
}

export async function clearCachedPin() {
  await offlineDb.settings.delete("gate_pin");
}

// ── Outbox: durable queue for writes that failed/timed out live ────────
let flushing = false;

export async function enqueue(type, payload) {
  const local_id = await offlineDb.outbox.add({
    type,
    payload,
    status: "pending",
    attempts: 0,
    created_at: Date.now(),
  });
  flushOutbox(); // fire-and-forget attempt now; no-op if still offline
  return local_id;
}

// isPinRejectedError: errcode P0005 means the gate PIN was rotated since
// this device last logged in (or the cached PIN is simply wrong) — the
// caller should clear the local session and force a fresh PIN entry
// rather than treating it as a generic offline/failure case.
export function isPinRejectedError(error) {
  return error?.code === "P0005";
}

async function sendMutation(item) {
  const { type, payload } = item;
  if (type === "check_in") {
    return supabase.rpc("check_in_visit", { p_qr_token: payload.qrToken, p_pin: payload.pin });
  }
  if (type === "check_out") {
    return supabase.rpc("check_out_visit", { p_qr_token: payload.qrToken, p_pin: payload.pin });
  }
  if (type === "walk_in") {
    return supabase.rpc("create_visit", payload.rpcArgs); // rpcArgs already includes p_pin
  }
  throw new Error(`Unknown outbox mutation type: ${type}`);
}

// Errcode P0001 from check_in_visit/check_out_visit means the transition
// already happened (e.g. a previous attempt actually landed before the
// response was lost) — treat that as a successful, idempotent no-op rather
// than a real failure, so a retried outbox item doesn't get stuck forever.
function isAlreadyAppliedError(error) {
  return error?.code === "P0001";
}

export async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const pending = await offlineDb.outbox.where("status").anyOf(["pending", "failed"]).toArray();

    for (const item of pending) {
      await offlineDb.outbox.update(item.local_id, { status: "syncing" });
      try {
        const { error } = await sendMutation(item);
        if (error && !isAlreadyAppliedError(error)) throw error;
        await offlineDb.outbox.delete(item.local_id);
      } catch (err) {
        await offlineDb.outbox.update(item.local_id, {
          status: "failed",
          attempts: item.attempts + 1,
          last_error: String(err?.message || err),
        });
      }
    }
  } finally {
    flushing = false;
  }
}

export function getOutboxCount() {
  return offlineDb.outbox.count();
}
