import asyncio
import json
import logging
import mimetypes
import os
import sqlite3
import subprocess
import time
import uuid
from contextlib import asynccontextmanager, closing, suppress
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import httpx
from google import genai
from google.genai import errors
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

load_dotenv()
from .analysis import MAX_BYTES, AnalysisError, analyze_video  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "data"
UPLOADS = DATA / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA / "app.db"
MAX_SECONDS = 150  # ~2 min plus tolerance
ALLOWED = {".mp4", ".mov", ".webm", ".mpeg", ".mpg", ".avi", ".m4v"}
logger = logging.getLogger(__name__)

def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


with closing(db()) as c:
    c.execute("""CREATE TABLE IF NOT EXISTS videos(
        id TEXT PRIMARY KEY, filename TEXT, path TEXT, mime TEXT, size INTEGER,
        status TEXT, error TEXT, report TEXT, created_at TEXT,
        batch_id TEXT, queued_at TEXT, batch_size INTEGER)""")
    columns = {row[1] for row in c.execute("PRAGMA table_info(videos)")}
    if "batch_id" not in columns:
        c.execute("ALTER TABLE videos ADD COLUMN batch_id TEXT")
    if "queued_at" not in columns:
        c.execute("ALTER TABLE videos ADD COLUMN queued_at TEXT")
        c.execute("UPDATE videos SET queued_at=created_at WHERE queued_at IS NULL")
    if "batch_size" not in columns:
        c.execute("ALTER TABLE videos ADD COLUMN batch_size INTEGER")
    c.execute("UPDATE videos SET batch_size=1 WHERE batch_size IS NULL")
    c.execute("""CREATE TABLE IF NOT EXISTS cancelled_batches(
        batch_id TEXT PRIMARY KEY, cancelled_at TEXT NOT NULL)""")
    c.commit()


def set_status(vid: str, status: str, error: str | None = None, report: str | None = None):
    with closing(db()) as c:
        c.execute("UPDATE videos SET status=?, error=?, report=COALESCE(?, report) WHERE id=?",
                  (status, error, report, vid))
        c.commit()


def duration_seconds(path: Path) -> float | None:
    """Uses ffprobe when installed; skips the check otherwise."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "csv=p=0", str(path)], capture_output=True, text=True, timeout=20)
        return float(out.stdout.strip())
    except Exception:
        return None


def process(vid: str):
    with closing(db()) as c:
        row = c.execute("SELECT * FROM videos WHERE id=?", (vid,)).fetchone()
    if not row:
        return
    set_status(vid, "processing")
    try:
        length = duration_seconds(Path(row["path"]))
        if length and length > MAX_SECONDS:
            raise AnalysisError(f"Video is {int(length)}s long. The limit is about 2 minutes.")
        report = analyze_video(Path(row["path"]), row["mime"])
        set_status(vid, "completed", report=report.model_dump_json())
    except AnalysisError as e:
        set_status(vid, "failed", error=str(e))
    except Exception as e:
        set_status(vid, "failed", error=f"Unexpected error: {e}")


def claim_next_queued() -> str | None:
    with closing(db()) as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT id FROM videos WHERE status='queued' ORDER BY queued_at ASC, id ASC LIMIT 1").fetchone()
        if not row:
            c.commit()
            return None
        result = c.execute("UPDATE videos SET status='processing' WHERE id=? AND status='queued'", (row["id"],))
        c.commit()
        return row["id"] if result.rowcount == 1 else None


async def queue_worker():
    while True:
        video_id = claim_next_queued()
        if video_id is None:
            await asyncio.sleep(0.5)
            continue
        await asyncio.to_thread(process, video_id)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    with closing(db()) as c:
        c.execute("UPDATE videos SET status='queued', error=NULL WHERE status='processing'")
        c.commit()
    worker = asyncio.create_task(queue_worker())
    try:
        yield
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker


app = FastAPI(title="Video Insights API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@lru_cache(maxsize=1)
def gemini_connected(_cache_minute: int) -> bool:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return False
    try:
        with genai.Client(api_key=key, http_options={"timeout": 5000}) as client:
            next(iter(client.models.list(config={"page_size": 1})), None)
        return True
    except (errors.APIError, httpx.HTTPError) as error:
        logger.warning("Gemini connection check failed: %s", type(error).__name__)
        return False


@app.get("/api/health")
def health():
    return {
        "backend": "ok",
        "gemini_key_configured": bool(os.environ.get("GEMINI_API_KEY")),
        "gemini_connected": gemini_connected(int(time.monotonic() // 60)),
    }


def serialize(row: sqlite3.Row, full: bool = False) -> dict:
    d = {k: row[k] for k in ("id", "filename", "size", "status", "error", "created_at")}
    d["batch_id"] = row["batch_id"]
    d["queued_at"] = row["queued_at"]
    d["batch_size"] = row["batch_size"]
    if full:
        d["report"] = json.loads(row["report"]) if row["report"] else None
    return d


def get_row(vid: str) -> sqlite3.Row:
    with closing(db()) as c:
        row = c.execute("SELECT * FROM videos WHERE id=?", (vid,)).fetchone()
    if not row:
        raise HTTPException(404, "Video not found.")
    return row


def video_name_key(filename: str) -> str:
    return Path(filename).stem.casefold()


@app.post("/api/videos", status_code=202)
async def upload(
    file: UploadFile = File(...),
    batch_id: str | None = Form(default=None),
    batch_size: int = Form(default=1),
):
    if batch_id is not None and len(batch_id) > 80:
        raise HTTPException(400, "Invalid upload batch identifier.")
    if batch_size < 1:
        raise HTTPException(400, "Batch size must be at least one.")
    ext = Path(file.filename or "").suffix.lower()
    mime = mimetypes.guess_type(file.filename or "")[0] or ""
    if ext not in ALLOWED or not mime.startswith("video/"):
        raise HTTPException(415, "Unsupported file type. Upload an MP4, MOV, WebM, MPEG or AVI video.")
    vid = uuid.uuid4().hex
    dest = UPLOADS / f"{vid}{ext}"
    size = 0
    with dest.open("wb") as out:  # stream to disk, abort early when too large
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "File is larger than 100 MB.")
            out.write(chunk)
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "The file is empty.")
    created_at = datetime.now(timezone.utc).isoformat()
    replaced_paths: list[str] = []
    replaced_count = 0
    try:
        with closing(db()) as c:
            c.execute("BEGIN IMMEDIATE")
            if batch_id is not None and c.execute(
                "SELECT 1 FROM cancelled_batches WHERE batch_id=?", (batch_id,)
            ).fetchone():
                raise HTTPException(409, "This upload batch was cancelled.")
            existing_rows = c.execute("SELECT id, filename, path FROM videos").fetchall()
            duplicates = [row for row in existing_rows if video_name_key(row["filename"] or "") == video_name_key(file.filename or "")]
            replaced_count = len(duplicates)
            replaced_paths = [row["path"] for row in duplicates if row["path"]]
            c.executemany("DELETE FROM videos WHERE id=?", [(row["id"],) for row in duplicates])
            c.execute("""INSERT INTO videos
                (id, filename, path, mime, size, status, error, report, created_at, batch_id, queued_at, batch_size)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                      (vid, file.filename, str(dest), mime, size, "queued", None, None,
                       created_at, batch_id, created_at, batch_size))
            c.commit()
    except Exception:
        dest.unlink(missing_ok=True)
        raise

    for old_path in replaced_paths:
        if old_path != str(dest):
            Path(old_path).unlink(missing_ok=True)
    return {"id": vid, "status": "queued", "batch_id": batch_id, "batch_size": batch_size, "replaced": replaced_count > 0}


@app.get("/api/videos")
def list_videos():
    with closing(db()) as c:
        rows = c.execute("SELECT * FROM videos ORDER BY created_at DESC").fetchall()
    return [serialize(r) for r in rows]


@app.get("/api/videos/{vid}")
def get_video(vid: str):
    return serialize(get_row(vid), full=True)


@app.get("/api/videos/{vid}/file")
def stream(vid: str):
    row = get_row(vid)
    return FileResponse(row["path"], media_type=row["mime"])


@app.post("/api/videos/{vid}/reanalyze", status_code=202)
def reanalyze(vid: str, batch_id: str | None = None):
    if batch_id is not None and (not batch_id or len(batch_id) > 80):
        raise HTTPException(400, "Invalid analysis batch identifier.")
    row = get_row(vid)
    if row["status"] in ("queued", "processing"):
        raise HTTPException(409, "This video is already being analyzed.")
    queued_at = datetime.now(timezone.utc).isoformat()
    batch_id = batch_id or uuid.uuid4().hex
    with closing(db()) as c:
        c.execute("BEGIN IMMEDIATE")
        if c.execute("SELECT 1 FROM cancelled_batches WHERE batch_id=?", (batch_id,)).fetchone():
            raise HTTPException(409, "This analysis batch was cancelled.")
        result = c.execute(
            "UPDATE videos SET status='queued', error=NULL, queued_at=?, batch_id=? WHERE id=? AND status IN ('failed', 'completed')",
            (queued_at, batch_id, vid),
        )
        if result.rowcount != 1:
            raise HTTPException(409, "This video is already being analyzed.")
        batch_size = c.execute("SELECT COUNT(*) FROM videos WHERE batch_id=?", (batch_id,)).fetchone()[0]
        c.execute("UPDATE videos SET batch_size=? WHERE batch_id=?", (batch_size, batch_id))
        c.commit()
    return {"id": vid, "status": "queued", "batch_id": batch_id}


@app.post("/api/batches/{batch_id}/reanalyze", status_code=202)
def reanalyze_failed_batch(batch_id: str):
    if not batch_id or len(batch_id) > 80:
        raise HTTPException(400, "Invalid analysis batch identifier.")
    new_batch_id = f"rerun-{uuid.uuid4().hex}"
    queued_at = datetime.now(timezone.utc).isoformat()
    with closing(db()) as c:
        c.execute("BEGIN IMMEDIATE")
        result = c.execute(
            "UPDATE videos SET status='queued', error=NULL, queued_at=?, batch_id=?, batch_size=1 WHERE batch_id=? AND status='failed'",
            (queued_at, new_batch_id, batch_id),
        )
        if result.rowcount == 0:
            raise HTTPException(409, "There are no failed evaluations to re-run in this batch.")
        c.execute("UPDATE videos SET batch_size=? WHERE batch_id=?", (result.rowcount, new_batch_id))
        c.commit()
    return {"batch_id": new_batch_id, "queued": result.rowcount}


@app.delete("/api/videos/{vid}", status_code=204)
def delete(vid: str):
    row = get_row(vid)
    Path(row["path"]).unlink(missing_ok=True)
    with closing(db()) as c:
        c.execute("DELETE FROM videos WHERE id=?", (vid,))
        c.commit()


@app.delete("/api/batches/{batch_id}")
def cancel_batch(batch_id: str):
    if not batch_id or len(batch_id) > 80:
        raise HTTPException(400, "Invalid upload batch identifier.")
    cancelled_at = datetime.now(timezone.utc).isoformat()
    with closing(db()) as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute(
            "INSERT OR IGNORE INTO cancelled_batches(batch_id, cancelled_at) VALUES(?, ?)",
            (batch_id, cancelled_at),
        )
        rows = c.execute("SELECT path FROM videos WHERE batch_id=?", (batch_id,)).fetchall()
        c.execute("DELETE FROM videos WHERE batch_id=?", (batch_id,))
        c.commit()
    for row in rows:
        if row["path"]:
            Path(row["path"]).unlink(missing_ok=True)
    return {"batch_id": batch_id, "deleted": len(rows)}
