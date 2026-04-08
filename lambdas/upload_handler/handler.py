"""
Lambda: upload_handler
Triggered by: API Gateway  POST /analyze
Saves document to S3, queues job to SQS, returns job_id immediately.
Now supports: plain text, PDF (base64), DOCX (base64), and version history via session_id.
"""
import json, uuid, os, base64, time
import boto3
from botocore.exceptions import ClientError

s3  = boto3.client("s3",  region_name=os.environ["AWS_REGION"])
sqs = boto3.client("sqs", region_name=os.environ["AWS_REGION"])
dynamodb = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"])
table    = dynamodb.Table(os.environ["DYNAMODB_TABLE"])

BUCKET    = os.environ["S3_BUCKET_NAME"]
QUEUE_URL = os.environ["SQS_QUEUE_URL"]


def handler(event, context):
    try:
        job_id, text, meta = _parse_input(event)
        _save_to_s3(job_id, text)
        _create_job_record(job_id, meta)
        _enqueue(job_id)
        return _ok({
            "job_id": job_id,
            "status": "queued",
            "session_id": meta.get("session_id", ""),
            "filename": meta.get("filename", ""),
            "message": "Document received. Poll GET /results/{job_id} for results."
        })
    except ValueError as e:
        return _err(400, str(e))
    except ClientError as e:
        return _err(500, f"AWS error: {e.response['Error']['Message']}")
    except Exception as e:
        return _err(500, str(e))


def _parse_input(event):
    job_id = str(uuid.uuid4())
    body   = event.get("body", "") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8", errors="replace")
    try:
        parsed = json.loads(body) if isinstance(body, str) else (body or {})
    except json.JSONDecodeError:
        parsed = {}

    file_type = parsed.get("file_type", "text").lower()  # "text", "pdf", "docx"
    filename  = parsed.get("filename", "")
    session_id = parsed.get("session_id", str(uuid.uuid4()))  # client generates once per browser session
    version_label = parsed.get("version_label", "")           # optional user-provided label

    if file_type == "text":
        text = parsed.get("text", "").strip()
        if not text:
            raise ValueError("Request body must contain a non-empty 'text' field.")
        if len(text) < 50:
            raise ValueError("Text too short (minimum 50 characters).")
    elif file_type in ("pdf", "docx"):
        # Frontend sends base64-encoded file bytes + extracted text
        # Text extraction happens client-side (pdfjs / mammoth.js)
        text = parsed.get("text", "").strip()
        if not text:
            raise ValueError("No text extracted from the uploaded file.")
        if len(text) < 50:
            raise ValueError("Extracted text too short (minimum 50 characters).")
    else:
        raise ValueError(f"Unsupported file_type: {file_type}. Use 'text', 'pdf', or 'docx'.")

    # Store first 300 chars as a preview (shown in the saved result view)
    text_preview = text[:300] + ("…" if len(text) > 300 else "")

    meta = {
        "session_id":    session_id,
        "filename":      filename,
        "file_type":     file_type,
        "version_label": version_label,
        "submitted_at":  int(time.time()),
        "text_preview":  text_preview,
    }
    return job_id, text, meta


def _save_to_s3(job_id, text):
    s3.put_object(
        Bucket=BUCKET,
        Key=f"uploads/{job_id}.txt",
        Body=text.encode("utf-8"),
        ContentType="text/plain",
        Metadata={"job_id": job_id, "uploaded_at": str(int(time.time()))},
    )


def _create_job_record(job_id, meta):
    """Write an initial 'queued' record with metadata so /history can list it immediately."""
    table.put_item(Item={
        "job_id":        job_id,
        "status":        "queued",
        "session_id":    meta["session_id"],
        "filename":      meta["filename"],
        "file_type":     meta["file_type"],
        "version_label": meta["version_label"],
        "submitted_at":  meta["submitted_at"],
        "text_preview":  meta.get("text_preview", ""),
        "ttl":           int(time.time()) + 7 * 24 * 3600,
    })


def _enqueue(job_id):
    sqs.send_message(
        QueueUrl=QUEUE_URL,
        MessageBody=json.dumps({
            "job_id":     job_id,
            "s3_key":     f"uploads/{job_id}.txt",
            "queued_at":  int(time.time()),
        }),
    )


def _ok(body, code=202):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body),
    }

def _err(code, msg):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps({"error": msg}),
    }