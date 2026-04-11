# ◈ AIScope — Cloud-Based AI Content & Plagiarism Detector

A full-stack document analysis tool with two modes: **AI Content Detection** (is this text AI-generated?) and **Plagiarism Detection** (are these two documents copied from each other?). Built with React + Vite on the frontend and deployed serverlessly on AWS.

---

## Features

### 🔍 AI Detection
- Detects AI-generated text via `roberta-base-openai-detector` (125M param RoBERTa, fine-tuned on GPT-2/GPT-3 outputs)
- Paste text or upload **PDF, DOCX, or TXT** files — text extracted client-side, only plain text sent to backend
- **Version history sidebar** — every submission saved per browser session with AI%, timestamp, and document preview
- **Version labels** — tag submissions (e.g. "Draft 2", "Final") for easy comparison
- **Chunked inference** — documents split into 512-char chunks, scored individually, then averaged
- **Confidence scoring** — `confidence = |score − 0.5| × 2` with high / medium / low certainty labels
- Per-chunk score bar chart in the results view

### 📄 Plagiarism Check
- Compare **two documents** against each other for copied content
- Upload PDF, DOCX, or TXT for either document, or paste text directly
- **Sentence-level matching** — Jaccard trigram similarity finds near-identical passages
- **TF-IDF cosine similarity** — overall document-level vocabulary overlap score
- **Colour-coded highlights** — matching passages highlighted in both documents simultaneously, hover a match to locate it
- Overall similarity %, sentence coverage %, and match count
- Verdict: High plagiarism / Significant overlap / Some similarity / Minor / Original

### ☁️ Infrastructure
- Fully serverless — scales to zero when idle, no servers to manage
- Asynchronous AI detection via SQS queue — frontend polls for results
- Plagiarism check is synchronous — pure Python stdlib, no ML model, instant response
- `deploy.py` is fully idempotent — safe to run multiple times, never creates duplicate APIs

---

## Architecture

```
Browser (React + Vite)
    │
    ├── POST /analyze  ─────────────────────────────────────────────┐
    ├── GET  /results/{job_id}                                       │
    ├── GET  /history/{session_id}                                   │
    └── POST /plagiarism                                             │
                                                                     ▼
                                                        API Gateway (HTTP API)
                                                                     │
                                    ┌────────────────────────────────┤
                                    │                                │
                              upload_handler                  plagiarism_checker
                              • Saves text to S3              • Sentence-level Jaccard
                              • Writes job to DynamoDB          trigram matching
                              • Enqueues to SQS               • TF-IDF cosine similarity
                              • Returns job_id                • Returns highlights + score
                                    │
                              results_handler
                              • GET /results/{job_id}
                              • GET /history/{session_id}
                                    │
                                 SQS Queue
                                    │
                                    ▼
                               nlp_worker (SQS trigger)
                               • Reads text from S3
                               • Chunks into 512-char segments
                               • Calls HuggingFace Inference API
                               • Averages scores → confidence
                               • Writes result to DynamoDB
```

**AWS services:** S3 · SQS · Lambda · API Gateway · DynamoDB · IAM

---

## Project Structure

```
├── frontend/
│   ├── src/
│   │   ├── App.jsx                # Main app — tab switcher, AI detection flow, history sidebar
│   │   ├── PlagiarismChecker.jsx  # Plagiarism tab — two-doc upload, highlights, match list
│   │   ├── App.css                # Styles
│   │   └── main.jsx               # Entry point
│   ├── .env.example
│   ├── package.json
│   └── vite.config.js
│
├── lambdas/
│   ├── upload_handler/
│   │   └── handler.py       # POST /analyze — saves to S3, enqueues to SQS
│   ├── results_handler/
│   │   └── handler.py       # GET /results/{job_id}, GET /history/{session_id}
│   ├── nlp_worker/
│   │   └── handler.py       # SQS consumer — HuggingFace inference
│   └── plagiarism_checker/
│       └── handler.py       # POST /plagiarism — sentence matching + cosine similarity
│
├── setup_aws.py             # Run once — creates S3, SQS, DynamoDB, IAM role
├── deploy.py                # Idempotent deploy — updates Lambdas + API Gateway
└── README.md
```

---

## Setup & Deployment

### Prerequisites

- Python 3.11+
- Node.js 18+
- AWS account with CLI configured (`aws configure`)
- Free [HuggingFace account](https://huggingface.co) + access token

### 1. Create AWS resources (run once)

```bash
pip install boto3
python setup_aws.py
```

Creates the S3 bucket, SQS queue, DynamoDB table, and IAM role. Copy the printed output for the next step.

### 2. Set environment variables

```powershell
# PowerShell
$env:AWS_REGION="us-east-1"
$env:AWS_ACCOUNT_ID="YOUR_ACCOUNT_ID"
$env:S3_BUCKET_NAME="plagiarism-ai-docs"
$env:SQS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/YOUR_ACCOUNT/plagiarism-ai-jobs"
$env:DYNAMODB_TABLE="plagiarism-ai-results"
$env:LAMBDA_ROLE_ARN="arn:aws:iam::YOUR_ACCOUNT:role/plagiarism-lambda-role"
$env:HF_TOKEN="hf_your_token_here"
```

```bash
# Bash / macOS / Linux
export AWS_REGION="us-east-1"
export AWS_ACCOUNT_ID="YOUR_ACCOUNT_ID"
export S3_BUCKET_NAME="plagiarism-ai-docs"
export SQS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/YOUR_ACCOUNT/plagiarism-ai-jobs"
export DYNAMODB_TABLE="plagiarism-ai-results"
export LAMBDA_ROLE_ARN="arn:aws:iam::YOUR_ACCOUNT:role/plagiarism-lambda-role"
export HF_TOKEN="hf_your_token_here"
```

### 3. Deploy all Lambdas + API Gateway

```bash
python deploy.py
```

Safe to run multiple times — finds the existing API by name and patches it, never creates duplicates. Copy the printed `VITE_API_BASE_URL` for the next step.

### 4. Configure and run the frontend

```bash
cd frontend
cp .env.example .env
# Set VITE_API_BASE_URL in .env to the value printed by deploy.py

npm install
npm run dev
```

---

## Environment Variables

### Frontend (`frontend/.env`)

| Variable | Description |
|---|---|
| `VITE_API_BASE_URL` | API Gateway endpoint printed by `deploy.py` |

### Backend (set before running `deploy.py`)

| Variable | Description |
|---|---|
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |
| `AWS_ACCOUNT_ID` | Your 12-digit AWS account ID |
| `S3_BUCKET_NAME` | S3 bucket name from `setup_aws.py` |
| `SQS_QUEUE_URL` | SQS queue URL from `setup_aws.py` |
| `DYNAMODB_TABLE` | DynamoDB table name |
| `LAMBDA_ROLE_ARN` | IAM role ARN from `setup_aws.py` |
| `HF_TOKEN` | HuggingFace API token |

---

## How AI Detection Works

1. Text split into **512-character chunks** (max 20 per document)
2. Each chunk sent to HuggingFace Inference API (`roberta-base-openai-detector`)
3. Model returns probability per chunk — `FAKE` = AI, `REAL` = human
4. Chunk scores **averaged** → final score (0–1)
5. Confidence = `|score − 0.5| × 2`

| Score | Confidence | Label |
|---|---|---|
| ≥ 0.5 | > 0.7 | Likely AI |
| ≥ 0.5 | 0.3–0.7 | Possibly AI |
| < 0.5 | > 0.7 | Likely Human |
| < 0.5 | 0.3–0.7 | Possibly Human |
| any | < 0.3 | Uncertain |

---

## How Plagiarism Detection Works

1. Both documents split into sentences (min 6 words each)
2. Every sentence in Doc 1 compared to every sentence in Doc 2 using **Jaccard trigram similarity**
3. Pairs above 0.5 similarity threshold flagged as matches (greedy, no double-matching)
4. **TF-IDF cosine similarity** computed at document level for vocabulary overlap
5. Final similarity % = blend of sentence coverage + cosine similarity
6. Character offsets computed for each match → rendered as coloured highlights in the UI

| Similarity | Verdict |
|---|---|
| ≥ 75% | High plagiarism detected |
| ≥ 50% | Significant overlap found |
| ≥ 25% | Some similarity detected |
| ≥ 10% | Minor similarity |
| < 10% | Documents appear original |

---

## Re-deploying After Changes

```bash
python deploy.py
```

Updates all 4 Lambdas in place, idempotently adds any missing routes, refreshes CORS, and redeploys the stage. Your `.env` never needs to change.

---

## Cost

Effectively **$0** for personal/academic use:

| Service | Free tier |
|---|---|
| HuggingFace Inference API | Free |
| AWS Lambda | 1M requests/month |
| AWS SQS | 1M requests/month |
| AWS DynamoDB | 25 GB storage |
| AWS S3 | 5 GB storage |

---

## Notes

- First AI detection after a cold start may take ~60s while the HuggingFace model loads. Subsequent runs are fast.
- AI detection results stored in DynamoDB with a **7-day TTL**, then auto-deleted.
- Plagiarism results are **not stored** — computed on demand and returned directly.
- Version history is scoped to the browser session via `localStorage`. Clearing browser data resets it.
- PDF and DOCX text extraction is entirely **client-side** (PDF.js + mammoth.js loaded from CDN) — only plain text is sent to the backend, no file upload costs.
