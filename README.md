# Video Insights

Upload a short creator video and get an AI evaluation: summary, audio, visual, timestamped highlights, overall quality and marketing insights, including audience-fit product and service niches for potential ad placements. Reports are saved and reopenable.

## Run locally

You need **Python 3.10+**, **Node.js 18+** (includes npm), and a Gemini API key
from [Google AI Studio](https://aistudio.google.com/app/apikey). Run commands
from the repository root (`shortVideoInsightsApp`), which contains `backend/`
and `frontend/`.
Keep two terminals open: one for each server.

### 1. Set up the backend (terminal 1)

**macOS / Linux:**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp -n .env.example .env
```

**Windows PowerShell:**

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Open **`backend/.env`** in a text editor. Replace the placeholder key with
your own, without spaces around `=`:

```dotenv
GEMINI_API_KEY=your_actual_key_here
GEMINI_MODEL=gemini-3.8-flash
```

Quotes around the key are optional. The model shown matches the application's
current default; if it is unavailable to your account, choose another Gemini
video-capable model. Save the file, then start the backend **from the `backend`
folder**:

```bash
python -m uvicorn app.main:app --reload --port 8000
```

Leave this terminal running. To verify the backend and Gemini connection,
visit [http://127.0.0.1:8000/api/health](http://127.0.0.1:8000/api/health).
It should show `"backend":"ok"` and `"gemini_connected":true`. This checks
that Gemini accepts the key via a model-list request (cached for up to one
minute); it does **not** test video generation, quota, or model availability.

### 2. Start the frontend (terminal 2)

From the repository root, run:

```bash
cd frontend
npm ci
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Open [http://127.0.0.1:5174/](http://127.0.0.1:5174/). The command fixes the
frontend to that address instead of letting Vite choose a different port.
The frontend proxies `/api` requests to the backend on port 8000. Upload a
short video to start an evaluation. Leave both terminals running; press Ctrl+C
in each to stop them.

Your key stays in `backend/.env` between sessions, so you only enter it once.
The root `.gitignore` excludes `.env`; do not put real keys in `.env.example`,
the frontend, or Git, and do not force-add `.env`. Restart the backend whenever
you edit `.env`.

### Troubleshooting

| What you see | What to check |
| --- | --- |
| `python` / `python3` / `py` or `npm` not found | Install the required Python or Node.js version, open a new terminal, and check `python --version` (or `python3 --version` / `py -3 --version`) and `node --version`. |
| PowerShell blocks `Activate.ps1` | In that PowerShell window, run `Set-ExecutionPolicy -Scope Process Bypass`, then activate the virtual environment again. |
| `ModuleNotFoundError`, `uvicorn` not found, or frontend dependencies missing | Activate `backend/.venv` and rerun `python -m pip install -r requirements.txt`; for the frontend, run `npm ci` inside `frontend/`. |
| `Address already in use` on port 8000 | An earlier backend (or another service) is already using the port. If [the health URL](http://127.0.0.1:8000/api/health) responds, use that server or stop it in its terminal before starting a new one. The frontend expects port 8000. |
| Port 5174 is already in use | If [the frontend](http://127.0.0.1:5174/) loads, use that running instance; otherwise stop the process using 5174 before restarting the frontend. The `--strictPort` flag prevents an unexpected switch to another port. |
| `Server unavailable` or failed `/api` requests | Start the backend, check [the health URL](http://127.0.0.1:8000/api/health), and keep its terminal open. Start the frontend with the command above rather than opening `index.html` directly. |
| `Gemini connection failure`, `gemini_connected:false`, or an invalid-key error | Check the key in **`backend/.env`**, replace it if Gemini rejects it, and restart the backend. A non-empty key alone does not mean Gemini accepts it. If you also exported `GEMINI_API_KEY` in your shell, that value takes precedence over `.env`; remove the stale shell variable and restart. Connection checks can take up to a minute to refresh. |
| `Gemini connected` but an evaluation fails | Open the video report for its specific error and check backend terminal output. A connected key does not guarantee that the selected model exists, your quota is available, or Gemini can process that video. Verify `GEMINI_MODEL` in `.env` and try a supported short MP4. |
| Upload rejected or duration not enforced | Videos must be MP4, MOV, WebM, MPEG, MPG, AVI, or M4V and at most 100 MB. Install `ffprobe` (part of FFmpeg) to enforce the backend's 150-second limit; without it, the duration check is skipped. |

Failed reports remain failed until you rerun them; fixing the key does not
retroactively update an earlier report. The backend stores videos and reports
locally in `backend/data/` (also Git-ignored).

## Architecture
```
React (Vite) ──/api──▶ FastAPI ──▶ SQLite (metadata + report JSON)
                          │  └────▶ local disk (videos)
                          └─ Queue worker ─▶ Gemini (Files API + structured output)
```
- `POST /api/videos` streams the upload to disk (aborting past 100 MB), stores a `queued` row and returns at once.
- A background worker moves it `queued → processing → completed | failed`; the UI polls every few seconds.
- `analysis.py` is isolated from HTTP/DB code. One Gemini generation call sees audio and video together and returns JSON validated by Pydantic, including ranked marketing niches with audience fit and integration ideas (one retry for generation/response failures).
- Extras: timestamped highlights (click to seek), grouped library re-runs through the analysis queue (open the queued video's report to watch progress; videos return to the library when finished), in-report re-runs with in-place progress, retry failed batches, delete.

## Decisions and trade-offs
- **Gemini for everything**: it takes video natively, so no separate transcription/frame pipeline.
- **Queue worker + SQLite + local disk**: zero infrastructure, easy to run. Processing jobs are requeued on restart; any in-flight Gemini work may be repeated.
- **Polling over WebSockets**: simpler, adequate for one-minute jobs.

## At thousands of videos/day
Direct-to-S3/GCS presigned uploads; a real queue and workers (SQS/Celery/Cloud Tasks) with retries and dead-letter; Postgres; rate limiting and backoff against the AI API; auth per user; cost controls (downscale/trim before upload, cache by file hash).

## Known limitations
No auth; duration check needs `ffprobe` (skipped if absent); no tests yet; model scores are subjective and unvalidated; single-process job handling.
