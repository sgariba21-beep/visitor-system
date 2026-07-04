import { useState, useEffect, useRef } from "react";
import { supabase } from "../../lib/supabaseClient";
import Papa from "papaparse";
import Spinner from "../../components/Spinner";

// ─── Possible UI modes ───────────────────────────────────────────────────────
// "list"   → default view, shows all students
// "add"    → inline form to add one student
// "edit"   → inline form to edit a student
// "import" → CSV import panel

export default function StudentsPage() {
  const [students, setStudents]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [mode, setMode]           = useState("list");
  const [editTarget, setEditTarget] = useState(null); // student being edited
  const [search, setSearch]       = useState("");
  const [feedback, setFeedback]   = useState(null);  // { type, message }

  // Form state (shared between add and edit)
  const [form, setForm] = useState({ name: "", class: "", studentId: "" });

  // CSV import state
  const [csvRows, setCsvRows]       = useState([]);  // parsed rows preview
  const [importing, setImporting]   = useState(false);
  const fileInputRef                = useRef();

  // ── Load students from Firestore on mount ──────────────────────────────────
  useEffect(() => {
    loadStudents();
  }, []);

  async function loadStudents() {
    setLoading(true);
    try {
      const { data, error } = await supabase.from("students").select("*").order("name");
      if (error) throw error;
      setStudents(data);
    } catch (err) {
      showFeedback("error", "Failed to load students.");
    } finally {
      setLoading(false);
    }
  }

  // Looks up who already holds a given Student ID, for a friendlier
  // duplicate-ID error message than the raw DB constraint gives us.
  async function findDuplicateHolder(studentId, excludeId) {
    let request = supabase.from("students").select("name").eq("student_id", studentId);
    if (excludeId) request = request.neq("id", excludeId);
    const { data } = await request.maybeSingle();
    return data?.name;
  }

  // ── Feedback helper ────────────────────────────────────────────────────────
  function showFeedback(type, message) {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 4000); // auto-dismiss after 4s
  }

  // ── Form helpers ───────────────────────────────────────────────────────────
  function openAdd() {
    setForm({ name: "", class: "", studentId: "" });
    setEditTarget(null);
    setMode("add");
  }

  function openEdit(student) {
    setForm({
      name: student.name,
      class: student.class,
      studentId: student.student_id || ""
    });
    setEditTarget(student);
    setMode("edit");
  }

  function cancelForm() {
    setMode("list");
    setEditTarget(null);
  }

  // ── Add one student ────────────────────────────────────────────────────────
  async function handleAdd(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.class.trim()) return;

    try {
      const { data, error } = await supabase.from("students").insert({
        name:       form.name.trim(),
        class:      form.class.trim(),
        student_id: form.studentId.trim() || null,
      }).select().single();

      if (error) {
        if (error.code === "23505") {
          const holder = await findDuplicateHolder(form.studentId.trim());
          showFeedback("error",
            `Student ID "${form.studentId.trim()}" is already assigned` +
            (holder ? ` to ${holder}.` : ".")
          );
          return;
        }
        throw error;
      }

      setStudents(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      showFeedback("success", `${form.name} added successfully.`);
      setMode("list");
    } catch {
      showFeedback("error", "Failed to add student.");
    }
  }

  // ── Edit a student ─────────────────────────────────────────────────────────
  async function handleEdit(e) {
    e.preventDefault();

    try {
      const { data, error } = await supabase.from("students").update({
        name:       form.name.trim(),
        class:      form.class.trim(),
        student_id: form.studentId.trim() || null,
      }).eq("id", editTarget.id).select().single();

      if (error) {
        if (error.code === "23505") {
          const holder = await findDuplicateHolder(form.studentId.trim(), editTarget.id);
          showFeedback("error",
            `Student ID "${form.studentId.trim()}" is already assigned` +
            (holder ? ` to ${holder}.` : ".")
          );
          return;
        }
        throw error;
      }

      setStudents(prev => prev.map(s => (s.id === editTarget.id ? data : s)));
      showFeedback("success", `${form.name} updated.`);
      setMode("list");
    } catch {
      showFeedback("error", "Failed to update student.");
    }
  }

  // ── Soft delete (deactivate) ───────────────────────────────────────────────
  // Use this for students who have existing visit records.
  // They disappear from the registration form but history is preserved.
  async function handleSoftDelete(student) {
    if (!window.confirm(
      `Deactivate ${student.name}? They will be hidden from new registrations ` +
      `but visit history is preserved.`
    )) return;

    try {
      const { error } = await supabase.from("students").update({ is_active: false }).eq("id", student.id);
      if (error) throw error;
      setStudents(prev => prev.map(s =>
        s.id === student.id ? { ...s, is_active: false } : s
      ));
      showFeedback("success", `${student.name} deactivated.`);
    } catch {
      showFeedback("error", "Failed to deactivate student.");
    }
  }

  // ── Reactivate ─────────────────────────────────────────────────────────────
  async function handleReactivate(student) {
    try {
      const { error } = await supabase.from("students").update({ is_active: true }).eq("id", student.id);
      if (error) throw error;
      setStudents(prev => prev.map(s =>
        s.id === student.id ? { ...s, is_active: true } : s
      ));
      showFeedback("success", `${student.name} reactivated.`);
    } catch {
      showFeedback("error", "Failed to reactivate.");
    }
  }

  // ── Hard delete (permanent) ────────────────────────────────────────────────
  async function handleHardDelete(student) {
    if (!window.confirm(
      `⚠️ PERMANENTLY delete ${student.name}? ` +
      `This cannot be undone and may break visit history records.`
    )) return;
    // Second confirmation for destructive action
    if (!window.confirm(`Are you absolutely sure? This deletes all data for ${student.name}.`)) return;

    try {
      const { error } = await supabase.from("students").delete().eq("id", student.id);
      if (error) throw error;
      setStudents(prev => prev.filter(s => s.id !== student.id));
      showFeedback("success", `${student.name} permanently deleted.`);
    } catch {
      showFeedback("error", "Failed to delete student.");
    }
  }

  // ── CSV Import ─────────────────────────────────────────────────────────────
  // Expected CSV columns: name, class, studentId (header row required)
  function handleCsvFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,          // First row is column headers
      skipEmptyLines: true,
      complete: (results) => {
        // Validate that expected columns exist
        const required = ["name", "class"];
        const headers  = Object.keys(results.data[0] || {});
        const missing  = required.filter(r => !headers.includes(r));

        if (missing.length > 0) {
          showFeedback("error", 
            `CSV missing columns: ${missing.join(", ")}. ` +
            `Required: name, class. Optional: studentId`
          );
          setCsvRows([]);
          return;
        }
        setCsvRows(results.data);
        setMode("import");
      },
      error: () => showFeedback("error", "Could not read CSV file."),
    });
  }

  async function confirmCsvImport() {
    setImporting(true);
    let added = 0;
    let skipped = 0;
    try {
      for (const row of csvRows) {
        if (!row.name?.trim() || !row.class?.trim()) continue; // skip blank rows
        const rowId = row.studentId?.trim() || "";
        // Duplicate-ID rejection is enforced by the DB's partial unique index,
        // including against rows inserted earlier in this same batch.
        const { error } = await supabase.from("students").insert({
          name:       row.name.trim(),
          class:      row.class.trim(),
          student_id: rowId || null,
        });
        if (error) {
          if (error.code === "23505") {
            skipped++;
            continue;
          }
          throw error;
        }
        added++;
      }
      await loadStudents(); // Reload full list
      const msg = skipped > 0
        ? `Imported ${added} students. Skipped ${skipped} duplicate student ID(s).`
        : `Imported ${added} students successfully.`;
      showFeedback(skipped > 0 ? "error" : "success", msg);
      setMode("list");
      setCsvRows([]);
    } catch {
      showFeedback("error", "Import failed partway. Check the Students list for partial data.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ── Filtered student list (by search query) ────────────────────────────────
  const filtered = students.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.class.toLowerCase().includes(search.toLowerCase()) ||
    (s.student_id || "").toLowerCase().includes(search.toLowerCase())
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={styles.page} className="admin-page">

      {/* ── Page header ── */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Students</h1>
          <p style={styles.subtitle}>{students.length} total · {students.filter(s => s.is_active).length} active</p>
        </div>
        <div style={styles.headerActions}>
          {/* Hidden file input triggered by the Import button */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            onChange={handleCsvFile}
          />
          <button style={styles.btnSecondary} onClick={() => fileInputRef.current.click()}>
            📥 Import CSV
          </button>
          <button style={styles.btnPrimary} onClick={openAdd}>
            + Add Student
          </button>
        </div>
      </div>

      {/* ── Feedback banner ── */}
      {feedback && (
        <div style={{
          ...styles.feedback,
          background: feedback.type === "success" ? "#f0fdf4" : "#fef2f2",
          borderColor: feedback.type === "success" ? "#86efac" : "#fca5a5",
          color:       feedback.type === "success" ? "#166534" : "#991b1b",
        }}>
          {feedback.type === "success" ? "✅" : "❌"} {feedback.message}
        </div>
      )}

      {/* ── Add / Edit form ── */}
      {(mode === "add" || mode === "edit") && (
        <div style={styles.formCard}>
          <h2 style={styles.formTitle}>
            {mode === "add" ? "Add New Student" : `Edit — ${editTarget.name}`}
          </h2>
          <form onSubmit={mode === "add" ? handleAdd : handleEdit} style={styles.formGrid}>
            <div style={styles.field}>
              <label style={styles.label}>Full Name *</label>
              <input
                style={styles.input}
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="Kwame Mensah"
                required
                autoFocus
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Class *</label>
              <input
                style={styles.input}
                value={form.class}
                onChange={e => setForm(p => ({ ...p, class: e.target.value }))}
                placeholder="2 Science 1"
                required
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Student ID *</label>
              <input
                style={styles.input}
                value={form.studentId}
                onChange={e => setForm(p => ({ ...p, studentId: e.target.value }))}
                placeholder="e.g. STU-001"
                required
              />
            </div>
            <div style={styles.formActions}>
              <button type="button" style={styles.btnGhost} onClick={cancelForm}>
                Cancel
              </button>
              <button type="submit" style={styles.btnPrimary}>
                {mode === "add" ? "Add Student" : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── CSV Import preview ── */}
      {mode === "import" && (
        <div style={styles.formCard}>
          <h2 style={styles.formTitle}>Preview Import — {csvRows.length} rows</h2>
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Name</th>
                  <th style={styles.th}>Class</th>
                  <th style={styles.th}>Student ID</th>
                </tr>
              </thead>
              <tbody>
                {csvRows.slice(0, 10).map((row, i) => (
                  <tr key={i}>
                    <td style={styles.td}>{row.name}</td>
                    <td style={styles.td}>{row.class}</td>
                    <td style={styles.td}>{row.studentId || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {csvRows.length > 10 && (
              <p style={{ color: "#6b7280", fontSize: 13, marginTop: 8 }}>
                ... and {csvRows.length - 10} more rows
              </p>
            )}
          </div>
          <div style={styles.formActions}>
            <button style={styles.btnGhost} onClick={() => { setMode("list"); setCsvRows([]); }}>
              Cancel
            </button>
            <button style={styles.btnPrimary} onClick={confirmCsvImport} disabled={importing}>
              {importing ? <Spinner size={16} color="#fff" /> : `Import ${csvRows.length} Students`}
            </button>
          </div>
        </div>
      )}

      {/* ── Search ── */}
      {mode === "list" && (
        <input
          style={{ ...styles.input, marginBottom: 16, maxWidth: 360 }}
          placeholder="🔍  Search by name, class, or ID..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      )}

      {/* ── Students table ── */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spinner size={36} />
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Class</th>
                <th style={styles.th}>ID</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ ...styles.td, textAlign: "center", 
                                           color: "#9ca3af", padding: 32 }}>
                    {search ? "No students match your search." : "No students yet. Add one above."}
                  </td>
                </tr>
              ) : (
                filtered.map(student => (
                  <tr key={student.id} style={{
                    opacity: student.is_active ? 1 : 0.5,
                    background: student.is_active ? "transparent" : "#f9fafb"
                  }}>
                    <td style={styles.td}>{student.name}</td>
                    <td style={styles.td}>{student.class}</td>
                    <td style={styles.td}>{student.student_id || "—"}</td>
                    <td style={styles.td}>
                      <span style={{
                        ...styles.badge,
                        background: student.is_active ? "#dcfce7" : "#f3f4f6",
                        color:      student.is_active ? "#166534" : "#6b7280",
                      }}>
                        {student.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ ...styles.td, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button style={styles.actionBtn} onClick={() => openEdit(student)}>
                        ✏️ Edit
                      </button>
                      {student.is_active ? (
                        <button
                          style={{ ...styles.actionBtn, color: "#d97706" }}
                          onClick={() => handleSoftDelete(student)}
                        >
                          🔒 Deactivate
                        </button>
                      ) : (
                        <button
                          style={{ ...styles.actionBtn, color: "#2563eb" }}
                          onClick={() => handleReactivate(student)}
                        >
                          🔓 Reactivate
                        </button>
                      )}
                      <button
                        style={{ ...styles.actionBtn, color: "#dc2626" }}
                        onClick={() => handleHardDelete(student)}
                      >
                        🗑️ Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page:    { padding: 32, maxWidth: 1100, margin: "0 auto" },
  header:  { display: "flex", justifyContent: "space-between", 
             alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  title:   { fontSize: 26, fontWeight: 700, color: "#0f172a" },
  subtitle:{ fontSize: 14, color: "#6b7280", marginTop: 2 },
  headerActions: { display: "flex", gap: 10 },

  formCard:    { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
                 padding: 24, marginBottom: 24 },
  formTitle:   { fontSize: 17, fontWeight: 600, color: "#0f172a", marginBottom: 20 },
  formGrid:    { display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", 
                 gap: 16, alignItems: "end" },
  formActions: { display: "flex", gap: 10, justifyContent: "flex-end", 
                 gridColumn: "1 / -1" },

  field:  { display: "flex", flexDirection: "column", gap: 6 },
  label:  { fontSize: 13, fontWeight: 600, color: "#374151" },
  input:  { padding: "9px 12px", fontSize: 14, border: "1.5px solid #d1d5db",
            borderRadius: 8, outline: "none", width: "100%" },

  feedback: { padding: "10px 16px", borderRadius: 8, border: "1px solid",
              marginBottom: 16, fontSize: 14 },

  table: { width: "100%", borderCollapse: "collapse", background: "#fff",
           borderRadius: 12, overflow: "hidden", 
           boxShadow: "0 1px 3px rgba(0,0,0,0.07)" },
  th:    { padding: "12px 16px", textAlign: "left", fontSize: 12,
           fontWeight: 600, color: "#6b7280", background: "#f9fafb",
           textTransform: "uppercase", letterSpacing: "0.05em",
           borderBottom: "1px solid #e5e7eb" },
  td:    { padding: "12px 16px", fontSize: 14, color: "#374151",
           borderBottom: "1px solid #f3f4f6" },

  badge: { padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 },

  actionBtn:    { padding: "5px 10px", fontSize: 12, background: "transparent",
                  border: "1px solid #e5e7eb", borderRadius: 6, 
                  cursor: "pointer", color: "#374151" },
  btnPrimary:   { padding: "9px 18px", background: "#2563eb", color: "#fff",
                  border: "none", borderRadius: 8, cursor: "pointer",
                  fontSize: 14, fontWeight: 600, display: "flex",
                  alignItems: "center", gap: 6 },
  btnSecondary: { padding: "9px 18px", background: "#fff", color: "#374151",
                  border: "1.5px solid #d1d5db", borderRadius: 8, 
                  cursor: "pointer", fontSize: 14, fontWeight: 500 },
  btnGhost:     { padding: "9px 18px", background: "transparent", color: "#6b7280",
                  border: "none", cursor: "pointer", fontSize: 14 },
};