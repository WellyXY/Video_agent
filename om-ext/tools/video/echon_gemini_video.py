"""Text-to-video via the Echon gateway (Gemini / Veo models).

Async: create a task, poll until a video_url appears, download it.
Configure with ECHON_GATEWAY_URL + ECHON_GATEWAY_TOKEN (see OpenMontage/.env).
Note: the gateway requires duration in {4, 6, 8} seconds.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
)

_ALLOWED_DURATIONS = (4, 6, 8)


class EchonGeminiVideo(BaseTool):
    name = "echon_gemini_video"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "video_generation"
    provider = "echon_gemini"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC  # blocks internally, polling until ready
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []  # checked dynamically via env vars
    install_instructions = (
        "Set ECHON_GATEWAY_URL and ECHON_GATEWAY_TOKEN in OpenMontage/.env "
        "(the Echon third-party gateway)."
    )
    agent_skills = []

    capabilities = ["generate_video", "text_to_video"]
    supports = {"image_to_video": False, "custom_duration": True}
    best_for = [
        "short cinematic shots via Gemini/Veo when no other video key is present",
    ]
    not_good_for = ["durations other than 4/6/8s", "precise seed control"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "duration": {"type": "integer", "enum": list(_ALLOWED_DURATIONS), "default": 6},
            "aspect_ratio": {"type": "string", "default": "16:9"},
            "resolution": {"type": "string", "default": "720p"},
            "model": {"type": "string"},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=300, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "duration", "aspect_ratio", "model"]
    side_effects = ["writes video file to output_path", "calls Echon gateway"]
    user_visible_verification = ["Play the generated clip and check motion/quality"]

    # poll config
    poll_interval_s = 6
    poll_timeout_s = 600

    def _base(self) -> str | None:
        b = os.environ.get("ECHON_GATEWAY_URL")
        return b.rstrip("/") if b else None

    def _token(self) -> str | None:
        return os.environ.get("ECHON_GATEWAY_TOKEN")

    def get_status(self) -> ToolStatus:
        if self._base() and self._token():
            return ToolStatus.AVAILABLE
        return ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.30  # nominal per-clip estimate (gateway-billed)

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        base, token = self._base(), self._token()
        if not (base and token):
            return ToolResult(success=False, error="Echon gateway not configured. " + self.install_instructions)

        import requests

        start = time.time()
        duration = int(inputs.get("duration", 6))
        if duration not in _ALLOWED_DURATIONS:
            duration = min(_ALLOWED_DURATIONS, key=lambda d: abs(d - duration))

        payload: dict[str, Any] = {
            "prompt": inputs["prompt"],
            "duration": duration,
            "aspect_ratio": inputs.get("aspect_ratio", "16:9"),
        }
        if inputs.get("resolution"):
            payload["resolution"] = inputs["resolution"]
        if inputs.get("model"):
            payload["model"] = inputs["model"]

        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        try:
            cr = requests.post(f"{base}/gemini/video/tasks", headers=headers, json=payload, timeout=60)
            if cr.status_code >= 400:
                return ToolResult(success=False, error=f"Video create failed {cr.status_code}: {cr.text[:200]}")
            created = cr.json()
            task_id = created.get("id") or created.get("task_id") or (created.get("data") or {}).get("id")
            if not task_id:
                return ToolResult(success=False, error=f"No task id in create response: {str(created)[:200]}")

            # poll
            video_url = None
            deadline = time.time() + self.poll_timeout_s
            last_status = None
            while time.time() < deadline:
                time.sleep(self.poll_interval_s)
                pr = requests.get(f"{base}/gemini/video/tasks/{task_id}", headers=headers, timeout=30)
                if pr.status_code >= 400:
                    continue
                st = pr.json()
                last_status = st.get("status")
                video_url = st.get("video_url") or (st.get("output") or {}).get("video_url")
                if video_url:
                    break
                if str(last_status).lower() in ("failed", "error", "canceled", "cancelled"):
                    return ToolResult(success=False, error=f"Video task {last_status}: {st.get('fail_reason') or st.get('error') or ''}")

            if not video_url:
                return ToolResult(success=False, error=f"Video not ready within {self.poll_timeout_s}s (last status: {last_status})")

            # download
            out = Path(inputs.get("output_path") or "generated_video.mp4")
            if out.suffix == "":
                out = out.with_suffix(".mp4")
            out.parent.mkdir(parents=True, exist_ok=True)
            dl = requests.get(video_url, timeout=180)
            dl.raise_for_status()
            out.write_bytes(dl.content)

        except Exception as e:
            return ToolResult(success=False, error=f"Echon gemini video failed: {e}")

        return ToolResult(
            success=True,
            data={
                "provider": "echon_gemini",
                "prompt": inputs["prompt"],
                "duration": duration,
                "output": str(out),
                "video_url": video_url,
            },
            artifacts=[str(out)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
        )
