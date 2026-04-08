import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

// ── Persistent session ID (survives page refresh) ─────────────────────────────
function getSessionId() {
  let sid = localStorage.getItem("aiscope_session");
  if (!sid) {
    sid = crypto.randomUUID();
    localStorage.setItem("aiscope_session", sid);
  }
  return sid;
}
const SESSION_ID = getSessionId();

// ── API helpers ───────────────────────────────────────────────────────────────
async function submitAnalysis({ text, filename = "", fileType = "text", versionLabel = "" }) {
  const res = await fetch(`${API_BASE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      filename,
      file_type: fileType,
      version_label: versionLabel,
      session_id: SESSION_ID,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function pollUntilDone(jobId, onStatus) {
  let attempts = 0;
  const MAX_ATTEMPTS = 30;
  while (attempts < MAX_ATTEMPTS) {
    const res  = await fetch(`${API_BASE}/results/${jobId}`);
    const data = await res.json();
    if (data.status === "completed") return data;
    if (data.status === "failed") throw new Error(data.error || "Analysis failed");
    onStatus(data.status);
    await new Promise((r) => setTimeout(r, 2000));
    attempts++;
  }
  throw new Error("Timeout: analysis took too long");
}

async function fetchHistory() {
  const res  = await fetch(`${API_BASE}/history/${SESSION_ID}`);
  const data = await res.json();
  return data.history || [];
}

// ── PDF / DOCX text extraction (client-side) ──────────────────────────────────
async function extractTextFromFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "txt") {
    return await file.text();
  }

  if (ext === "pdf") {
    // Use PDF.js from CDN (loaded lazily)
    if (!window.pdfjsLib) {
      await loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
      );
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    const buffer   = await file.arrayBuffer();
    const pdfDoc   = await window.pdfjsLib.getDocument({ data: buffer }).promise;
    let text = "";
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page    = await pdfDoc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((s) => s.str).join(" ") + "\n";
    }
    return text.trim();
  }

  if (ext === "docx") {
    // Use mammoth.js from CDN
    if (!window.mammoth) {
      await loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"
      );
    }
    const buffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value.trim();
  }

  throw new Error(`Unsupported file type: .${ext}. Use PDF, DOCX, or TXT.`);
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s  = document.createElement("script");
    s.src    = src;
    s.onload = res;
    s.onerror = () => rej(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(Number(ts) * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function aiColor(pct) {
  if (pct == null) return "#64748b";
  if (pct >= 75)  return "#ef4444";
  if (pct >= 50)  return "#f97316";
  if (pct >= 25)  return "#eab308";
  return "#22c55e";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScoreDial({ score }) {
  if (score == null) return null;
  const pct  = score * 100;
  const r    = 54;
  const circ = 2 * Math.PI * r;
  const fill = (pct / 100) * circ;
  const color = aiColor(pct);
  return (
    <div className="dial-wrap">
      <svg width="150" height="150" viewBox="0 0 150 150">
        <circle cx="75" cy="75" r={r} fill="none" stroke="#1e293b" strokeWidth="10" />
        <circle cx="75" cy="75" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 75 75)"
          style={{ transition: "stroke-dasharray 1s ease" }} />
        <text x="75" y="70" textAnchor="middle" fill={color}
          fontSize="28" fontWeight="700" fontFamily="'DM Mono',monospace">
          {pct.toFixed(1)}%
        </text>
        <text x="75" y="90" textAnchor="middle" fill="#94a3b8"
          fontSize="11" fontFamily="'DM Sans',sans-serif">
          AI probability
        </text>
      </svg>
    </div>
  );
}

function Badge({ label, confidenceLevel }) {
  const confColors = {
    high:   { bg: "#1a1a2e", border: "#6366f1", color: "#a5b4fc" },
    medium: { bg: "#1a1a2e", border: "#f59e0b", color: "#fcd34d" },
    low:    { bg: "#1a1a2e", border: "#64748b", color: "#94a3b8" },
  };
  const conf = confColors[confidenceLevel] || confColors.low;
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
      <span className="label-badge">{label}</span>
      <span className="conf-badge" style={{
        background: conf.bg, border: `1px solid ${conf.border}`, color: conf.color,
      }}>
        {confidenceLevel} confidence
      </span>
    </div>
  );
}

function ConfidenceMeter({ confidence }) {
  if (confidence == null) return null;
  const pct   = Math.round(confidence * 100);
  const color = confidence > 0.7 ? "#22c55e" : confidence > 0.3 ? "#eab308" : "#94a3b8";
  return (
    <div className="conf-meter">
      <div className="conf-meter-header">
        <span className="conf-meter-label">Confidence</span>
        <span className="conf-meter-val" style={{ color }}>{pct}%</span>
      </div>
      <div className="signal-track">
        <div className="signal-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <p className="conf-meter-note">
        {confidence > 0.7 ? "Model is highly certain of this result"
          : confidence > 0.3 ? "Moderate certainty — result may vary"
          : "Low certainty — result is inconclusive"}
      </p>
    </div>
  );
}

function DetailsPanel({ details }) {
  if (!details) return null;
  const { chunks_analyzed, model, chunk_scores, score_variance, word_count } = details;
  return (
    <div className="details-panel">
      <h3 className="section-title">Model details</h3>
      <div className="detail-grid">
        <div className="detail-item">
          <span className="detail-label">Model</span>
          <span className="detail-val mono">{model}</span>
        </div>
        <div className="detail-item">
          <span className="detail-label">Chunks analyzed</span>
          <span className="detail-val mono">{chunks_analyzed}</span>
        </div>
        <div className="detail-item">
          <span className="detail-label">Word count</span>
          <span className="detail-val mono">{word_count ?? "—"}</span>
        </div>
        <div className="detail-item">
          <span className="detail-label">Score variance</span>
          <span className="detail-val mono">{score_variance?.toFixed(4) ?? "—"}</span>
        </div>
      </div>
      {chunk_scores?.length > 0 && (
        <div className="chunk-scores">
          <p className="detail-label" style={{ marginBottom: "8px" }}>
            Per-chunk AI scores ({chunk_scores.length} chunks)
          </p>
          <div className="chunk-bars">
            {chunk_scores.map((s, i) => {
              const c = s >= 0.75 ? "#ef4444" : s >= 0.5 ? "#f97316" : s >= 0.25 ? "#eab308" : "#22c55e";
              return (
                <div key={i} className="chunk-bar-wrap" title={`Chunk ${i + 1}: ${(s * 100).toFixed(1)}%`}>
                  <div className="chunk-bar-track">
                    <div className="chunk-bar-fill" style={{ height: `${s * 100}%`, background: c }} />
                  </div>
                  <span className="chunk-bar-label">{i + 1}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultView({ result }) {
  const { score, confidence, label, details,
          ai_percentage, human_percentage, confidence_level } = result;
  const scoreColor = aiColor(ai_percentage);
  return (
    <div className="result-view">
      <div className="result-top">
        <ScoreDial score={score} />
        <div className="result-meta">
          <Badge label={label} confidenceLevel={confidence_level} />
          <div className="stat-row">
            <div className="stat">
              <span className="stat-val" style={{ color: scoreColor }}>
                {ai_percentage?.toFixed(1) ?? "—"}%
              </span>
              <span className="stat-label">AI</span>
            </div>
            <div className="stat">
              <span className="stat-val" style={{ color: "#22c55e" }}>
                {human_percentage?.toFixed(1) ?? "—"}%
              </span>
              <span className="stat-label">Human</span>
            </div>
            <div className="stat">
              <span className="stat-val mono">{score?.toFixed(3) ?? "—"}</span>
              <span className="stat-label">raw score</span>
            </div>
          </div>
          <ConfidenceMeter confidence={confidence} />
        </div>
      </div>
      <div className="interp-box">
        <p className="interp-formula">
          confidence = |score − 0.5| × 2
          &nbsp;→&nbsp;
          {score != null ? `|${score?.toFixed(3)} − 0.5| × 2 = ${confidence?.toFixed(3)}` : "—"}
        </p>
        <p className="interp-note">
          Scores &gt; 0.7 → high confidence &nbsp;·&nbsp;
          0.3–0.7 → moderate &nbsp;·&nbsp;
          &lt; 0.3 → inconclusive
        </p>
      </div>
      <DetailsPanel details={details} />
    </div>
  );
}

// ── History sidebar ───────────────────────────────────────────────────────────

function HistoryItem({ item, isActive, onClick }) {
  const ai  = item.ai_percentage;
  const color = aiColor(ai);
  const statusIcon = item.status === "completed" ? null
                   : item.status === "processing" ? "⟳"
                   : item.status === "queued"     ? "…"
                   : item.status === "failed"     ? "✗"
                   : "?";

  return (
    <button
      className={`history-item ${isActive ? "active" : ""} ${item.status}`}
      onClick={onClick}
    >
      <div className="hi-top">
        <span className="hi-name" title={item.filename || "Pasted text"}>
          {item.filename || "Pasted text"}
        </span>
        {item.version_label && (
          <span className="hi-vlabel">{item.version_label}</span>
        )}
      </div>
      <div className="hi-bottom">
        <span className="hi-time">{fmtTime(item.submitted_at)}</span>
        {statusIcon ? (
          <span className={`hi-status-icon ${item.status}`}>{statusIcon}</span>
        ) : (
          <span className="hi-pct" style={{ color }}>
            {ai != null ? `${ai.toFixed(1)}% AI` : "—"}
          </span>
        )}
      </div>
    </button>
  );
}

function HistorySidebar({ history, activeJobId, onSelect, onRefresh, loading }) {
  return (
    <aside className="history-sidebar">
      <div className="hs-header">
        <span className="hs-title">Version History</span>
        <button className="hs-refresh" onClick={onRefresh} disabled={loading} title="Refresh">
          {loading ? "⟳" : "↺"}
        </button>
      </div>
      {history.length === 0 && !loading && (
        <p className="hs-empty">No submissions yet this session.</p>
      )}
      {loading && history.length === 0 && (
        <p className="hs-empty">Loading…</p>
      )}
      <div className="hs-list">
        {history.map((item) => (
          <HistoryItem
            key={item.job_id}
            item={item}
            isActive={item.job_id === activeJobId}
            onClick={() => onSelect(item.job_id)}
          />
        ))}
      </div>
    </aside>
  );
}

// ── File upload zone ──────────────────────────────────────────────────────────

function FileUploadZone({ onFile, disabled }) {
  const ref         = useRef();
  const [drag, setDrag] = useState(false);

  const handle = async (file) => {
    if (!file) return;
    onFile(file);
  };

  return (
    <div
      className={`upload-zone ${drag ? "drag-over" : ""} ${disabled ? "disabled" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        handle(e.dataTransfer.files[0]);
      }}
      onClick={() => !disabled && ref.current?.click()}
    >
      <input
        ref={ref} type="file" accept=".txt,.pdf,.docx"
        style={{ display: "none" }}
        onChange={(e) => handle(e.target.files[0])}
      />
      <span className="upload-icon">⇪</span>
      <p className="upload-text">Drop PDF, DOCX, or TXT here</p>
      <p className="upload-sub">or click to browse</p>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [text, setText]         = useState("");
  const [phase, setPhase]       = useState("idle");   // idle | submitting | polling | done | error
  const [statusMsg, setStatusMsg] = useState("");
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [filename, setFilename] = useState("");
  const [fileType, setFileType] = useState("text");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError]     = useState("");

  // History
  const [history, setHistory]       = useState([]);
  const [histLoading, setHistLoading] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [viewingResult, setViewingResult] = useState(null); // result fetched from history

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  // ── Load history on mount ────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    try {
      const h = await fetchHistory();
      setHistory(h);
    } catch {
      // silently fail — history is non-critical
    } finally {
      setHistLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── Handle file upload ───────────────────────────────────────────────────
  const handleFile = useCallback(async (file) => {
    setFileError("");
    setFileLoading(true);
    try {
      const extracted = await extractTextFromFile(file);
      if (!extracted || extracted.length < 50) {
        throw new Error("Extracted text is too short. Please use a longer document.");
      }
      setText(extracted);
      setFilename(file.name);
      setFileType(file.name.split(".").pop().toLowerCase() === "pdf" ? "pdf"
                : file.name.split(".").pop().toLowerCase() === "docx" ? "docx"
                : "text");
    } catch (e) {
      setFileError(e.message);
    } finally {
      setFileLoading(false);
    }
  }, []);

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (wordCount < 10) return;
    setPhase("submitting"); setError(""); setResult(null); setViewingResult(null);
    try {
      const { job_id } = await submitAnalysis({ text, filename, fileType, versionLabel });
      setActiveJobId(job_id);
      setPhase("polling"); setStatusMsg("queued");
      // Optimistically add to history
      setHistory((prev) => [{
        job_id, status: "queued", filename: filename || "Pasted text",
        file_type: fileType, version_label: versionLabel,
        submitted_at: Math.floor(Date.now() / 1000),
        ai_percentage: null,
      }, ...prev]);

      const res = await pollUntilDone(job_id, (s) => {
        setStatusMsg(s);
        setHistory((prev) => prev.map((h) => h.job_id === job_id ? { ...h, status: s } : h));
      });
      setResult(res);
      setPhase("done");
      // Update history entry with result
      setHistory((prev) => prev.map((h) => h.job_id === job_id ? {
        ...h, status: "completed",
        ai_percentage: res.ai_percentage,
        human_percentage: res.human_percentage,
        label: res.label,
        confidence_level: res.confidence_level,
        completed_at: res.completed_at,
      } : h));
    } catch (e) {
      setError(e.message); setPhase("error");
      setHistory((prev) => prev.map((h) =>
        h.job_id === activeJobId ? { ...h, status: "failed" } : h));
    }
  }, [text, wordCount, filename, fileType, versionLabel, activeJobId]);

  // ── Click history item ───────────────────────────────────────────────────
  const handleSelectHistory = useCallback(async (jobId) => {
    setActiveJobId(jobId);
    const cached = history.find((h) => h.job_id === jobId);
    if (cached?.status !== "completed") return; // still processing
    setViewingResult(null);
    try {
      const res = await fetch(`${API_BASE}/results/${jobId}`);
      const data = await res.json();
      if (data.status === "completed") {
        setViewingResult(data);
        setPhase("history-view");
      }
    } catch { /* ignore */ }
  }, [history]);

  // ── Reset ────────────────────────────────────────────────────────────────
  const reset = () => {
    setText(""); setPhase("idle"); setResult(null); setError("");
    setFilename(""); setFileType("text"); setVersionLabel(""); setFileError("");
    setViewingResult(null); setActiveJobId(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">◈</span>
            <span className="logo-text">AIScope</span>
          </div>
          <p className="tagline">
            roberta-base-openai-detector · AWS Lambda · S3 · SQS · DynamoDB
          </p>
        </div>
      </header>

      <div className="app-body">
        {/* ── Sidebar ── */}
        <HistorySidebar
          history={history}
          activeJobId={activeJobId}
          onSelect={handleSelectHistory}
          onRefresh={loadHistory}
          loading={histLoading}
        />

        {/* ── Main panel ── */}
        <main className="main">

          {/* ── History detail view ── */}
          {phase === "history-view" && viewingResult && (
            <div className="result-card">
              <div className="result-card-header">
                <div>
                  <h2>Saved result</h2>
                  <p className="result-meta-sub">
                    {viewingResult.filename || "Pasted text"} &nbsp;·&nbsp;
                    {fmtTime(viewingResult.submitted_at)}
                    {viewingResult.version_label && ` · "${viewingResult.version_label}"`}
                  </p>
                </div>
                <button className="reset-btn" onClick={reset}>New analysis</button>
              </div>
              {viewingResult.text_preview && (
                <div className="text-preview-box">
                  <p className="text-preview-label">Document preview</p>
                  <p className="text-preview-content">{viewingResult.text_preview}</p>
                </div>
              )}
              <ResultView result={viewingResult} />
            </div>
          )}

          {/* ── Input form ── */}
          {(phase === "idle" || phase === "error") && (
            <div className="input-card">
              <div className="input-header">
                <h2>Paste or upload document</h2>
                <span className={`word-count ${wordCount < 10 ? "low" : ""}`}>
                  {wordCount} words{wordCount < 10 ? " · need at least 10" : ""}
                </span>
              </div>

              {/* File upload zone */}
              <FileUploadZone onFile={handleFile} disabled={fileLoading || phase === "submitting"} />
              {fileLoading && <p className="file-loading">Extracting text…</p>}
              {fileError  && <p className="error-msg">{fileError}</p>}
              {filename   && (
                <div className="file-pill">
                  <span>📄 {filename}</span>
                  <button onClick={() => { setFilename(""); setFileType("text"); setText(""); }}
                    className="file-pill-close">×</button>
                </div>
              )}

              <textarea
                className="text-input"
                placeholder="…or paste the text to check for AI-generated content"
                value={text}
                onChange={(e) => { setText(e.target.value); setFilename(""); setFileType("text"); }}
                rows={10}
              />

              {/* Optional version label */}
              <input
                className="version-label-input"
                placeholder="Version label (optional, e.g. 'Draft 2')"
                value={versionLabel}
                onChange={(e) => setVersionLabel(e.target.value)}
              />

              {error && <p className="error-msg">Error: {error}</p>}

              <div className="input-footer">
                <p className="model-note">
                  Uses <code>roberta-base-openai-detector</code> — 125M param RoBERTa,
                  fine-tuned on GPT-2/GPT-3 outputs
                </p>
                <button className="submit-btn" onClick={handleSubmit} disabled={wordCount < 10}>
                  Analyse document
                </button>
              </div>
            </div>
          )}

          {/* ── Loading ── */}
          {(phase === "submitting" || phase === "polling") && (
            <div className="loading-card">
              <div className="spinner" />
              <p className="loading-title">Analysing your document</p>
              <p className="loading-sub">
                {phase === "submitting"
                  ? "Uploading to S3…"
                  : `Status: ${statusMsg} · RoBERTa inference in progress · checking every 2s`}
              </p>
              <p className="loading-note">
                First run may take ~60s while the model downloads. Subsequent runs are fast.
              </p>
            </div>
          )}

          {/* ── Done ── */}
          {phase === "done" && result && (
            <div className="result-card">
              <div className="result-card-header">
                <div>
                  <h2>Detection complete</h2>
                  {(filename || versionLabel) && (
                    <p className="result-meta-sub">
                      {filename || "Pasted text"}
                      {versionLabel && ` · "${versionLabel}"`}
                    </p>
                  )}
                </div>
                <button className="reset-btn" onClick={reset}>Analyse another</button>
              </div>
              {text && (
                <div className="text-preview-box">
                  <p className="text-preview-label">Document preview</p>
                  <p className="text-preview-content">
                    {text.slice(0, 300)}{text.length > 300 ? "…" : ""}
                  </p>
                </div>
              )}
              <ResultView result={result} />
            </div>
          )}
        </main>
      </div>

      <footer className="footer">
        Cloud-Based AI Plagiarism Detection · roberta-base-openai-detector ·
        AWS S3 + SQS + Lambda + DynamoDB
      </footer>
    </div>
  );
}
