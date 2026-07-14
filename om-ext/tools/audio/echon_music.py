"""Music generation via the Echon gateway unified /aigc API.

Async: POST /aigc/audio/music → poll /tasks/{id} → download result.clips[*].audio_url.
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


class EchonMusic(BaseTool):
    name = "echon_music"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "music_generation"
    provider = "echon"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []
    install_instructions = "Set ECHON_GATEWAY_URL and ECHON_GATEWAY_TOKEN in OpenMontage/.env."
    agent_skills = []

    capabilities = ["generate_music", "background_music", "instrumental"]
    supports = {"instrumental": True, "tags": True}
    best_for = ["background / ambient music beds", "brand and social video scoring"]
    not_good_for = ["exact-length cuts", "licensed commercial tracks"]

    input_schema = {
        "type": "object",
        "required": ["gpt_description_prompt"],
        "properties": {
            "gpt_description_prompt": {"type": "string"},
            "tags": {"type": "string", "default": ""},
            "make_instrumental": {"type": "boolean", "default": True},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=100, network_required=True)
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["gpt_description_prompt", "tags", "make_instrumental"]
    side_effects = ["writes audio file to output_path", "calls Echon gateway"]
    user_visible_verification = ["Listen to the generated music"]

    poll_interval_s = 6
    poll_timeout_s = 600

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if echon.available() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.05

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not echon.available():
            return ToolResult(success=False, error="Echon gateway not configured. " + self.install_instructions)
        start = time.time()
        payload: dict[str, Any] = {
            "gpt_description_prompt": inputs["gpt_description_prompt"],
            "tags": inputs.get("tags", ""),
            "make_instrumental": bool(inputs.get("make_instrumental", True)),
        }
        try:
            tid = echon.submit("/aigc/audio/music", payload)
            url = echon.poll(tid, echon.extract_audio_url, self.poll_interval_s, self.poll_timeout_s)
            ext = ".mp3" if ".mp3" in url.lower() else (".wav" if ".wav" in url.lower() else ".mp3")
            out = Path(inputs.get("output_path") or f"generated_music{ext}")
            if out.suffix == "":
                out = out.with_suffix(ext)
            echon.download(url, str(out))
        except Exception as e:
            return ToolResult(success=False, error=f"Echon music failed: {e}")

        return ToolResult(
            success=True,
            data={"provider": "echon", "prompt": inputs["gpt_description_prompt"], "output": str(out), "audio_url": url},
            artifacts=[str(out)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
        )
