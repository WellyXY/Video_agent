"""Voiceover / TTS via the Echon gateway unified /aigc API.

Async: POST /aigc/audio/voiceover → poll /tasks/{id} → download the audio URL.
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


class EchonVoiceover(BaseTool):
    name = "echon_voiceover"
    version = "0.1.0"
    tier = ToolTier.VOICE
    capability = "tts"
    provider = "echon"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []
    install_instructions = "Set ECHON_GATEWAY_URL and ECHON_GATEWAY_TOKEN in OpenMontage/.env."
    agent_skills = []

    capabilities = ["text_to_speech", "voiceover", "narration"]
    supports = {"voice_hint": True, "style_hints": True}
    best_for = ["narration and voiceover for videos"]
    not_good_for = ["exact voice cloning of a specific person"]

    input_schema = {
        "type": "object",
        "required": ["text"],
        "properties": {
            "text": {"type": "string"},
            "voice_hint": {"type": "string", "default": ""},
            "style_hints": {"type": "string", "default": ""},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=50, network_required=True)
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["text", "voice_hint", "style_hints"]
    side_effects = ["writes audio file to output_path", "calls Echon gateway"]
    user_visible_verification = ["Listen to the generated voiceover"]

    poll_interval_s = 4
    poll_timeout_s = 300

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if echon.available() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.02

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not echon.available():
            return ToolResult(success=False, error="Echon gateway not configured. " + self.install_instructions)
        start = time.time()
        payload: dict[str, Any] = {"text": inputs["text"]}
        if inputs.get("voice_hint"):
            payload["voice_hint"] = inputs["voice_hint"]
        if inputs.get("style_hints"):
            payload["style_hints"] = inputs["style_hints"]
        try:
            tid = echon.submit("/aigc/audio/voiceover", payload)
            url = echon.poll(tid, echon.extract_audio_url, self.poll_interval_s, self.poll_timeout_s)
            ext = ".mp3" if ".mp3" in url.lower() else (".wav" if ".wav" in url.lower() else ".mp3")
            out = Path(inputs.get("output_path") or f"voiceover{ext}")
            if out.suffix == "":
                out = out.with_suffix(ext)
            echon.download(url, str(out))
        except Exception as e:
            return ToolResult(success=False, error=f"Echon voiceover failed: {e}")

        return ToolResult(
            success=True,
            data={"provider": "echon", "text": inputs["text"], "output": str(out), "audio_url": url},
            artifacts=[str(out)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
        )
