"""Sound-effect generation via the Echon gateway unified /aigc API.

Async: POST /aigc/sfx/generate → poll /tasks/{id} → download the audio URL.
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


class EchonSfx(BaseTool):
    name = "echon_sfx"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "sound_effects"
    provider = "echon"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []
    install_instructions = "Set ECHON_GATEWAY_URL and ECHON_GATEWAY_TOKEN in OpenMontage/.env."
    agent_skills = []

    capabilities = ["generate_sfx", "sound_effect", "foley"]
    supports = {"duration": True}
    best_for = ["short sound effects and foley (shutter clicks, whooshes, pops)"]
    not_good_for = ["long ambient beds (use echon_music)"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "duration_s": {"type": "number", "default": 2},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(cpu_cores=1, ram_mb=256, vram_mb=0, disk_mb=30, network_required=True)
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "duration_s"]
    side_effects = ["synchronous: blocks until the file is ready then returns it — run in foreground, do NOT background or Monitor it", "writes audio file to output_path", "calls Echon gateway"]
    user_visible_verification = ["Listen to the generated sound effect"]

    poll_interval_s = 4
    poll_timeout_s = 300

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if echon.available() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.01

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not echon.available():
            return ToolResult(success=False, error="Echon gateway not configured. " + self.install_instructions)
        start = time.time()
        payload: dict[str, Any] = {"prompt": inputs["prompt"], "duration_s": inputs.get("duration_s", 2)}
        try:
            tid = echon.submit("/aigc/sfx/generate", payload)
            url = echon.poll(tid, echon.extract_audio_url, self.poll_interval_s, self.poll_timeout_s)
            ext = ".mp3" if ".mp3" in url.lower() else (".wav" if ".wav" in url.lower() else ".mp3")
            out = Path(inputs.get("output_path") or f"sfx{ext}")
            if out.suffix == "":
                out = out.with_suffix(ext)
            echon.download(url, str(out))
            echon.write_meta(str(out), {"type": "sfx", "provider": "echon", "method": "sfx_generation",
                "prompt": inputs["prompt"], "duration_s": payload.get("duration_s"), "source_url": url})
        except Exception as e:
            return ToolResult(success=False, error=f"Echon sfx failed: {e}")

        return ToolResult(
            success=True,
            data={"provider": "echon", "prompt": inputs["prompt"], "output": str(out), "audio_url": url},
            artifacts=[str(out)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
        )
