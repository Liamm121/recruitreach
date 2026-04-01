import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const STAGES = [
  { id: "outreach1",  label: "1st Message",  color: "#4a9eff", icon: "📤", daysAfter: null },
  { id: "outreach2",  label: "Follow Up",    color: "#f0a500", icon: "🔁", daysAfter: 2 },
  { id: "outreach3",  label: "Final Chase",  color: "#ff6b4a", icon: "🔥", daysAfter: 4 },
  { id: "interested", label: "Interested",   color: "#4ae08a", icon: "⭐", daysAfter: null },
  { id: "placed",     label: "Placed",       color: "#b44aff", icon: "✅", daysAfter: null },
  { id: "noresponse", label: "No Response",  color: "#444460", icon: "🚫", daysAfter: null },
];
const SM = Object.fromEntries(STAGES.map(s => [s.id, s]));
const CHANNELS = ["whatsapp", "linkedin", "email"];

const daysSince = d => d ? Math.floor((Date.now() - new Date(d)) / 86400000) : null;
const isDue = c => {
  const s = SM[c.stage];
  if (!s?.daysAfter || ["interested","placed","noresponse"].includes(c.stage)) return false;
  return daysSince(c.last_contacted_at) >= s.daysAfter;
};
const needsAction = c => !["placed","noresponse"].includes(c.stage) && (!c.last_contacted_at || isDue(c));

const SYS = `You are an expert recruitment consultant writing outreach messages to candidates.
Tone: Friendly but professional. Never salesy or pushy. Human and genuine.
WhatsApp/SMS: 3-5 sentences max. LinkedIn: 4-6 sentences. Email: concise with subject line.
Always end with a clear, low-pressure call to action.`;

const SAMPLE_CSV = `name,currentTitle,experience,roleTitle,roleLocation,roleSalary,channel,notes
Jamie Smith,Site Manager,8 years civils NVQ L6,Senior Site Manager,Manchester,55000,whatsapp,Start ASAP
Sarah Jones,Quantity Surveyor,5 years residential,Senior QS,Leeds,50000,linkedin,Temp to perm`;

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/\s+/g, ""));
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return {
      name: obj.name || "",
      current_title: obj.currenttitle || obj.jobtitle || obj.title || "",
      experience: obj.experience || obj.background || "",
      role_title: obj.roletitle || obj.role || obj.position || "",
      role_location: obj.rolelocation || obj.location || "",
      role_salary: obj.rolesalary || obj.salary || obj.rate || "",
      channel: CHANNELS.includes(obj.channel) ? obj.channel : "whatsapp",
      notes: obj.notes || "",
    };
  }).filter(r => r.current_title || r.role_title);
}

const IS = { width: "100%", background: "#13141f", border: "1px solid #252535", borderRadius: 8, padding: "9px 12px", color: "#ddd9f0", fontSize: 13, fontFamily: "inherit", outline: "none", resize: "vertical" };

export default function App() {
  const [view, setView] = useState("digest");
  const [candidates, setCands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(() => { try { return JSON.parse(localStorage.getItem("rr_settings") || "{}"); } catch { return {}; } });
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [generating, setGen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [toast, setToast] = useState("");
  const [csvModal, setCsvModal] = useState(false);
  const [csvPreview, setCsvPreview] = useState([]);
  const [csvError, setCsvError] = useState("");
  const fileRef = useRef();
  const blank = { name: "", current_title: "", experience: "", role_title: "", role_location: "", role_salary: "", channel: "whatsapp", notes: "" };
  const [form, setForm] = useState(blank);

  const showToast = msg => { setToast(msg); setTimeout(() => setToast(""), 2800); };

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from("candidates").select("*").order("created_at", { ascending: false });
    if (!error) setCands(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchCandidates(); }, [fetchCandidates]);

  const addCandidate = async (formData) => {
    const { data, error } = await supabase.from("candidates").insert([{ ...formData, stage: "outreach1", messages: [] }]).select();
    if (!error && data) { setCands(prev => [data[0], ...prev]); showToast("Candidate added ✓"); return true; }
    showToast("Error adding candidate"); return false;
  };

  const updateCandidate = async (id, updates) => {
    const { data, error } = await supabase.from("candidates").update(updates).eq("id", id).select();
    if (!error && data) { setCands(prev => prev.map(c => c.id === id ? data[0] : c)); }
  };

  const deleteCandidate = async (id) => {
    await supabase.from("candidates").delete().eq("id", id);
    setCands(prev => prev.filter(c => c.id !== id));
    setSelected(null); setView("pipeline"); showToast("Removed");
  };

  const importCSV = async () => {
    const rows = csvPreview.map(r => ({ ...r, stage: "outreach1", messages: [] }));
    const { data, error } = await supabase.from("candidates").insert(rows).select();
    if (!error && data) { setCands(prev => [...data, ...prev]); setCsvModal(false); setCsvPreview([]); showToast(`${data.length} candidates imported ✓`); }
    else { showToast("Import failed — try again"); }
  };

  const generateMsg = async (c, stageOverride) => {
    const stage = stageOverride || c.stage;
    setGen(c.id + stage);
    const stageLabel = SM[stage]?.label || stage;
    const prev = (c.messages || []).map(m => `[${m.stageLabel} via ${m.channel}]: ${m.text}`).join("\n");
    const prompt = `Write a ${stageLabel} recruitment outreach message.
Recruiter: ${settings.recruiterName || "the recruiter"} from ${settings.agencyName || "our agency"}
Candidate: ${c.name || "not specified"}, current role: ${c.current_title}
Experience: ${c.experience || "not specified"}
Recruiting for: ${c.role_title}${c.role_location ? `, ${c.role_location}` : ""}${c.role_salary ? `, £${c.role_salary}` : ""}
Channel: ${c.channel}. Notes: ${c.notes || "none"}
${prev ? `Previous messages:\n${prev}` : ""}
${stage !== "outreach1" ? "This is a follow-up — reference no reply, keep brief and friendly." : ""}
Return ONLY valid JSON no markdown: {"whatsapp":"...","linkedin":"...","email":{"subject":"...","body":"..."}}`;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: SYS, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      const txt = data.content.map(i => i.text || "").join("");
      const parsed = JSON.parse(txt.replace(/```json|```/g, "").trim());
      const ch = c.channel;
      const text = ch === "email" ? parsed.email.body : ch === "linkedin" ? parsed.linkedin : parsed.whatsapp;
      const ns = nextStage(stage);
      setPreview({ candidateId: c.id, channel: ch, text, subject: ch === "email" ? parsed.email.subject : null, stageLabel, nextStage: ns, all: parsed });
    } catch { showToast("Generation failed — try again"); }
    setGen(false);
  };

  const nextStage = s => { const o = ["outreach1","outreach2","outreach3","interested","placed"]; const i = o.indexOf(s); return i >= 0 && i < o.length - 1 ? o[i + 1] : s; };

  const confirmSent = async () => {
    if (!preview) return;
    const c = candidates.find(x => x.id === preview.candidateId);
    if (!c) return;
    const newMessages = [...(c.messages || []), { stageLabel: preview.stageLabel, channel: preview.channel, text: preview.text, sentAt: new Date().toISOString() }];
    await updateCandidate(preview.candidateId, { stage: preview.nextStage, last_contacted_at: new Date().toISOString(), messages: newMessages });
    setPreview(null); showToast("Marked as sent ✓");
  };

  const moveStage = async (id, stage) => { await updateCandidate(id, { stage }); };

  const handleAddSubmit = async () => {
    if (!form.current_title || !form.role_title) return;
    const ok = await addCandidate(form);
    if (ok) { setForm(blank); setView("pipeline"); }
  };

  const handleFile = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const rows = parseCSV(ev.target.result);
      if (!rows.length) { setCsvError("No valid rows found. Check columns match the template."); setCsvPreview([]); }
      else { setCsvPreview(rows); setCsvError(""); }
    };
    reader.readAsText(file);
  };

  const dueToday = candidates.filter(needsAction);
  const dueCount = dueToday.length;
  const stageCounts = Object.fromEntries(STAGES.map(s => [s.id, candidates.filter(c => c.stage === s.id).length]));
  const filtered = candidates.filter(c => filter === "all" ? true : filter === "due" ? isDue(c) : c.stage === filter);

  return (
    <div style={{ minHeight: "100vh", background: "#07080f", color: "#ddd9f0", fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Playfair+Display:wght@700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#0d0e1a}::-webkit-scrollbar-thumb{background:#2a2a40;border-radius:4px}
        input,textarea,select{color-scheme:dark}
        input::placeholder,textarea::placeholder{color:#3a3a55}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
        .card{animation:fadeIn .22s ease forwards}
        .btn-p{background:linear-gradient(135deg,#4a9eff,#7b6fff);color:#fff;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;transition:opacity .15s}
        .btn-p:hover{opacity:.85}.btn-p:disabled{opacity:.4;cursor:not-allowed}
        .btn-g{background:transparent;color:#8885aa;border:1px solid #252535;border-radius:8px;padding:9px 18px;cursor:pointer;font-size:13px;font-family:inherit;transition:all .15s}
        .btn-g:hover{border-color:#4a4a65;color:#ddd9f0}
      `}</style>

      {toast && <div style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)", background:"#1a2a1a", color:"#6be06b", border:"1px solid #2a4a2a", borderRadius:10, padding:"10px 22px", fontSize:13, fontWeight:600, zIndex:9999, animation:"slideUp .2s ease" }}>{toast}</div>}

      {preview && (() => {
        const cand = candidates.find(c => c.id === preview.candidateId);
        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.78)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
            <div style={{ background:"#0f1020", border:"1px solid #252540", borderRadius:16, width:"100%", maxWidth:520, animation:"slideUp .2s ease" }}>
              <div style={{ padding:"20px 24px", borderBottom:"1px solid #1a1a2e" }}>
                <div style={{ fontSize:16, fontWeight:700, color:"#f0eeff" }}>Approve & Send</div>
                <div style={{ fontSize:12, color:"#6b6880", marginTop:3 }}>{cand?.name || cand?.current_title} · {preview.stageLabel} via {preview.channel}</div>
              </div>
              {preview.subject && <div style={{ padding:"12px 24px", background:"#0c0d1c", borderBottom:"1px solid #1a1a2e" }}><div style={{ fontSize:11, color:"#4a9eff", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Subject</div><div style={{ fontSize:13, color:"#ccc8e0" }}>{preview.subject}</div></div>}
              <div style={{ padding:"20px 24px" }}>
                <div style={{ background:"#13141f", borderRadius:10, padding:16, fontSize:14, lineHeight:1.75, color:"#c8c4dc", border:"1px solid #1e1e30", whiteSpace:"pre-wrap", maxHeight:220, overflowY:"auto" }}>{preview.text}</div>
                <div style={{ display:"flex", gap:8, marginTop:14, justifyContent:"space-between", flexWrap:"wrap" }}>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    <button className="btn-g" style={{ fontSize:12 }} onClick={() => { navigator.clipboard.writeText(preview.text); showToast("Copied!"); }}>Copy</button>
                    {CHANNELS.filter(ch => ch !== preview.channel).map(ch => (
                      <button key={ch} className="btn-g" style={{ fontSize:11 }} onClick={() => {
                        const t = ch === "email" ? preview.all.email.body : ch === "linkedin" ? preview.all.linkedin : preview.all.whatsapp;
                        setPreview({ ...preview, channel:ch, text:t, subject:ch==="email"?preview.all.email.subject:null });
                      }}>→ {ch}</button>
                    ))}
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button className="btn-g" onClick={() => setPreview(null)}>Cancel</button>
                    <button className="btn-p" onClick={confirmSent}>✓ Mark Sent</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {csvModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.8)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"#0f1020", border:"1px solid #252540", borderRadius:16, width:"100%", maxWidth:600, maxHeight:"85vh", overflowY:"auto", animation:"slideUp .2s ease" }}>
            <div style={{ padding:"20px 24px", borderBottom:"1px solid #1a1a2e", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div><div style={{ fontSize:16, fontWeight:700, color:"#f0eeff" }}>Import from CSV</div><div style={{ fontSize:12, color:"#6b6880", marginTop:2 }}>Upload a CSV from CV Library</div></div>
              <button className="btn-g" style={{ padding:"6px 12px", fontSize:12 }} onClick={() => { setCsvModal(false); setCsvPreview([]); setCsvError(""); }}>✕</button>
            </div>
            <div style={{ padding:"20px 24px" }}>
              <div style={{ background:"#0c1a0c", border:"1px solid #1a3a1a", borderRadius:10, padding:"14px 16px", marginBottom:18 }}>
                <div style={{ fontSize:12, color:"#4ae08a", fontWeight:600, marginBottom:6 }}>📋 Required CSV columns</div>
                <div style={{ fontSize:11, color:"#6b8a6b", fontFamily:"monospace" }}>name, currentTitle, experience, roleTitle, roleLocation, roleSalary, channel, notes</div>
                <button className="btn-g" style={{ fontSize:11, marginTop:10, padding:"6px 14px" }} onClick={() => { const blob = new Blob([SAMPLE_CSV],{type:"text/csv"}); const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="template.csv"; a.click(); }}>⬇ Download template</button>
              </div>
              <div onClick={() => fileRef.current.click()} style={{ border:"2px dashed #252540", borderRadius:10, padding:"28px", textAlign:"center", cursor:"pointer", marginBottom:16 }}>
                <div style={{ fontSize:28, marginBottom:8 }}>📂</div>
                <div style={{ fontSize:14, color:"#8885aa" }}>Click to upload CSV file</div>
              </div>
              <input ref={fileRef} type="file" accept=".csv" style={{ display:"none" }} onChange={handleFile} />
              {csvError && <div style={{ background:"#1a0f0f", border:"1px solid #4a2020", borderRadius:8, padding:"10px 14px", color:"#ff7070", fontSize:13, marginBottom:14 }}>{csvError}</div>}
              {csvPreview.length > 0 && (
                <div>
                  <div style={{ fontSize:12, color:"#4ae08a", fontWeight:600, marginBottom:10 }}>✓ {csvPreview.length} candidates ready</div>
                  <div style={{ maxHeight:200, overflowY:"auto", border:"1px solid #1e1e30", borderRadius:8, marginBottom:16 }}>
                    {csvPreview.map((r,i) => (
                      <div key={i} style={{ padding:"10px 14px", borderBottom:"1px solid #13132a", fontSize:12, display:"flex", gap:12 }}>
                        <span style={{ color:"#f0eeff", fontWeight:600 }}>{r.name || r.current_title}</span>
                        <span style={{ color:"#6b6880" }}>→ {r.role_title}</span>
                        <span style={{ marginLeft:"auto", color:"#4a9eff" }}>{r.channel}</span>
                      </div>
                    ))}
                  </div>
                  <button className="btn-p" onClick={importCSV} style={{ width:"100%" }}>⬆ Import {csvPreview.length} Candidates</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ borderBottom:"1px solid #131325", padding:"0 20px", display:"flex", alignItems:"center", background:"#09091a", height:54, overflowX:"auto" }}>
        <div style={{ fontFamily:"'Playfair Display',serif", fontSize:17, color:"#f0eeff", marginRight:24, whiteSpace:"nowrap", letterSpacing:"-0.5px" }}>Recruit<span style={{ color:"#4a9eff" }}>Reach</span></div>
        {[["digest","🌅 Today"],["pipeline","Pipeline"],["add","+ Add"],["settings","Settings"]].map(([v,label]) => (
          <button key={v} onClick={() => setView(v)} style={{ background:"none", border:"none", color:view===v?"#4a9eff":"#6b6880", borderBottom:`2px solid ${view===v?"#4a9eff":"transparent"}`, padding:"0 14px", height:54, cursor:"pointer", fontSize:13, fontWeight:view===v?600:400, fontFamily:"inherit", whiteSpace:"nowrap" }}>{label}</button>
        ))}
        <button className="btn-g" style={{ marginLeft:"auto", fontSize:12, padding:"6px 14px", whiteSpace:"nowrap" }} onClick={() => setCsvModal(true)}>⬆ Import CSV</button>
        {dueCount > 0 && <div onClick={() => setView("digest")} style={{ marginLeft:8, background:"#ff4a4a22", color:"#ff7070", border:"1px solid #ff4a4a44", borderRadius:20, padding:"4px 14px", fontSize:12, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}>🔔 {dueCount} due</div>}
      </div>

      {loading && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"60vh", flexDirection:"column", gap:16 }}>
          <div style={{ width:36, height:36, border:"3px solid #1e1e2e", borderTop:"3px solid #4a9eff", borderRadius:"50%", animation:"spin 1s linear infinite" }} />
          <div style={{ color:"#6b6880", fontSize:13 }}>Loading candidates...</div>
        </div>
      )}

      {!loading && (
        <>
          {view === "digest" && (
            <div style={{ maxWidth:720, margin:"0 auto", padding:"28px 20px" }}>
              <div style={{ fontFamily:"'Playfair Display',serif", fontSize:24, color:"#f0eeff", marginBottom:4 }}>
                Good {new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}{settings.recruiterName?`, ${settings.recruiterName}`:""}
              </div>
              <div style={{ fontSize:13, color:"#6b6880", marginBottom:28 }}>{new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})} · Here's your outreach for today</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:28 }}>
                {[{label:"Total Candidates",val:candidates.length,color:"#4a9eff"},{label:"Need Action",val:dueCount,color:"#ff6b4a"},{label:"Interested",val:stageCounts.interested||0,color:"#4ae08a"},{label:"Placed",val:stageCounts.placed||0,color:"#b44aff"}].map(s => (
                  <div key={s.label} style={{ background:"#0f1020", border:`1px solid ${s.color}33`, borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ fontSize:26, fontWeight:700, color:s.color }}>{s.val}</div>
                    <div style={{ fontSize:11, color:"#6b6880", marginTop:3 }}>{s.label}</div>
                  </div>
                ))}
              </div>
              {dueToday.length === 0 ? (
                <div style={{ textAlign:"center", padding:"60px 20px", color:"#3a3a55", background:"#0f1020", borderRadius:14, border:"1px solid #1a1a2e" }}>
                  <div style={{ fontSize:42, marginBottom:12 }}>🎉</div>
                  <div style={{ fontSize:16, color:"#6b6880" }}>All caught up! No follow-ups due today.</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize:13, fontWeight:600, color:"#ff7070", marginBottom:14 }}>🔔 Needs attention today ({dueToday.length})</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {dueToday.map(c => {
                      const stage = SM[c.stage]; const ds = daysSince(c.last_contacted_at);
                      return (
                        <div key={c.id} className="card" style={{ background:"#0f1020", border:"1px solid #ff6b4a44", borderRadius:12, padding:"14px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, flexWrap:"wrap" }}>
                          <div>
                            <div style={{ fontSize:14, fontWeight:600, color:"#f0eeff" }}>{c.name || c.current_title}</div>
                            <div style={{ fontSize:12, color:"#6b6880", marginTop:2 }}>{c.role_title}{c.role_location?` · ${c.role_location}`:""} · <span style={{ color:stage?.color }}>{stage?.icon} {stage?.label}</span></div>
                            {!c.last_contacted_at ? <div style={{ fontSize:11, color:"#4a9eff", marginTop:3 }}>Not yet contacted</div> : <div style={{ fontSize:11, color:"#ff7070", marginTop:3 }}>Last contacted {ds}d ago</div>}
                          </div>
                          <button onClick={() => generateMsg(c)} disabled={!!generating} className="btn-p" style={{ whiteSpace:"nowrap", fontSize:12, padding:"8px 16px" }}>
                            {generating===c.id+c.stage?"✨ Generating...":"⚡ Generate & Send"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {stageCounts.interested > 0 && (
                <div style={{ marginTop:28 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:"#4ae08a", marginBottom:12 }}>⭐ Interested ({stageCounts.interested})</div>
                  {candidates.filter(c => c.stage==="interested").map(c => (
                    <div key={c.id} style={{ background:"#0f1020", border:"1px solid #4ae08a22", borderRadius:10, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                      <div><div style={{ fontSize:13, fontWeight:600, color:"#f0eeff" }}>{c.name||c.current_title}</div><div style={{ fontSize:11, color:"#6b6880" }}>{c.role_title}</div></div>
                      <button className="btn-g" style={{ fontSize:12, padding:"6px 14px" }} onClick={() => { setSelected(c); setView("detail"); }}>View →</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {view === "pipeline" && (
            <div style={{ padding:"20px" }}>
              <div style={{ display:"flex", gap:7, marginBottom:20, flexWrap:"wrap" }}>
                <FBtn active={filter==="all"} onClick={() => setFilter("all")} label={`All (${candidates.length})`} />
                <FBtn active={filter==="due"} onClick={() => setFilter("due")} label={`🔔 Due (${dueCount})`} color="#ff6b4a" />
                {STAGES.map(s => <FBtn key={s.id} active={filter===s.id} onClick={() => setFilter(s.id)} label={`${s.icon} ${s.label} (${stageCounts[s.id]})`} color={s.color} />)}
              </div>
              {filtered.length === 0 ? (
                <div style={{ textAlign:"center", padding:"70px 20px", color:"#3a3a55" }}>
                  <div style={{ fontSize:44, marginBottom:12 }}>👥</div>
                  <div style={{ fontSize:15 }}>No candidates — add one or import a CSV</div>
                </div>
              ) : (
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(290px,1fr))", gap:12 }}>
                  {filtered.map(c => <CandCard key={c.id} c={c} generating={generating} onGenerate={() => generateMsg(c)} onStage={s => moveStage(c.id,s)} onClick={() => { setSelected(c); setView("detail"); }} />)}
                </div>
              )}
            </div>
          )}

          {view === "add" && (
            <div style={{ maxWidth:540, margin:"0 auto", padding:"28px 20px" }}>
              <div style={{ fontFamily:"'Playfair Display',serif", fontSize:22, marginBottom:24, color:"#f0eeff" }}>Add Candidate</div>
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                <FL label="Name (optional)"><input value={form.name} onChange={e => setForm({...form,name:e.target.value})} placeholder="e.g. Jamie Smith" style={IS}/></FL>
                <FL label="Current Job Title *"><input value={form.current_title} onChange={e => setForm({...form,current_title:e.target.value})} placeholder="e.g. Site Manager" style={IS}/></FL>
                <FL label="Experience"><textarea value={form.experience} onChange={e => setForm({...form,experience:e.target.value})} placeholder="e.g. 8 years civils, NVQ L6" rows={2} style={IS}/></FL>
                <FL label="Role Recruiting For *"><input value={form.role_title} onChange={e => setForm({...form,role_title:e.target.value})} placeholder="e.g. Senior Site Manager" style={IS}/></FL>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <FL label="Location"><input value={form.role_location} onChange={e => setForm({...form,role_location:e.target.value})} placeholder="e.g. Manchester" style={IS}/></FL>
                  <FL label="Salary"><input value={form.role_salary} onChange={e => setForm({...form,role_salary:e.target.value})} placeholder="e.g. 55000" style={IS}/></FL>
                </div>
                <FL label="Channel">
                  <select value={form.channel} onChange={e => setForm({...form,channel:e.target.value})} style={IS}>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="email">Email</option>
                  </select>
                </FL>
                <FL label="Notes"><textarea value={form.notes} onChange={e => setForm({...form,notes:e.target.value})} placeholder="Extra context..." rows={2} style={IS}/></FL>
                <div style={{ display:"flex", gap:8, marginTop:6 }}>
                  <button className="btn-g" onClick={() => setView("pipeline")}>Cancel</button>
                  <button className="btn-p" onClick={handleAddSubmit} disabled={!form.current_title||!form.role_title} style={{ flex:1 }}>Add Candidate</button>
                </div>
              </div>
            </div>
          )}

          {view === "detail" && selected && (() => {
            const c = candidates.find(x => x.id===selected.id) || selected;
            const stage = SM[c.stage];
            return (
              <div style={{ maxWidth:620, margin:"0 auto", padding:"24px 20px" }}>
                <button className="btn-g" style={{ marginBottom:18, fontSize:12 }} onClick={() => setView("pipeline")}>← Back</button>
                <div style={{ background:"#0f1020", border:"1px solid #1e1e32", borderRadius:14, overflow:"hidden" }}>
                  <div style={{ padding:"18px 22px", borderBottom:"1px solid #1a1a2e", display:"flex", justifyContent:"space-between" }}>
                    <div>
                      <div style={{ fontSize:17, fontWeight:700, color:"#f0eeff", fontFamily:"'Playfair Display',serif" }}>{c.name||c.current_title}</div>
                      {c.name && <div style={{ fontSize:12, color:"#8885aa", marginTop:2 }}>{c.current_title}</div>}
                      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:10 }}>
                        <Tag color={stage?.color}>{stage?.icon} {stage?.label}</Tag>
                        <Tag>{c.channel}</Tag>
                        {c.role_title&&<Tag>{c.role_title}</Tag>}
                        {c.role_location&&<Tag>{c.role_location}</Tag>}
                        {c.role_salary&&<Tag>£{c.role_salary}</Tag>}
                      </div>
                    </div>
                    <button onClick={() => deleteCandidate(c.id)} style={{ background:"none", border:"none", color:"#ff4a4a66", cursor:"pointer", fontSize:18, padding:4 }}>🗑</button>
                  </div>
                  <div style={{ padding:"14px 22px", borderBottom:"1px solid #1a1a2e" }}>
                    <div style={{ fontSize:11, color:"#4a4a65", textTransform:"uppercase", letterSpacing:1, marginBottom:9 }}>Move Stage</div>
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                      {STAGES.map(s => <button key={s.id} onClick={() => moveStage(c.id,s.id)} style={{ padding:"5px 12px", borderRadius:20, border:"1px solid", borderColor:c.stage===s.id?s.color:"#252535", background:c.stage===s.id?s.color+"22":"transparent", color:c.stage===s.id?s.color:"#6b6880", cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight:c.stage===s.id?600:400 }}>{s.icon} {s.label}</button>)}
                    </div>
                  </div>
                  <div style={{ padding:"14px 22px", borderBottom:"1px solid #1a1a2e" }}>
                    <button className="btn-p" onClick={() => generateMsg(c)} disabled={!!generating} style={{ width:"100%" }}>
                      {generating===c.id+c.stage?"✨ Generating...":"⚡ Generate Message"}
                    </button>
                  </div>
                  <div style={{ padding:"16px 22px" }}>
                    <div style={{ fontSize:11, color:"#4a4a65", textTransform:"uppercase", letterSpacing:1, marginBottom:12 }}>Message History ({c.messages?.length||0})</div>
                    {!c.messages?.length ? <div style={{ color:"#3a3a55", fontSize:13 }}>No messages sent yet</div>
                      : [...c.messages].reverse().map((m,i) => (
                        <div key={i} style={{ background:"#13141f", borderRadius:10, padding:"12px 14px", marginBottom:10, border:"1px solid #1e1e30" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                            <span style={{ fontSize:11, fontWeight:600, color:"#4a9eff" }}>{m.stageLabel} · {m.channel}</span>
                            <span style={{ fontSize:11, color:"#44435a" }}>{new Date(m.sentAt).toLocaleDateString("en-GB")}</span>
                          </div>
                          <div style={{ fontSize:13, color:"#9995b0", lineHeight:1.65, whiteSpace:"pre-wrap" }}>{m.text}</div>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {view === "settings" && (
            <div style={{ maxWidth:460, margin:"0 auto", padding:"28px 20px" }}>
              <div style={{ fontFamily:"'Playfair Display',serif", fontSize:22, marginBottom:24, color:"#f0eeff" }}>Settings</div>
              <div style={{ background:"#0f1020", border:"1px solid #1e1e32", borderRadius:14, padding:22, marginBottom:16 }}>
                <div style={{ fontSize:11, color:"#4a9eff", textTransform:"uppercase", letterSpacing:1, marginBottom:14 }}>Your Details</div>
                <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:18 }}>
                  <FL label="Your Name"><input value={settings.recruiterName||""} onChange={e => setSettings({...settings,recruiterName:e.target.value})} placeholder="e.g. Liam" style={IS}/></FL>
                  <FL label="Agency Name"><input value={settings.agencyName||""} onChange={e => setSettings({...settings,agencyName:e.target.value})} placeholder="e.g. Igniscare Solutions" style={IS}/></FL>
                </div>
                <button className="btn-p" onClick={() => { localStorage.setItem("rr_settings",JSON.stringify(settings)); showToast("Settings saved ✓"); }} style={{ width:"100%" }}>Save Settings</button>
              </div>
              <div style={{ background:"#0f1020", border:"1px solid #1e1e32", borderRadius:14, padding:22 }}>
                <div style={{ fontSize:11, color:"#ff6b4a", textTransform:"uppercase", letterSpacing:1, marginBottom:12 }}>Danger Zone</div>
                <button className="btn-g" style={{ width:"100%", fontSize:12, color:"#ff6b4a", borderColor:"#ff6b4a44" }} onClick={async () => {
                  if (confirm("Delete ALL candidates? This cannot be undone.")) {
                    await supabase.from("candidates").delete().neq("id","00000000-0000-0000-0000-000000000000");
                    setCands([]); showToast("All data cleared");
                  }
                }}>🗑 Clear All Candidates</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CandCard({ c, generating, onGenerate, onStage, onClick }) {
  const stage = SM[c.stage]; const due = isDue(c); const ds = daysSince(c.last_contacted_at);
  return (
    <div className="card" style={{ background:"#0f1020", border:`1px solid ${due?"#ff6b4a44":"#1e1e32"}`, borderRadius:12, overflow:"hidden", cursor:"pointer", transition:"transform .15s" }}
      onMouseEnter={e => e.currentTarget.style.transform="translateY(-2px)"}
      onMouseLeave={e => e.currentTarget.style.transform="none"}>
      <div onClick={onClick} style={{ padding:"14px 16px 10px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:600, color:"#f0eeff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.name||c.current_title}</div>
            {c.name && <div style={{ fontSize:11, color:"#6b6880", marginTop:1 }}>{c.current_title}</div>}
          </div>
          <span style={{ fontSize:10, background:stage?.color+"22", color:stage?.color, border:`1px solid ${stage?.color}44`, borderRadius:20, padding:"2px 8px", whiteSpace:"nowrap", marginLeft:8 }}>{stage?.icon} {stage?.label}</span>
        </div>
        <div style={{ fontSize:11, color:"#6b6880", marginBottom:4 }}>🎯 {c.role_title}{c.role_location?` · ${c.role_location}`:""}</div>
        {!c.last_contacted_at ? <div style={{ fontSize:10, color:"#4a9eff" }}>Not yet contacted</div>
          : <div style={{ fontSize:10, color:due?"#ff6b4a":"#44435a" }}>{due?`⚠️ Follow-up due (${ds}d)`:`Last contacted ${ds}d ago`}</div>}
      </div>
      <div style={{ padding:"8px 12px", borderTop:"1px solid #13132a", display:"flex", gap:6 }} onClick={e => e.stopPropagation()}>
        <button onClick={onGenerate} disabled={!!generating} style={{ flex:1, padding:"7px", background:due?"linear-gradient(135deg,#ff6b4a,#ff9a4a)":"linear-gradient(135deg,#4a9eff,#7b6fff)", color:"#fff", border:"none", borderRadius:7, cursor:generating?"not-allowed":"pointer", fontSize:11, fontWeight:600, fontFamily:"inherit", opacity:generating?.5:1 }}>
          {generating===c.id+c.stage?"✨...":due?"⚡ Follow-up":"⚡ Generate"}
        </button>
        <select value={c.stage} onChange={e => onStage(e.target.value)} style={{ ...IS, padding:"0 6px", fontSize:10, width:"auto", flex:"0 0 auto" }} onClick={e => e.stopPropagation()}>
          {STAGES.map(s => <option key={s.id} value={s.id}>{s.icon} {s.label}</option>)}
        </select>
      </div>
    </div>
  );
}

function FBtn({ active, onClick, label, color }) {
  return <button onClick={onClick} style={{ padding:"5px 12px", borderRadius:20, border:"1px solid", borderColor:active?(color||"#4a9eff"):"#252535", background:active?(color||"#4a9eff")+"22":"transparent", color:active?(color||"#4a9eff"):"#6b6880", cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight:active?600:400 }}>{label}</button>;
}
function Tag({ children, color }) {
  return <span style={{ fontSize:11, background:(color||"#4a4a65")+"22", color:color||"#8885aa", border:`1px solid ${(color||"#4a4a65")}44`, borderRadius:20, padding:"3px 9px" }}>{children}</span>;
}
function FL({ label, children }) {
  return <div><label style={{ fontSize:11, color:"#6b6880", display:"block", marginBottom:4 }}>{label}</label>{children}</div>;
}
