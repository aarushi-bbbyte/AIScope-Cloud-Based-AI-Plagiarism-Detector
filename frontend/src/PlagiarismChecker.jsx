import { useState, useCallback, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

// ── Colours assigned to each match pair ───────────────────────────────────────
const MATCH_COLORS = [
  { bg: "rgba(99,102,241,0.28)",  border: "#6366f1" },
  { bg: "rgba(249,115,22,0.28)",  border: "#f97316" },
  { bg: "rgba(234,179,8,0.28)",   border: "#eab308" },
  { bg: "rgba(34,197,94,0.28)",   border: "#22c55e" },
  { bg: "rgba(236,72,153,0.28)",  border: "#ec4899" },
  { bg: "rgba(20,184,166,0.28)",  border: "#14b8a6" },
  { bg: "rgba(168,85,247,0.28)",  border: "#a855f7" },
  { bg: "rgba(251,146,60,0.28)",  border: "#fb923c" },
];

function matchColor(id) {
  return MATCH_COLORS[id % MATCH_COLORS.length];
}

// ── File extraction (reuses the same CDN libs as App.jsx) ─────────────────────
async function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = res;
    s.onerror = () => rej(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function extractText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "txt") return file.text();
  if (ext === "pdf") {
    if (!window.pdfjsLib) {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    const buf = await file.arrayBuffer();
    const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let t = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const ct = await pg.getTextContent();
      t += ct.items.map(s => s.str).join(" ") + "\n";
    }
    return t.trim();
  }
  if (ext === "docx") {
    if (!window.mammoth) {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
    }
    const buf = await file.arrayBuffer();
    const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return res.value.trim();
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

// ── Highlighted document renderer ─────────────────────────────────────────────
function HighlightedDoc({ text, highlights, activeMatch, onMatchHover }) {
  if (!text) return null;

  // Sort highlights by start position
  const sorted = [...highlights].sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = 0;

  for (const h of sorted) {
    if (h.start > cursor) {
      segments.push({ type: "plain", text: text.slice(cursor, h.start) });
    }
    const end = Math.min(h.end, text.length);
    segments.push({ type: "match", text: text.slice(h.start, end), matchId: h.match_id });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ type: "plain", text: text.slice(cursor) });
  }

  return (
    <div className="highlighted-doc">
      {segments.map((seg, i) => {
        if (seg.type === "plain") {
          return <span key={i}>{seg.text}</span>;
        }
        const c      = matchColor(seg.matchId);
        const active = activeMatch === seg.matchId;
        return (
          <mark
            key={i}
            className={`match-mark ${active ? "active" : ""}`}
            style={{
              background:   active ? c.border + "55" : c.bg,
              borderBottom: `2px solid ${c.border}`,
              borderRadius: "2px",
              padding:      "0 1px",
              cursor:       "pointer",
              transition:   "background 0.15s",
            }}
            onMouseEnter={() => onMatchHover(seg.matchId)}
            onMouseLeave={() => onMatchHover(null)}
            title={`Match #${seg.matchId + 1}`}
          >
            {seg.text}
          </mark>
        );
      })}
    </div>
  );
}

// ── Document input panel ───────────────────────────────────────────────────────
function DocInput({ label, text, filename, onChange, onFile, loading, error }) {
  const ref = useRef();
  const [drag, setDrag] = useState(false);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  const handleFile = async (file) => {
    if (!file) return;
    onFile(file);
  };

  return (
    <div className="doc-input-panel">
      <div className="doc-input-header">
        <span className="doc-input-label">{label}</span>
        <span className={`word-count ${wordCount < 20 ? "low" : ""}`}>
          {wordCount} words
        </span>
      </div>

      <div
        className={`upload-zone compact ${drag ? "drag-over" : ""} ${loading ? "disabled" : ""}`}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
        onClick={() => !loading && ref.current?.click()}
      >
        <input ref={ref} type="file" accept=".txt,.pdf,.docx"
          style={{ display: "none" }}
          onChange={e => handleFile(e.target.files[0])} />
        <span className="upload-icon" style={{ fontSize: 18 }}>⇪</span>
        <span className="upload-text" style={{ fontSize: 12 }}>
          {filename ? `📄 ${filename}` : "Drop PDF / DOCX / TXT or click"}
        </span>
      </div>

      {loading && <p className="file-loading">Extracting text…</p>}
      {error   && <p className="error-msg" style={{ fontSize: 12 }}>{error}</p>}

      <textarea
        className="text-input"
        placeholder="…or paste text here"
        value={text}
        onChange={e => onChange(e.target.value)}
        rows={8}
        style={{ marginTop: 8 }}
      />
    </div>
  );
}

// ── Similarity gauge ───────────────────────────────────────────────────────────
function SimilarityGauge({ pct, verdict, verdictColor }) {
  const colorMap = {
    red:    "#ef4444",
    orange: "#f97316",
    yellow: "#eab308",
    blue:   "#6366f1",
    green:  "#22c55e",
  };
  const color = colorMap[verdictColor] || "#94a3b8";
  const r = 54, circ = 2 * Math.PI * r;
  const fill = (pct / 100) * circ;

  return (
    <div className="sim-gauge">
      <svg width="140" height="140" viewBox="0 0 150 150">
        <circle cx="75" cy="75" r={r} fill="none" stroke="#1e293b" strokeWidth="10" />
        <circle cx="75" cy="75" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 75 75)"
          style={{ transition: "stroke-dasharray 1s ease" }} />
        <text x="75" y="70" textAnchor="middle" fill={color}
          fontSize="26" fontWeight="700" fontFamily="'DM Mono',monospace">
          {pct.toFixed(1)}%
        </text>
        <text x="75" y="88" textAnchor="middle" fill="#94a3b8"
          fontSize="10" fontFamily="'DM Sans',sans-serif">
          similarity
        </text>
      </svg>
      <p className="sim-verdict" style={{ color }}>{verdict}</p>
    </div>
  );
}

// ── Match list panel ───────────────────────────────────────────────────────────
function MatchList({ matches, activeMatch, onHover }) {
  if (!matches?.length) {
    return <p style={{ color: "#475569", fontSize: 13, padding: "12px 0" }}>No matching passages found.</p>;
  }
  return (
    <div className="match-list">
      <p className="section-title" style={{ marginBottom: 10 }}>
        Matching passages ({matches.length})
      </p>
      {matches.map(m => {
        const c      = matchColor(m.id);
        const active = activeMatch === m.id;
        return (
          <div
            key={m.id}
            className={`match-card ${active ? "active" : ""}`}
            style={{
              borderLeft:  `3px solid ${c.border}`,
              background:  active ? c.bg : "transparent",
              transition:  "background 0.15s",
            }}
            onMouseEnter={() => onHover(m.id)}
            onMouseLeave={() => onHover(null)}
          >
            <div className="match-card-header">
              <span className="match-label" style={{ color: c.border }}>
                Match #{m.id + 1}
              </span>
              <span className="match-sim">{m.similarity.toFixed(1)}% similar</span>
            </div>
            <p className="match-text doc1-text">"{m.text1}"</p>
            <p className="match-arrow">↓</p>
            <p className="match-text doc2-text">"{m.text2}"</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function PlagiarismChecker() {
  const [text1, setText1]     = useState("");
  const [text2, setText2]     = useState("");
  const [name1, setName1]     = useState("Document 1");
  const [name2, setName2]     = useState("Document 2");
  const [file1Loading, setFile1Loading] = useState(false);
  const [file2Loading, setFile2Loading] = useState(false);
  const [file1Error,   setFile1Error]   = useState("");
  const [file2Error,   setFile2Error]   = useState("");

  const [phase, setPhase]   = useState("idle");  // idle | checking | done | error
  const [result, setResult] = useState(null);
  const [error, setError]   = useState("");
  const [activeMatch, setActiveMatch] = useState(null);

  const words1 = text1.trim().split(/\s+/).filter(Boolean).length;
  const words2 = text2.trim().split(/\s+/).filter(Boolean).length;
  const canSubmit = words1 >= 20 && words2 >= 20;

  const handleFile1 = useCallback(async (file) => {
    setFile1Error(""); setFile1Loading(true);
    try {
      const t = await extractText(file);
      setText1(t); setName1(file.name);
    } catch (e) { setFile1Error(e.message); }
    finally { setFile1Loading(false); }
  }, []);

  const handleFile2 = useCallback(async (file) => {
    setFile2Error(""); setFile2Loading(true);
    try {
      const t = await extractText(file);
      setText2(t); setName2(file.name);
    } catch (e) { setFile2Error(e.message); }
    finally { setFile2Loading(false); }
  }, []);

  const handleCheck = useCallback(async () => {
    if (!canSubmit) return;
    setPhase("checking"); setError(""); setResult(null);
    try {
      const res = await fetch(`${API_BASE}/plagiarism`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text1, text2, name1, name2 }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResult(data);
      setPhase("done");
    } catch (e) {
      setError(e.message);
      setPhase("error");
    }
  }, [text1, text2, name1, name2, canSubmit]);

  const reset = () => {
    setText1(""); setText2(""); setName1("Document 1"); setName2("Document 2");
    setResult(null); setPhase("idle"); setError(""); setActiveMatch(null);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="plagiarism-checker">

      {/* ── Input phase ── */}
      {(phase === "idle" || phase === "error") && (
        <div className="plg-input-section">
          <div className="plg-docs-row">
            <DocInput
              label="Document 1"
              text={text1} filename={name1 !== "Document 1" ? name1 : ""}
              onChange={t => { setText1(t); setName1("Document 1"); }}
              onFile={handleFile1}
              loading={file1Loading} error={file1Error}
            />
            <div className="plg-vs">VS</div>
            <DocInput
              label="Document 2"
              text={text2} filename={name2 !== "Document 2" ? name2 : ""}
              onChange={t => { setText2(t); setName2("Document 2"); }}
              onFile={handleFile2}
              loading={file2Loading} error={file2Error}
            />
          </div>

          {error && <p className="error-msg">Error: {error}</p>}

          <div className="plg-footer">
            <p className="model-note">
              Sentence-level Jaccard trigram matching + TF-IDF cosine similarity · runs entirely in Lambda · no ML model needed
            </p>
            <button
              className="submit-btn"
              onClick={handleCheck}
              disabled={!canSubmit}
            >
              {canSubmit ? "Check for plagiarism" : `Need 20+ words in each doc (${words1} / ${words2})`}
            </button>
          </div>
        </div>
      )}

      {/* ── Loading ── */}
      {phase === "checking" && (
        <div className="loading-card">
          <div className="spinner" />
          <p className="loading-title">Comparing documents…</p>
          <p className="loading-sub">Running sentence matching + cosine similarity</p>
        </div>
      )}

      {/* ── Results ── */}
      {phase === "done" && result && (
        <div className="plg-results">

          {/* Header row */}
          <div className="plg-results-header">
            <SimilarityGauge
              pct={result.similarity_pct}
              verdict={result.verdict}
              verdictColor={result.verdict_color}
            />
            <div className="plg-stats">
              <div className="plg-stat">
                <span className="plg-stat-val">{result.cosine_similarity}%</span>
                <span className="plg-stat-label">Vocabulary overlap</span>
              </div>
              <div className="plg-stat">
                <span className="plg-stat-val">{result.sentence_coverage}%</span>
                <span className="plg-stat-label">Sentences matched</span>
              </div>
              <div className="plg-stat">
                <span className="plg-stat-val">{result.match_count}</span>
                <span className="plg-stat-label">Matching passages</span>
              </div>
            </div>
            <button className="reset-btn" onClick={reset}>New check</button>
          </div>

          {/* Match list */}
          <MatchList
            matches={result.matches}
            activeMatch={activeMatch}
            onHover={setActiveMatch}
          />

          {/* Side-by-side highlighted documents */}
          <p className="section-title" style={{ margin: "20px 0 10px" }}>
            Highlighted documents — hover a match above to locate it below
          </p>
          <div className="plg-side-by-side">
            <div className="plg-doc-panel">
              <p className="plg-doc-name">{result.doc1.name}</p>
              <p className="plg-doc-meta">{result.doc1.word_count} words · {result.doc1.sent_count} sentences</p>
              <HighlightedDoc
                text={result.doc1.text}
                highlights={result.doc1.highlights}
                activeMatch={activeMatch}
                onMatchHover={setActiveMatch}
              />
            </div>
            <div className="plg-doc-panel">
              <p className="plg-doc-name">{result.doc2.name}</p>
              <p className="plg-doc-meta">{result.doc2.word_count} words · {result.doc2.sent_count} sentences</p>
              <HighlightedDoc
                text={result.doc2.text}
                highlights={result.doc2.highlights}
                activeMatch={activeMatch}
                onMatchHover={setActiveMatch}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
