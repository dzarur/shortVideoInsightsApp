export type Status = "queued" | "processing" | "completed" | "failed";

export interface Highlight { timestamp: string; kind: string; label?: string | null; description: string; quote?: string | null }
export interface MarketingNiche { niche: string; audience_fit: string; integration_idea: string }
export interface Report {
  summary: string;
  audio: { transcript: string; key_points: string[]; clarity_rating: number; background_noise: string; music_description: string };
  visual: {
    description: string;
    editing_rating?: number;
    image_quality_rating?: number;
    image_quality_assessment?: string;
    lighting_rating?: number;
    framing_rating?: number;
    stability_rating?: number;
    resolution_assessment?: string;
  };
  highlights: Highlight[];
  overall_quality_score: number;
  overall_quality_explanation: string;
  insights: {
    tone: string;
    target_audience: string;
    hook_strength: number;
    brand_mentions: string[];
    suggestions: string[];
    marketing_niches?: MarketingNiche[];
  };
}
export interface Video {
  id: string; filename: string; size: number; status: Status;
  error: string | null; created_at: string; queued_at?: string | null; batch_id?: string | null; batch_size?: number | null; report?: Report | null;
}
export interface ServiceHealth { backend: "ok"; gemini_key_configured: boolean; gemini_connected: boolean }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${res.status}).`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  health: () => request<ServiceHealth>("/api/health"),
  list: () => request<Video[]>("/api/videos"),
  get: (id: string) => request<Video>(`/api/videos/${id}`),
  upload: (file: File, onProgress?: (percent: number) => void, batchId?: string, batchSize = 1, signal?: AbortSignal) => new Promise<{ id: string; batch_id?: string | null; batch_size?: number; replaced?: boolean }>((resolve, reject) => {
    const body = new FormData();
    body.append("file", file);
    if (batchId) body.append("batch_id", batchId);
    body.append("batch_size", String(batchSize));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos");
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) {
      reject(new Error("Upload was canceled."));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      cleanup();
      let payload: { id?: string; detail?: string; batch_id?: string | null; batch_size?: number; replaced?: boolean } = {};
      try { payload = JSON.parse(xhr.responseText) as { id?: string; detail?: string; batch_id?: string | null; batch_size?: number; replaced?: boolean }; }
      catch {}

      if (xhr.status >= 200 && xhr.status < 300 && payload.id) resolve({ id: payload.id, batch_id: payload.batch_id, batch_size: payload.batch_size, replaced: payload.replaced });
      else if (xhr.status >= 500) reject(new Error("We couldn't save this video right now. Please try again in a moment."));
      else reject(new Error(payload.detail ?? `Upload could not be completed (HTTP ${xhr.status || "network error"}).`));
    };
    xhr.onerror = () => { cleanup(); reject(new Error("Could not reach the server while uploading. Check the connection and try again.")); };
    xhr.onabort = () => { cleanup(); reject(new Error("Upload was canceled.")); };
    xhr.send(body);
  }),
  cancelBatch: (batchId: string) => request<{ batch_id: string; deleted: number }>(`/api/batches/${encodeURIComponent(batchId)}`, { method: "DELETE" }),
  reanalyze: (id: string, batchId?: string) => request<{ id: string; status: "queued"; batch_id: string }>(
    `/api/videos/${id}/reanalyze${batchId ? `?batch_id=${encodeURIComponent(batchId)}` : ""}`, { method: "POST" }),
  reanalyzeFailedBatch: (batchId: string) => request<{ batch_id: string; queued: number }>(
    `/api/batches/${encodeURIComponent(batchId)}/reanalyze`, { method: "POST" }),
  remove: (id: string) => request<void>(`/api/videos/${id}`, { method: "DELETE" }),
  fileUrl: (id: string) => `/api/videos/${id}/file`,
};
