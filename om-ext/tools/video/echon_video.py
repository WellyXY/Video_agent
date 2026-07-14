"""Text/image-to-video via the Echon gateway unified /aigc API (Seedance).

Async: POST /aigc/video/generate → poll /tasks/{id} → download video_url.
Pass `first_frame` (an image URL) for image-to-video; omit it for text-to-video.
Configure with ECHON_GATEWAY_URL + ECHON_GATEWAY_TOKEN (see OpenMontage/.env).
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from tools import _echon_gateway as echon
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


class EchonVideo(BaseTool):
    name = "echon_video"
    version = "0.2.0"
    tier = ToolTier.GENERATE
    capability = "video_generation"
    provider = "echon"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC  # blocks internally, polling until ready
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []
    install_instructions = "Set ECHON_GATEWAY_URL and ECHON_GATEWAY_TOKEN in OpenMontage/.env."
    agent_skills = []

    capabilities = ["generate_video", "text_to_video", "image_to_video"]
    supports = {"image_to_video": True, "custom_duration": True}
    best_for = ["short cinematic shots (Seedance)", "animating a still image via first_frame"]
    not_good_for = ["long-form video", "precise seed control"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "model": {"type": "string", "default": "seedance-2.0-fast"},
            "aspect_ratio": {
                "type": "string",
                "enum": ["16:9", "9:16", "1:1", "4:3", "3:4"],
                "default": "16:9",
                "description": "Shape control. Use 9:16 for vertical/social, 16:9 for wide/landscape.",
            },
            "resolution": {"type": "string", "default": "720p"},
            "duration": {"type": "integer", "default": 5},
            "first_frame": {"type": "string", "description": "image URL for image-to-video"},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=300, network_required=True)
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "model", "duration", "aspect_ratio", "first_frame"]
    side_effects = ["writes video file to output_path", "calls Echon gateway"]
    user_visible_verification = ["Play the generated clip and check motion/quality"]

    poll_interval_s = 6
    poll_timeout_s = 600

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if echon.available() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.30

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not echon.available():
            return ToolResult(success=False, error="Echon gateway not configured. " + self.install_instructions)
        start = time.time()
        payload: dict[str, Any] = {
            "prompt": inputs["prompt"],
            "model": inputs.get("model", "seedance-2.0-fast"),
            "aspect_ratio": inputs.get("aspect_ratio", "16:9"),
            "resolution": inputs.get("resolution", "720p"),
            "duration": int(inputs.get("duration", 5)),
        }
        if inputs.get("first_frame"):
            payload["first_frame"] = inputs["first_frame"]
        try:
            tid = echon.submit("/aigc/video/generate", payload)
            url = echon.poll(tid, echon.extract_video_url, self.poll_interval_s, self.poll_timeout_s)
            out = Path(inputs.get("output_path") or "generated_video.mp4")
            if out.suffix == "":
                out = out.with_suffix(".mp4")
            echon.download(url, str(out))
            echon.write_meta(str(out), {
                "type": "video", "provider": "echon", "model": payload["model"],
                "method": "image_to_video" if payload.get("first_frame") else "text_to_video",
                "prompt": inputs["prompt"], "aspect_ratio": payload["aspect_ratio"],
                "duration": payload["duration"], "first_frame": payload.get("first_frame"), "source_url": url,
            })
        except Exception as e:
            return ToolResult(success=False, error=f"Echon video failed: {e}")

        return ToolResult(
            success=True,
            data={"provider": "echon", "model": payload["model"], "prompt": inputs["prompt"],
                  "mode": "i2v" if payload.get("first_frame") else "t2v", "output": str(out), "video_url": url},
            artifacts=[str(out)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
            model=payload["model"],
        )
