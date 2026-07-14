"""Image generation via the Echon gateway unified /aigc API.

Async: POST /aigc/image/generate → poll /tasks/{id} → download result.cdn_url.
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


class EchonImage(BaseTool):
    name = "echon_image"
    version = "0.2.0"
    tier = ToolTier.GENERATE
    capability = "image_generation"
    provider = "echon"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC  # blocks internally, polling until ready
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []
    install_instructions = "Set ECHON_GATEWAY_URL and ECHON_GATEWAY_TOKEN in OpenMontage/.env."
    agent_skills = []

    capabilities = ["generate_image", "text_to_image", "generate_illustration"]
    supports = {"reference_images": True, "aspect_ratio": True, "crop_aspect_ratio": True, "seed": False, "custom_size": False}
    best_for = ["product and brand imagery", "reference-guided image generation via the Echon gateway"]
    not_good_for = ["exact pixel-size control", "seeded reproducibility"]

    # Control the shape with aspect_ratio (primary). If the model's output ratio is
    # unreliable, ALSO pass crop_aspect_ratio (usually the same value) to center-crop
    # the result to an exact ratio.
    ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "model": {"type": "string", "default": "gpt-image-2"},
            "aspect_ratio": {
                "type": "string",
                "enum": ASPECT_RATIOS,
                "default": "1:1",
                "description": "Primary shape control. Use 9:16 for vertical/social, 16:9 for wide, 1:1 for square.",
            },
            "crop_aspect_ratio": {
                "type": "string",
                "enum": ASPECT_RATIOS,
                "description": "Optional. Center-crop the output to this exact ratio — only set it (usually == aspect_ratio) if the model's raw ratio is unreliable.",
            },
            "resolution": {"type": "string", "default": "720p"},
            "reference_images": {"type": "array", "items": {"type": "string"}, "default": []},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=100, network_required=True)
    retry_policy = RetryPolicy(max_retries=2, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "model", "aspect_ratio"]
    side_effects = ["writes image file to output_path", "calls Echon gateway"]
    user_visible_verification = ["Inspect generated image for relevance and quality"]

    poll_interval_s = 5
    poll_timeout_s = 300

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if echon.available() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.04

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not echon.available():
            return ToolResult(success=False, error="Echon gateway not configured. " + self.install_instructions)
        start = time.time()
        payload: dict[str, Any] = {
            "prompt": inputs["prompt"],
            "model": inputs.get("model", "gpt-image-2"),
            "aspect_ratio": inputs.get("aspect_ratio", "1:1"),
            "resolution": inputs.get("resolution", "720p"),
        }
        if inputs.get("crop_aspect_ratio"):
            payload["crop_aspect_ratio"] = inputs["crop_aspect_ratio"]
        refs = inputs.get("reference_images")
        if refs:
            payload["reference_images"] = refs
        try:
            tid = echon.submit("/aigc/image/generate", payload)
            url = echon.poll(tid, echon.extract_image_url, self.poll_interval_s, self.poll_timeout_s)
            ext = ".png" if ".png" in url.lower() else (".jpg" if (".jpg" in url.lower() or ".jpeg" in url.lower()) else ".png")
            out = Path(inputs.get("output_path") or f"generated_image{ext}")
            if out.suffix == "":
                out = out.with_suffix(ext)
            echon.download(url, str(out))
            echon.write_meta(str(out), {
                "type": "image", "provider": "echon", "model": payload["model"], "method": "text_to_image",
                "prompt": inputs["prompt"], "aspect_ratio": payload["aspect_ratio"],
                "crop_aspect_ratio": payload.get("crop_aspect_ratio"), "resolution": payload["resolution"],
                "reference_images": refs or [], "source_url": url,
            })
        except Exception as e:
            return ToolResult(success=False, error=f"Echon image failed: {e}")

        return ToolResult(
            success=True,
            data={"provider": "echon", "model": payload["model"], "prompt": inputs["prompt"], "output": str(out), "source_url": url},
            artifacts=[str(out)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
            model=payload["model"],
        )
