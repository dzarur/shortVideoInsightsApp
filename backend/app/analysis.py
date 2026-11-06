"""Gemini video analysis: schemas + a single analyze_video() entry point."""
import os
import time
from pathlib import Path

from google import genai
from google.genai import errors, types
from pydantic import BaseModel, Field, ValidationError

MAX_BYTES = 100 * 1024 * 1024
PROCESSING_TIMEOUT = 600
POLL_SECONDS = 5

PROMPT = """Evaluate this short marketing/creator video using both its audio and visual content.
Be concise and evidence-based. Transcribe speech where possible, separate what is clearly
audible/visible from inference, and never invent brand mentions. Rate audio clarity, video editing,
image quality and hook strength 1-5; overall suitability 1-10. Score editing based on pacing,
continuity and transitions. Score image quality based on visible sharpness, exposure, focus and
compression; do not infer exact resolution. Highlights are the key moments
with timestamps as MM:SS. Give every highlight a concise label: use the exact short quote for a
key_message, or the most specific named subject/key point otherwise (for example, "The Pixar lamp").
Use "Key Point" only when no specific label is evident. Keep context in the description. For a
key_message include its exact words in quote; otherwise set quote to null. If something cannot be
assessed, say so in its text field and use an empty list where appropriate.

For marketing insights, identify 3-5 ranked product or service niches that could be advertised
alongside this video for its target audience. Recommend categories, not specific companies. Base
each recommendation on the audience and the video's subject, tone, and context; explain the
audience fit and give a brief, natural integration idea. Keep the suggestions relevant and
evidence-based, and do not imply that any brand is featured or endorsed unless clearly present."""


class AnalysisError(Exception):
    """Failure with a user-facing message."""


def _invalid_gemini_key(error: errors.ClientError) -> bool:
    return error.code == 400 and ("API_KEY_INVALID" in str(error) or "API key not valid" in str(error))


class AudioAnalysis(BaseModel):
    transcript: str = Field(description="Verbatim speech when clear; otherwise say unavailable.")
    key_points: list[str]
    clarity_rating: int = Field(ge=1, le=5)
    background_noise: str
    music_description: str = Field(description="Music or sound bed, or 'None'.")


class VisualAnalysis(BaseModel):
    description: str
    editing_rating: int = Field(ge=1, le=5, description="Editing quality based on pacing, continuity, and transitions.")
    image_quality_rating: int = Field(ge=1, le=5, description="Visible image quality based on sharpness, exposure, focus, and compression.")
    image_quality_assessment: str = Field(description="Brief evidence-based image quality assessment; do not guess exact dimensions.")


class Highlight(BaseModel):
    timestamp: str = Field(description="MM:SS")
    kind: str = Field(description="One of: hook, product, key_message, issue, call_to_action")
    label: str = Field(description="Concise headline, such as an exact quote or the specific subject being highlighted.")
    description: str
    quote: str | None = Field(default=None, description="Exact spoken words for a key_message highlight; otherwise null.")


class MarketingNiche(BaseModel):
    niche: str = Field(description="A concise product or service category, not a specific company.")
    audience_fit: str = Field(description="Why this category is relevant to the video's target audience.")
    integration_idea: str = Field(description="A brief, natural way to advertise this category alongside the video.")


class Insights(BaseModel):
    tone: str
    target_audience: str
    hook_strength: int = Field(ge=1, le=5)
    brand_mentions: list[str]
    suggestions: list[str] = Field(description="Actionable improvements for a marketer or creator.")
    marketing_niches: list[MarketingNiche] = Field(
        description="Three to five ranked product or service categories that fit this video's target audience, with audience rationale and a natural integration idea."
    )


class VideoAnalysis(BaseModel):
    summary: str
    audio: AudioAnalysis
    visual: VisualAnalysis
    highlights: list[Highlight]
    overall_quality_score: int = Field(ge=1, le=10)
    overall_quality_explanation: str
    insights: Insights


def _wait_active(client: genai.Client, f):
    deadline = time.monotonic() + PROCESSING_TIMEOUT
    while True:
        state = getattr(getattr(f, "state", None), "name", str(getattr(f, "state", ""))).upper()
        if state == "ACTIVE":
            return f
        if state == "FAILED":
            raise AnalysisError("The AI service could not process this video. Try re-encoding it as MP4.")
        if time.monotonic() > deadline:
            raise AnalysisError("The AI service took too long to process this video.")
        time.sleep(POLL_SECONDS)
        f = client.files.get(name=f.name)


def analyze_video(path: Path, mime_type: str, model: str | None = None) -> VideoAnalysis:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise AnalysisError("Gemini API key is not configured in the backend. Set GEMINI_API_KEY in backend/.env and restart the server.")
    model = model or os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
    client = genai.Client(api_key=api_key)
    uploaded = None
    try:
        uploaded = client.files.upload(file=str(path), config={"mime_type": mime_type})
        uploaded = _wait_active(client, uploaded)
        last_error: Exception | None = None
        for attempt in range(2):  # one retry for transient errors / invalid JSON
            try:
                resp = client.models.generate_content(
                    model=model,
                    contents=[uploaded, PROMPT],
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=VideoAnalysis,
                        temperature=0.2,
                    ),
                )
                return VideoAnalysis.model_validate_json(resp.text)
            except (ValidationError, ValueError) as e:
                last_error = AnalysisError("The AI returned an unreadable report. Please re-run the analysis.")
            except errors.ClientError as e:
                if _invalid_gemini_key(e):
                    raise
                last_error = AnalysisError(f"The AI service request failed: {e}")
            except Exception as e:  # network / quota / API errors
                last_error = AnalysisError(f"The AI service request failed: {e}")
            time.sleep(2 * (attempt + 1))
        raise last_error  # type: ignore[misc]
    except errors.ClientError as e:
        if _invalid_gemini_key(e):
            raise AnalysisError("Gemini rejected the API key. Replace GEMINI_API_KEY in backend/.env with a valid key and restart the backend.") from e
        raise AnalysisError(f"The AI service request failed: {e}") from e
    finally:
        if uploaded is not None and getattr(uploaded, "name", None):
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass
