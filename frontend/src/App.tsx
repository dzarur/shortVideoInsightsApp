import { useCallback, useEffect, useRef, useState } from "react";
import { api, ServiceHealth, Status, Video } from "./api";

const MAX_MB = 100;
const active = (s: Status) => s === "queued" || s === "processing";
const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued", processing: "Processing", completed: "Ready", failed: "Failed",
};

function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status]}</span>;
}

function Rating({ label, value, max = 5 }: { label: string; value: number; max?: number }) {
  return (
    <div className="rating">
      <span>{label}</span>
      <div className="bar" role="img" aria-label={`${value} out of ${max}`}>
        <i style={{ width: `${(value / max) * 100}%` }} />
      </div>
      <b>{value}/{max}</b>
    </div>
  );
}

function List({ items }: { items: string[] }) {
  return items.length ? <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="muted">None found.</p>;
}

function qualityVerdict(score: number) {
  if (score >= 9) return "Excellent quality";
  if (score >= 7) return "Strong quality";
  if (score >= 5) return "Usable with improvements";
  return "Needs improvement";
}

type UploadCancelRef = { current: (() => void) | null };

function Upload({ onBatchStarted, onUploaded, cancelUploadRef }: { onBatchStarted: (batchId: string) => void; onUploaded: () => void; cancelUploadRef: UploadCancelRef }) {
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPosition, setUploadPosition] = useState({ index: 0, count: 0, name: "" });
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [replacementNotice, setReplacementNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const activeUploadController = useRef<AbortController | null>(null);
  const cancellationRequested = useRef(false);

  cancelUploadRef.current = () => {
    cancellationRequested.current = true;
    activeUploadController.current?.abort();
  };
  useEffect(() => () => { cancelUploadRef.current = null; }, [cancelUploadRef]);

  const submit = async (fileList?: FileList | File[]) => {
    if (!fileList || uploadLock.current) return;
    const files = Array.from(fileList);
    if (!files.length) return;

    setReplacementNotice("");
    const validFiles: File[] = [];
    const validationErrors: string[] = [];
    files.forEach((file) => {
      if (!file.type.startsWith("video/")) validationErrors.push(`${file.name}: not a supported video file.`);
      else if (file.size > MAX_MB * 1024 * 1024) validationErrors.push(`${file.name}: exceeds ${MAX_MB} MB.`);
      else validFiles.push(file);
    });
    const filesByName = new Map<string, File>();
    validFiles.forEach((file) => filesByName.set(displayVideoName(file.name).toLocaleLowerCase(), file));
    const uploadFiles = Array.from(filesByName.values());
    setErrors(validationErrors);
    if (!uploadFiles.length) {
      return;
    }

    const batchId = crypto.randomUUID();
    uploadLock.current = true;
    cancellationRequested.current = false;
    onBatchStarted(batchId);
    setBusy(true);
    setUploadProgress(0);
    let replacedCount = 0;
    for (const [index, file] of uploadFiles.entries()) {
      if (cancellationRequested.current) break;
      setUploadPosition({ index: index + 1, count: uploadFiles.length, name: file.name });
      setUploadProgress(0);
      const controller = new AbortController();
      activeUploadController.current = controller;
      try {
        const result = await api.upload(file, setUploadProgress, batchId, uploadFiles.length, controller.signal);
        if (result.replaced) replacedCount += 1;
        onUploaded();
      } catch (error) {
        if (!cancellationRequested.current) {
          validationErrors.push(`${file.name}: ${(error as Error).message}`);
          setErrors([...validationErrors]);
        }
      } finally {
        if (activeUploadController.current === controller) activeUploadController.current = null;
      }
    }
    setErrors(validationErrors);
    if (replacedCount > 0) setReplacementNotice(`${replacedCount} existing ${replacedCount === 1 ? "video was" : "videos were"} replaced by name.`);
    setBusy(false);
    setUploadProgress(0);
    setUploadPosition({ index: 0, count: 0, name: "" });
    uploadLock.current = false;
    cancelUploadRef.current = null;
  };

  return (
    <>
      <header className="upload-intro">
        <h1>Generate Video Analysis</h1>
        <p>Evaluate creator videos, find what works, and make your next move with confidence.</p>
      </header>
      <section
        className={`upload${dragging ? " is-dragging" : ""}`}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); submit(e.dataTransfer.files); }}
        aria-label="Video upload drop zone"
      >
        <input ref={input} type="file" accept="video/*" multiple hidden onChange={(e) => { submit(e.target.files ?? undefined); e.currentTarget.value = ""; }} />
        <svg className="upload-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <path d="M18 45h-3a11 11 0 0 1-1-22 18 18 0 0 1 34-3 13 13 0 0 1 3 25h-5" />
          <path d="M32 52V29m0 0-9 9m9-9 9 9" />
        </svg>
        <button className="primary upload-button" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : "Browse"}
        </button>
        {busy && (
          <div className="upload-progress-wrap">
            <div className="activity-bar determinate" role="progressbar" aria-label="Video upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress}>
              <span style={{ width: `${uploadProgress}%` }} />
            </div>
            <span className="upload-progress-label">{uploadProgress >= 100 ? "Saving to library…" : `Uploading ${uploadPosition.index} of ${uploadPosition.count} · ${uploadProgress}%`}</span>
            <span className="upload-file-name">{uploadPosition.name}</span>
          </div>
        )}
        <p className="upload-meta">MP4, MOV, WebM · Up to 2 minutes / {MAX_MB} MB per video</p>
        {replacementNotice && <p className="upload-success" role="status">{replacementNotice}</p>}
        {errors.length > 0 && <ul className="error upload-errors" role="alert">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
      </section>
    </>
  );
}

function displayVideoName(filename: string) {
  const extensionIndex = filename.lastIndexOf(".");
  return extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
}

function displayFailureMessage(message?: string | null) {
  if (!message) return "This video couldn't be analyzed. Please try again.";
  if (/API_KEY_INVALID|API key not valid|invalid API key|Gemini rejected the API key/i.test(message)) {
    return "Gemini rejected the API key. Replace GEMINI_API_KEY in backend/.env with a valid key and restart the backend.";
  }
  if (message === "Video analysis is temporarily unavailable. Please try again later." || /not configured|GEMINI_API_KEY/i.test(message)) {
    return "The backend did not have a Gemini API key when this analysis ran. Check GEMINI_API_KEY in backend/.env and restart the backend.";
  }
  if (/API key/i.test(message)) {
    return "Gemini could not use the configured API key. Check GEMINI_API_KEY in backend/.env and restart the backend.";
  }
  if (/traceback|internal server error/i.test(message)) {
    return "The backend could not complete the analysis. Check its server logs.";
  }
  return message;
}

function VideoThumbnail({ video }: { video: Video }) {
  const [ready, setReady] = useState(false);

  return (
    <div className={`video-thumb${ready ? " has-frame" : ""}`} aria-hidden="true">
      <svg className="thumb-fallback" viewBox="0 0 48 48">
        <rect x="5" y="8" width="38" height="32" rx="5" />
        <path d="m20 17 12 7-12 7z" />
      </svg>
      <video
        src={api.fileUrl(video.id)}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          if (element.duration > 0) element.currentTime = Math.min(1, element.duration / 4);
        }}
        onLoadedData={() => setReady(true)}
        onSeeked={() => setReady(true)}
        onError={() => setReady(false)}
      />
      <span className="thumb-duration">VIDEO</span>
    </div>
  );
}

function QueueProgress({ videos, batchId, batchIsActive, canceling, rerunning, onClose, onOpen, onRerunFailed }: { videos: Video[]; batchId: string; batchIsActive: boolean; canceling: boolean; rerunning: boolean; onClose: () => void; onOpen: (id: string) => void; onRerunFailed: () => void }) {
  const queuedVideos = videos
    .filter((video) => batchId ? video.batch_id === batchId : !video.batch_id && active(video.status))
    .sort((a, b) => (a.queued_at || a.created_at).localeCompare(b.queued_at || b.created_at));
  if (!queuedVideos.length) return null;
  const expectedTotal = Math.max(queuedVideos.length, ...queuedVideos.map((video) => video.batch_size || 1));

  const current = queuedVideos.find((video) => video.status === "processing") || queuedVideos.find((video) => active(video.status));
  const succeeded = queuedVideos.filter((video) => video.status === "completed").length;
  const failed = queuedVideos.filter((video) => video.status === "failed").length;
  const resolved = succeeded + failed;
  const batchSettled = resolved >= expectedTotal;
  const batchHasFailures = failed > 0;
  const percent = Math.round((succeeded / expectedTotal) * 100);
  const position = current ? queuedVideos.indexOf(current) + 1 : 0;
  const remaining = current
    ? Math.max(0, expectedTotal - position + (current.status === "queued" ? 1 : 0))
    : 0;

  return (
    <section className="queue-progress" aria-label="Batch analysis progress">
      <button
        className="queue-dismiss"
        type="button"
        onClick={onClose}
        disabled={canceling || (batchIsActive && !batchId)}
        aria-label={batchIsActive ? "Cancel batch and delete its videos" : "Dismiss batch progress"}
        title={batchIsActive ? "Cancel batch and delete its videos" : "Dismiss batch progress"}
      >×</button>
      {current ? (
        <button className="queue-thumbnail-link" type="button" onClick={() => onOpen(current.id)} aria-label={`View progress for ${displayVideoName(current.filename)}`}>
          <VideoThumbnail video={current} />
        </button>
      ) : batchSettled && !batchHasFailures ? <div className="queue-complete-mark" aria-hidden="true">✓</div> : batchSettled ? <div className="queue-failed-mark" aria-hidden="true">!</div> : <div className="queue-pending-mark" aria-hidden="true">···</div>}
      <div className="queue-current">
        <span className="queue-eyebrow">{current ? (current.status === "processing" ? "AI evaluation in progress" : "In the analysis queue") : batchSettled ? batchHasFailures ? "Evaluation failed" : "Batch complete" : "Upload in progress"}</span>
        {(current || !batchSettled || !batchHasFailures) && (
          <strong>{current ? displayVideoName(current.filename) : batchSettled ? `${succeeded} of ${expectedTotal} videos evaluated` : "Waiting for videos to upload"}</strong>
        )}
        {!(batchSettled && batchHasFailures) && (
          <span className="queue-status">
            {current
              ? current.status === "processing"
                ? `Analyzing video ${position} of ${expectedTotal}${remaining > 0 ? ` · ${remaining} remaining` : ""}`
                : `Queued video ${position} of ${expectedTotal}${remaining > 0 ? ` · ${remaining} remaining` : ""}`
              : batchSettled
                ? "All reports are ready to review"
                : `${queuedVideos.length} of ${expectedTotal} videos added to the queue`}
          </span>
        )}
        {current && <button className="queue-view" type="button" onClick={() => onOpen(current.id)}>View report progress ↗</button>}
        {batchSettled && batchHasFailures && batchId && (
          <button className="queue-rerun" type="button" onClick={onRerunFailed} disabled={rerunning}>
            {rerunning ? "Starting…" : failed === 1 ? "Re-run analysis" : "Re-run all failed analyses"}
          </button>
        )}
      </div>
      <div className="queue-overall">
        <strong>{succeeded}<small>/{expectedTotal}</small></strong>
        <span>successful</span>
        <div className={`queue-bar${batchHasFailures ? " has-failures" : ""}`} role="progressbar" aria-label="Successful evaluations in batch" aria-valuemin={0} aria-valuemax={expectedTotal} aria-valuenow={succeeded}>
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>
    </section>
  );
}

function History({ videos, onOpen, onRerun }: { videos: Video[]; onOpen: (id: string) => void; onRerun: (id: string) => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [qualityScores, setQualityScores] = useState<Record<string, number | null>>({});
  const requestedScores = useRef(new Set<string>());
  const scoreKey = (video: Video) => `${video.id}:${video.queued_at || video.created_at}`;
  const seenNames = new Set<string>();
  const uniqueVideos = [...videos]
    .filter((video) => !active(video.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .filter((video) => {
      const nameKey = displayVideoName(video.filename).toLocaleLowerCase();
      if (seenNames.has(nameKey)) return false;
      seenNames.add(nameKey);
      return true;
    });

  useEffect(() => {
    const completedWithoutScore = videos.filter((video) => video.status === "completed" && qualityScores[scoreKey(video)] === undefined && !requestedScores.current.has(scoreKey(video)));
    completedWithoutScore.forEach((video) => requestedScores.current.add(scoreKey(video)));
    if (!completedWithoutScore.length) return;

    Promise.all(completedWithoutScore.map(async (video) => {
      try {
        const detail = await api.get(video.id);
        return [scoreKey(video), detail.report?.overall_quality_score ?? null] as const;
      } catch {
        return [scoreKey(video), null] as const;
      }
    })).then((entries) => setQualityScores((current) => ({ ...current, ...Object.fromEntries(entries) })));
  }, [videos, qualityScores]);

  const filteredVideos = uniqueVideos
    .filter((video) => displayVideoName(video.filename).toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === "oldest") return a.created_at.localeCompare(b.created_at);
      if (sort === "name") return displayVideoName(a.filename).localeCompare(displayVideoName(b.filename));
      if (sort === "quality") return (qualityScores[scoreKey(b)] ?? -1) - (qualityScores[scoreKey(a)] ?? -1);
      return b.created_at.localeCompare(a.created_at);
    });

  const retry = async (event: React.MouseEvent, video: Video) => {
    event.stopPropagation();
    setRetryingId(video.id);
    setRetryError(null);
    try {
      await onRerun(video.id);
    } catch (error) {
      setRetryError(displayFailureMessage((error as Error).message || "Could not restart this evaluation."));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <section className="library" aria-labelledby="library-title">
      <div className="library-heading">
        <div className="library-title-group">
          <h2 id="library-title">Your library</h2>
          <span>{uniqueVideos.length} {uniqueVideos.length === 1 ? "video" : "videos"}</span>
        </div>
        <div className="library-controls">
          <label className="search-box">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" /><path d="m15.5 15.5 4 4" /></svg>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your videos" aria-label="Search your videos" />
          </label>
          <label className="sort-box">
            <span className="sr-only">Sort videos</span>
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="quality">Highest score</option>
              <option value="name">Name A–Z</option>
            </select>
          </label>
        </div>
      </div>

      {retryError && <p className="error library-error" role="alert">{retryError}</p>}
      {uniqueVideos.length === 0 ? (
        <p className="library-empty">Your analyzed videos will appear here.</p>
      ) : filteredVideos.length === 0 ? (
        <p className="library-empty">No videos match “{search}”.</p>
      ) : (
        <>
          <div className="library-columns" aria-hidden="true">
            <span>Video</span><span>Evaluation</span><span>Quality score</span><span>Added</span><span />
          </div>
          <div className="library-list">
            {filteredVideos.map((video) => (
              <article
                className="library-row"
                key={video.id}
                onClick={() => onOpen(video.id)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(video.id); } }}
                tabIndex={0}
                aria-label={`Open report for ${displayVideoName(video.filename)}`}
              >
                <div className="library-video">
                  <VideoThumbnail video={video} />
                  <div className="library-video-copy">
                    <strong>{displayVideoName(video.filename)}</strong>
                    <span>{video.filename.split(".").pop()?.toUpperCase()} · {(video.size / (1024 * 1024)).toFixed(1)} MB</span>
                  </div>
                </div>
                <div className="library-evaluation">
                  <StatusBadge status={video.status} />
                  {active(video.status) && <span>{video.status === "queued" ? "Waiting to start" : "Analyzing video"}</span>}
                </div>
                <div className="library-score">
                  {video.status === "completed" && qualityScores[scoreKey(video)] != null ? <><strong>{qualityScores[scoreKey(video)]}</strong><span>/10</span></> : <span className="score-empty">{video.status === "completed" ? "···" : "—"}</span>}
                </div>
                <time className="library-date" dateTime={video.created_at}>
                  {new Date(video.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                </time>
                <button className="library-action" onClick={(event) => video.status === "failed" ? retry(event, video) : (event.stopPropagation(), onOpen(video.id))} disabled={retryingId === video.id}>
                  {retryingId === video.id ? "Starting…" : video.status === "failed" ? "Re-run analysis" : "View report"}
                  <span aria-hidden="true">{video.status === "failed" ? "↻" : "↗"}</span>
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ReportView({ id, onBack }: { id: string; onBack: () => void }) {
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunSubmitting, setRerunSubmitting] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);

  const load = useCallback(() => api.get(id).then(setVideo).catch((e) => setError(
    e instanceof TypeError ? "Can't reach the backend. Check that it is running on port 8000." : e.message,
  )), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!video || !active(video.status)) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [video, load]);

  const seek = (ts: string) => {
    const [m, s] = ts.split(":").map(Number);
    if (player.current && !Number.isNaN(m + s)) player.current.currentTime = m * 60 + s;
  };

  const rerunAnalysis = async () => {
    setRerunSubmitting(true);
    setRerunError(null);
    try {
      await api.reanalyze(id);
      setVideo((current) => current ? { ...current, status: "queued", error: null } : current);
      await load();
    } catch (e) {
      setRerunError((e as Error).message || "Could not start the analysis. Please try again.");
    } finally {
      setRerunSubmitting(false);
    }
  };

  if (error) return <><button className="link" onClick={onBack}>← All videos</button><p className="error">{error}</p></>;
  if (!video) return <p className="muted">Loading…</p>;
  const r = video.report;
  const rerunInProgress = active(video.status) && Boolean(video.report);
  const firstHookIndex = r?.highlights.findIndex((highlight) => highlight.kind === "hook") ?? -1;
  const marketingNiches = r?.insights.marketing_niches ?? [];

  return (
    <article>
      <button className="link" onClick={onBack}>← All videos</button>
      <header className="report-head">
        <div><h1>{displayVideoName(video.filename)}</h1></div>
        <div className="actions">
          <button className={rerunInProgress || rerunSubmitting ? "reanalyzing" : ""} onClick={rerunAnalysis} disabled={active(video.status) || rerunSubmitting} aria-busy={rerunInProgress || rerunSubmitting}>
            {rerunSubmitting ? "Starting rerun…" : rerunInProgress ? "Re-running…" : "Re-run analysis"}
          </button>
          <button className="danger" onClick={() => confirm("Delete this video and its report?") && api.remove(id).then(onBack)}>Delete</button>
        </div>
      </header>
      {rerunError && <p className="error rerun-error" role="alert">Could not rerun analysis: {rerunError}</p>}

      {r && (
        <section className="score score-top" aria-label="Overall video quality score">
          <div className="score-summary">
            <div className="score-num"><span>{r.overall_quality_score}</span><small>/10</small></div>
            <strong>{qualityVerdict(r.overall_quality_score)}</strong>
          </div>
          <div className="score-copy">
            <h2>Overall assessment</h2>
            <p>{r.overall_quality_explanation}</p>
          </div>
        </section>
      )}

      {active(video.status) && (
        <div className="progress" role="status">
          <div className="spinner" />
          <div><b>{rerunInProgress ? "Re-running analysis…" : video.status === "queued" ? "Waiting to start…" : "Analyzing your video…"}</b>
            <p className="muted">{rerunInProgress ? "A fresh report is being generated. Your previous report remains available until it’s ready." : "This usually takes under a minute. You can leave this page and come back from the list."}</p>
            <div className="activity-bar" role="progressbar" aria-label={rerunInProgress ? "Analysis rerun progress" : "Video analysis progress"} aria-valuetext="Analysis in progress; percentage unavailable">
              <span />
            </div>
          </div>
        </div>
      )}
      {video.status === "failed" && (
        <div className="callout error" role="alert"><b>Analysis failed.</b> {displayFailureMessage(video.error)} Try re-running the analysis.</div>
      )}

      {r && (
        <div className="report-layout">
          <div className="report-media">
            <video ref={player} src={api.fileUrl(id)} controls preload="metadata" />
            <section className="highlights">
              <h2>Highlights</h2>
              {r.highlights.length === 0 ? <p className="muted">No highlights detected.</p> : (
                <ul className="timeline">
                  {r.highlights.map((h, i) => (
                    <li key={i}>
                      <button className="time" onClick={() => seek(h.timestamp)}>{h.timestamp}</button>
                      <div>
                        <b>{i === firstHookIndex ? "Hook" : h.label || (h.kind === "key_message" && h.quote ? `“${h.quote}”` : "Key Point")}</b>
                        {h.description !== h.label && !(h.kind === "key_message" && h.quote === h.description) && <p>{h.description}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <details className="transcript-panel">
            <summary>Full transcript</summary>
            <p className="transcript">{r.audio.transcript}</p>
          </details>

          <div className="report-sections">
            <section className="report-section summary-section"><h2>Summary</h2><p>{r.summary}</p></section>

            <div className="media-cards">
              <section className="report-section">
                <h2>Audio</h2>
                <Rating label="Clarity" value={r.audio.clarity_rating} />
                <p><b>Background noise.</b> {r.audio.background_noise}</p>
                <p><b>Music.</b> {r.audio.music_description}</p>
                <h3>Key points</h3><List items={r.audio.key_points} />
              </section>

              <section className="report-section">
                <h2>Visual</h2>
                <p>{r.visual.description}</p>
                {typeof r.visual.editing_rating === "number"
                  ? <Rating label="Editing" value={r.visual.editing_rating} />
                  : <p className="muted"><b>Editing.</b> Not scored in this report.</p>}
                {typeof r.visual.image_quality_rating === "number"
                  ? <Rating label="Image quality" value={r.visual.image_quality_rating} />
                  : <p className="muted"><b>Image quality.</b> Not scored in this report.</p>}
                {(r.visual.image_quality_assessment || r.visual.resolution_assessment) && (
                  <p><b>Image quality assessment.</b> {r.visual.image_quality_assessment || r.visual.resolution_assessment}</p>
                )}
              </section>
            </div>

            <section className="report-section insights-section">
              <h2>Marketing Insights</h2>
              <div className="insight-facts">
                <p><b>Tone</b><span>{r.insights.tone}</span></p>
                <p><b>Target audience</b><span>{r.insights.target_audience}</span></p>
                <div className="hook-rating"><Rating label="Hook strength" value={r.insights.hook_strength} /></div>
              </div>
              <div className="marketing-niches">
                <h3>Best-fit marketing niches</h3>
                {marketingNiches.length ? (
                  <ul className="niche-cards">
                    {marketingNiches.map((item, i) => (
                      <li key={`${item.niche}-${i}`}>
                        <b>{item.niche}</b>
                        <span>{item.audience_fit}</span>
                        <p><strong>Integration idea.</strong> {item.integration_idea}</p>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted">No niche recommendations in this report. Re-run the analysis to generate them.</p>}
              </div>
              <div className="insight-lists">
                <div>
                  <h3>Brand mentions</h3>
                  {r.insights.brand_mentions.length ? (
                    <ul className="brand-tags">{r.insights.brand_mentions.map((brand, i) => <li key={i}>{brand}</li>)}</ul>
                  ) : <p className="muted">None found.</p>}
                </div>
                <div>
                  <h3>Suggestions</h3>
                  {r.insights.suggestions.length ? (
                    <ul className="suggestions">{r.insights.suggestions.map((suggestion, i) => <li key={i}>{suggestion}</li>)}</ul>
                  ) : <p className="muted">None found.</p>}
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </article>
  );
}


export default function App() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [serviceHealth, setServiceHealth] = useState<ServiceHealth | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [batchId, setBatchId] = useState(() => window.localStorage.getItem("video-insights-batch-id") || "");
  const [batchCancelError, setBatchCancelError] = useState<string | null>(null);
  const [cancelingBatch, setCancelingBatch] = useState(false);
  const [batchRerunError, setBatchRerunError] = useState<string | null>(null);
  const [rerunningBatch, setRerunningBatch] = useState(false);
  const rerunGroupRef = useRef<string | null>(batchId.startsWith("rerun-") ? batchId : null);
  const pendingReruns = useRef(0);
  const cancelUploadRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(() => api.list().then((v) => { setVideos(v); setListError(null); })
    .catch(() => setListError("Can't reach the server. Check that the backend is running on port 8000.")), []);
  const checkHealth = useCallback(async () => {
    try {
      setServiceHealth(await api.health());
      setHealthError(false);
    } catch {
      setServiceHealth(null);
      setHealthError(true);
    }
  }, []);
  const startBatch = useCallback((id: string) => {
    window.localStorage.setItem("video-insights-batch-id", id);
    setBatchId(id);
  }, []);
  const rerunFromLibrary = useCallback(async (id: string) => {
    const previousGroup = rerunGroupRef.current;
    const reuseGroup = previousGroup && (pendingReruns.current > 0 || (batchId === previousGroup && videos.some((video) => video.batch_id === previousGroup && active(video.status))));
    const group = reuseGroup ? previousGroup : `rerun-${crypto.randomUUID()}`;
    rerunGroupRef.current = group;
    pendingReruns.current += 1;
    try {
      const result = await api.reanalyze(id, group);
      startBatch(result.batch_id);
      await refresh();
    } finally {
      pendingReruns.current -= 1;
    }
  }, [batchId, videos, startBatch, refresh]);
  const rerunFailedBatch = useCallback(async () => {
    if (!batchId) return;
    setRerunningBatch(true);
    setBatchRerunError(null);
    try {
      const result = await api.reanalyzeFailedBatch(batchId);
      rerunGroupRef.current = result.batch_id;
      startBatch(result.batch_id);
      await refresh();
    } catch (error) {
      setBatchRerunError((error as Error).message || "Could not restart the failed evaluations.");
    } finally {
      setRerunningBatch(false);
    }
  }, [batchId, startBatch, refresh]);
  const refreshAfterUpload = useCallback(() => { void refresh(); }, [refresh]);

  useEffect(() => { if (!openId) refresh(); }, [openId, refresh]);
  useEffect(() => {
    void checkHealth();
    const timer = setInterval(() => { void checkHealth(); }, 10000);
    return () => clearInterval(timer);
  }, [checkHealth]);
  useEffect(() => {
    if (openId || !videos.some((v) => active(v.status))) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [openId, videos, refresh]);

  const currentBatch = videos.filter((video) => batchId ? video.batch_id === batchId : !video.batch_id && active(video.status));
  const batchIsActive = currentBatch.some((video) => active(video.status));
  const closeBatchProgress = useCallback(async () => {
    setBatchCancelError(null);
    setBatchRerunError(null);
    if (batchIsActive) {
      if (!batchId || !window.confirm("Cancel this batch and permanently delete all of its uploaded videos?")) return;
      setCancelingBatch(true);
      cancelUploadRef.current?.();
      try {
        await api.cancelBatch(batchId);
        await refresh();
      } catch (error) {
        setBatchCancelError((error as Error).message || "Could not cancel this batch. Please try again.");
        return;
      } finally {
        setCancelingBatch(false);
      }
    }
    window.localStorage.removeItem("video-insights-batch-id");
    setBatchId("");
    rerunGroupRef.current = null;
  }, [batchId, batchIsActive, refresh]);
  const backendUnavailable = healthError || Boolean(listError);
  const workspaceStatus = backendUnavailable
    ? "Server unavailable"
    : !serviceHealth
      ? "Checking connection"
      : serviceHealth.gemini_connected
        ? "Gemini connected"
        : "Gemini connection failure";
  const workspaceStatusClass = backendUnavailable || (serviceHealth !== null && !serviceHealth.gemini_connected)
    ? "status-error"
    : !serviceHealth
      ? "status-busy"
      : "";

  return (
    <>
      <nav className="top">
        <div className="top-inner">
          <button className="brand" onClick={() => setOpenId(null)}>
            <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 7.5v9l7-4.5z" /></svg></span>
            Video Insights
          </button>
          <span className="profile-chip" aria-label="Video Insights workspace">VI</span>
        </div>
      </nav>
      <main className="workspace-main">
        {openId ? <ReportView id={openId} onBack={() => setOpenId(null)} /> : (
          <>
            <div className="workspace-topline">
              <span>Video workspace</span><span className="topline-dot" aria-hidden="true">·</span>
              <span className={`workspace-ready ${workspaceStatusClass}`} role="status"><i />{workspaceStatus}</span>
            </div>
            <Upload onBatchStarted={startBatch} onUploaded={refreshAfterUpload} cancelUploadRef={cancelUploadRef} />
            <QueueProgress videos={videos} batchId={batchId} batchIsActive={batchIsActive} canceling={cancelingBatch} rerunning={rerunningBatch} onClose={closeBatchProgress} onOpen={setOpenId} onRerunFailed={rerunFailedBatch} />
            {batchCancelError && <p className="error queue-cancel-error" role="alert">{batchCancelError}</p>}
            {batchRerunError && <p className="error queue-cancel-error" role="alert">{batchRerunError}</p>}
            {listError ? <p className="error">{listError}</p> : <History videos={videos} onOpen={setOpenId} onRerun={rerunFromLibrary} />}
          </>
        )}
      </main>
    </>
  );
}
