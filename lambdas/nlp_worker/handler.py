"""
Lambda: nlp_worker  —  AI Detection via HuggingFace Inference API
──────────────────────────────────────────────────────────────────
Triggered by: SQS

Model: roberta-base-openai-detector (hosted by HuggingFace — free)
Method: HTTP call to HuggingFace's Inference API
Cost:   $0  — HuggingFace hosts the model, you just call it
Lambda: tiny zip (~10MB), no Docker, no ECR

Inference process (matches reference repo):
  1. Chunk text into 512-char segments (max 20 chunks)
  2. Call HF Inference API for each chunk
  3. Average scores across chunks
  4. Confidence = abs(score - 0.5) * 2

Output schema (exact reference repo format):
  {
    "is_ai":      bool,
    "score":      float,    # 0-1, probability of AI
    "confidence": float,    # abs(score - 0.5) * 2
    "label":      str,
    "provider":   "huggingface",
    "details": { "chunks_analyzed": int, "model": str, ... }
  }
"""

import json
import os
import re
import time
import urllib.request
import urllib.error
from typing import List
import requests

import boto3

# ── AWS clients ────────────────────────────────────────────────────────────────
s3       = boto3.client("s3",         region_name=os.environ["AWS_REGION"])
dynamodb = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"])
table    = dynamodb.Table(os.environ["DYNAMODB_TABLE"])

BUCKET     = os.environ["S3_BUCKET_NAME"]
HF_TOKEN   = os.environ["HF_TOKEN"]          # your free HuggingFace token
RESULT_TTL = 7 * 24 * 3600

MODEL_ID   = "openai-community/roberta-base-openai-detector"
HF_API_URL = f"https://router.huggingface.co/hf-inference/models/{MODEL_ID}"
CHUNK_SIZE = 512   # characters per chunk
MAX_CHUNKS = 20
MAX_RETRIES = 3    # HF free tier sometimes needs a retry (model loading)
RETRY_WAIT  = 20   # seconds to wait if model is loading


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def handler(event, context):
    for record in event.get("Records", []):
        job_id = None
        try:
            msg    = json.loads(record["body"])
            job_id = msg["job_id"]
            s3_key = msg["s3_key"]

            print(f"[worker] Processing job {job_id}")
            _set_status(job_id, "processing")

            text     = _read_s3(s3_key)
            analysis = detect_ai(text)
            _save(job_id, s3_key, analysis)

            print(f"[worker] Done {job_id} — score={analysis.get('score')} label={analysis.get('label')}")

        except Exception as e:
            print(f"[worker] FAIL {job_id}: {e}")
            if job_id:
                _set_status(job_id, "failed", str(e))
            raise

    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
# DETECTION ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def detect_ai(text: str) -> dict:
    text = text.strip()
    if not text:
        return _error_result("Empty text provided.")

    word_count = len(text.split())
    if word_count < 10:
        return _error_result(f"Text too short ({word_count} words). Minimum 10 words.")

    # Step 1: chunk the text
    chunks = _chunk_text(text)
    print(f"[detect] {len(chunks)} chunks, {word_count} words")

    # Step 2: call HF API for each chunk
    chunk_scores = []
    for i, chunk in enumerate(chunks):
        score = _classify_chunk(chunk, chunk_index=i+1, total=len(chunks))
        if score is not None:
            chunk_scores.append(round(score, 6))

    if not chunk_scores:
        return _error_result("All chunks failed — HuggingFace API may be unavailable.")

    # Step 3: aggregate (simple average, matches reference repo)
    score = sum(chunk_scores) / len(chunk_scores)

    # Step 4: confidence = abs(score - 0.5) * 2
    confidence = abs(score - 0.5) * 2

    variance = sum((s - score) ** 2 for s in chunk_scores) / len(chunk_scores)
    is_ai    = score >= 0.5
    label    = _make_label(score, confidence)

    return {
        # ── Exact reference repo schema ────────────────────────────────────
        "is_ai":      is_ai,
        "score":      round(score, 6),
        "confidence": round(confidence, 6),
        "label":      label,
        "provider":   "huggingface",
        "details": {
            "chunks_analyzed": len(chunk_scores),
            "model":           MODEL_ID,
            "chunk_scores":    chunk_scores,
            "score_variance":  round(variance, 6),
            "word_count":      word_count,
        },
        # ── Frontend convenience fields ────────────────────────────────────
        "ai_percentage":    round(score * 100, 2),
        "human_percentage": round((1 - score) * 100, 2),
        "classification":   _classification(score),
        "confidence_level": _confidence_level(confidence),
    }


def _classify_chunk(chunk: str, chunk_index: int, total: int) -> float | None:
    """
    Call HuggingFace Inference API for one chunk.
    Returns AI probability (0-1), or None if all retries fail.

    HF free tier sometimes returns {"error": "Model is currently loading"}
    with estimated_time — we wait and retry up to MAX_RETRIES times.
    """
    headers = {
        "Authorization": f"Bearer {HF_TOKEN}",
        "Content-Type":  "application/json",
    }
    payload = json.dumps({"inputs": chunk}).encode("utf-8")

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(HF_API_URL, data=payload, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = json.loads(resp.read())

            # HF returns [[{label, score}, {label, score}]] for this model
            # or [{label, score}, {label, score}] — handle both shapes
            if isinstance(raw, list) and len(raw) > 0:
                items = raw[0] if isinstance(raw[0], list) else raw
                ai_score = _extract_ai_score(items)
                print(f"[hf] chunk {chunk_index}/{total} → ai_score={ai_score:.4f}")
                return ai_score

            print(f"[hf] chunk {chunk_index} unexpected response shape: {raw}")
            return None

        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            err  = json.loads(body) if body.startswith("{") else {"error": body}

            if "loading" in err.get("error", "").lower():
                wait = err.get("estimated_time", RETRY_WAIT)
                print(f"[hf] model loading, waiting {wait}s (attempt {attempt}/{MAX_RETRIES})")
                time.sleep(min(wait, 60))
                continue

            if e.code == 429:
                print(f"[hf] rate limited, waiting 30s (attempt {attempt}/{MAX_RETRIES})")
                time.sleep(30)
                continue

            print(f"[hf] HTTP {e.code} on chunk {chunk_index}: {body[:200]}")
            return None

        except Exception as e:
            print(f"[hf] chunk {chunk_index} attempt {attempt} error: {e}")
            if attempt < MAX_RETRIES:
                time.sleep(5)
            continue

    print(f"[hf] chunk {chunk_index} failed after {MAX_RETRIES} attempts")
    return None


def _extract_ai_score(items: list) -> float:
    """
    roberta-base-openai-detector labels:
      "LABEL_0" or "Real" → human  →  ai_score = 1 - score
      "LABEL_1" or "Fake" → AI     →  ai_score = score
    """
    for item in items:
        label = item.get("label", "").upper()
        score = float(item.get("score", 0))
        if label in ("FAKE", "LABEL_1"):
            return score
        if label in ("REAL", "LABEL_0"):
            return 1.0 - score
    # Fallback: assume first item is AI probability
    return float(items[0].get("score", 0.5)) if items else 0.5


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _chunk_text(text: str) -> List[str]:
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    chunks, current = [], ""
    for s in sentences:
        if len(current) + len(s) + 1 <= CHUNK_SIZE:
            current = (current + " " + s).strip()
        else:
            if current:
                chunks.append(current)
            if len(s) > CHUNK_SIZE:
                for i in range(0, len(s), CHUNK_SIZE):
                    chunks.append(s[i:i+CHUNK_SIZE])
            else:
                current = s
    if current:
        chunks.append(current)

    #fix by chatgpt---------------
    if not chunks:
        return [text[:CHUNK_SIZE]]
    #done------------------------
    
    if len(chunks) > MAX_CHUNKS:
        step   = len(chunks) / MAX_CHUNKS
        chunks = [chunks[int(i * step)] for i in range(MAX_CHUNKS)]
    return chunks


def _make_label(score: float, confidence: float) -> str:
    if score >= 0.5:
        return "Likely AI"      if confidence > 0.7 else \
               "Possibly AI"    if confidence > 0.3 else "Uncertain (leans AI)"
    return     "Likely Human"   if confidence > 0.7 else \
               "Possibly Human" if confidence > 0.3 else "Uncertain (leans Human)"


def _classification(score: float) -> str:
    if score >= 0.75: return "likely_ai"
    if score >= 0.5:  return "possibly_ai"
    if score >= 0.25: return "possibly_human"
    return "likely_human"


def _confidence_level(confidence: float) -> str:
    if confidence > 0.7: return "high"
    if confidence > 0.3: return "medium"
    return "low"


def _error_result(msg: str) -> dict:
    return {
        "is_ai": None, "score": None, "confidence": None,
        "label": "Insufficient text", "provider": "huggingface",
        "error": msg,
        "details": {"chunks_analyzed": 0, "model": MODEL_ID},
        "ai_percentage": None, "human_percentage": None,
        "classification": "insufficient_text", "confidence_level": "none",
    }


# ── AWS helpers ────────────────────────────────────────────────────────────────

def _read_s3(key: str) -> str:
    return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read().decode("utf-8")


def _save(job_id: str, s3_key: str, analysis: dict):
    table.put_item(Item={
        "job_id":           job_id,
        "status":           "completed",
        "s3_key":           s3_key,
        "completed_at":     int(time.time()),
        "ttl":              int(time.time()) + RESULT_TTL,
        "is_ai":            str(analysis.get("is_ai")),
        "score":            str(analysis.get("score") or "null"),
        "confidence":       str(analysis.get("confidence") or "null"),
        "label":            analysis.get("label", ""),
        "classification":   analysis.get("classification", "unknown"),
        "confidence_level": analysis.get("confidence_level", "none"),
        "ai_percentage":    str(analysis.get("ai_percentage") or "null"),
        "analysis_json":    json.dumps(analysis),
    })


def _set_status(job_id: str, status: str, error: str = None):
    item = {"job_id": job_id, "status": status,
            "updated_at": int(time.time()), "ttl": int(time.time()) + RESULT_TTL}
    if error:
        item["error"] = error[:500]
    table.put_item(Item=item)