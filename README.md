# ◈ AIScope — Cloud-Based AI Plagiarism Detector

A full-stack AI content detection tool that analyses text, PDFs, and DOCX files for AI-generated content using HuggingFace's `roberta-base-openai-detector` model, deployed serverlessly on AWS.

---

## Features

- **AI detection** via `roberta-base-openai-detector` (125M param RoBERTa, fine-tuned on GPT-2/GPT-3 outputs)
- **File upload support** — paste text, or upload PDF, DOCX, or TXT files (text extracted client-side, no file stored)
- **Version history** — every submission is saved per browser session, with AI% and timestamp shown in a sidebar
- **Document preview** — see the first 300 characters of each analysed document when browsing history
- **Version labels** — optionally tag each submission (e.g. "Draft 2", "Final")
- **Chunked inference** — long documents are split into 512-char chunks, scored individually, then averaged
- **Confidence scoring** — `confidence = |score − 0.5| × 2` gives a clear high/medium/low certainty signal
- **Fully serverless** — no servers to manage, scales to zero when idle

---

## Architecture

```
Browser (React + Vite)
    │
    │  POST /analyze  { text, filename, file_type, session_id }
    ▼
API Gateway (HTTP API)
    │
    ├──▶ Lambda: upload_handler
    │       • Saves text to S3
    │       • Writes initial job record to DynamoDB
    │       • Enqueues job_id to SQS
    │       • Returns job_id immediately
    │
    ├──▶ Lambda: results_handler
    │       • GET /results/{job_id}   → single result
    │       • GET /history/{session_id} → all jobs for session
    │
    └──▶ SQS Queue
            │
            ▼
        Lambda: nlp_worker (triggered by SQS)
            • Reads text from S3
            • Chunks text (512 chars, max 20 chunks)
            • Calls HuggingFace Inference API per chunk
            • Averages scores, computes confidence
            • Writes completed result to DynamoDB
```

**AWS services used:** S3 · SQS · Lambda · API Gateway · DynamoDB · IAM

---

## Project Structure

```
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Main React app
│   │   ├── App.css          # Base styles
│   │   └── main.jsx         # Entry point
│   ├── .env.example         # Environment variable template
│   ├── package.json
│   └── vite.config.js
│
├── lambdas/
│   ├── upload_handler/
│   │   └── handler.py       # POST /analyze
│   ├── results_handler/
│   │   └── handler.py       # GET /results, GET /history
│   └── nlp_worker/
│       └── handler.py       # SQS consumer, HF inference
│
├── setup_aws.py             # Run once — creates all AWS resources
├── deploy.py                # Deploys / updates all Lambdas + API Gateway
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

This creates the S3 bucket, SQS queue, DynamoDB table, and IAM role. Copy the printed output — you'll need it in the next step.

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

### 3. Deploy Lambdas + API Gateway

```bash
python deploy.py
```

Copy the printed `VITE_API_BASE_URL` value for the next step.

### 4. Configure and run the frontend

```bash
cd frontend
cp .env.example .env
# Edit .env and set VITE_API_BASE_URL to the value from deploy.py output

npm install
npm run dev
```

---

## Environment Variables

### Frontend (`frontend/.env`)

| Variable | Description |
|---|---|
| `VITE_API_BASE_URL` | API Gateway endpoint from `deploy.py` output |

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

## How Detection Works

1. Text is split into **512-character chunks** (max 20 chunks per document)
2. Each chunk is sent to the HuggingFace Inference API (`roberta-base-openai-detector`)
3. The model returns a probability score per chunk (`FAKE` = AI, `REAL` = human)
4. Chunk scores are **averaged** to produce a final score (0–1)
5. **Confidence** is derived as `|score − 0.5| × 2` — how far from the uncertain midpoint
6. Labels are assigned:

| Score | Confidence | Label |
|---|---|---|
| ≥ 0.5 | > 0.7 | Likely AI |
| ≥ 0.5 | 0.3–0.7 | Possibly AI |
| < 0.5 | > 0.7 | Likely Human |
| < 0.5 | 0.3–0.7 | Possibly Human |
| any | < 0.3 | Uncertain |

---

## Re-deploying After Changes

Just run `deploy.py` again with the same env vars — it updates all three Lambdas in place and adds any missing API Gateway routes without recreating anything.

```bash
python deploy.py
```

---

## Cost

Effectively **$0** for personal/academic use:

- HuggingFace Inference API — free tier
- AWS Lambda — 1M free requests/month
- AWS SQS — 1M free requests/month
- AWS DynamoDB — 25GB free tier
- AWS S3 — 5GB free tier

---

## Notes

- First analysis after a cold start may take ~60 seconds while the HuggingFace model loads. Subsequent runs are fast.
- Results are stored in DynamoDB with a **7-day TTL** and then automatically deleted.
- Version history is scoped to the browser session (stored in `localStorage`). Clearing browser data resets it.
- PDF and DOCX text extraction happens entirely **client-side** — only the extracted plain text is sent to the backend.
