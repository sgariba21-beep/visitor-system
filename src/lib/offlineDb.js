import Dexie from "dexie";

// Local read-mirrors + write-outbox backing the Gate page's offline support.
// visits/students are always fully overwritten by warmCache() (never
// partially patched) to avoid drift from the server's source of truth.
export const offlineDb = new Dexie("vms_gate_cache");

offlineDb.version(1).stores({
  visits: "id, qr_token, visit_date, status",
  students: "id, name, class",
  outbox: "++local_id, type, status, created_at",
  settings: "key",
});
