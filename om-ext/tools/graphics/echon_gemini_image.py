"""Image generation via the Echon gateway (Gemini image models).

Gateway returns images as base64 data URLs; this tool decodes and saves them.
Configure with ECHON_GATEWAY_URL + ECHON_GATEWAY_TOKEN (see OpenMontage/.env).
"""

from __future__ import annotations

import base64
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


class EchonGeminiImage(BaseTool):
    name = "echon_gemini_image"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "image_generation"
    provider = "echon_gemini"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []  # checked dynamically via env vars
    install_instructions = (
        "Set ECHON_GATEWAY_URL and ECHON_GATEWAY_TOKEN in OpenMontage/.env "
        "(the Echon third-party gateway)."
    )
    agent_skills = []

    capabilities = ["generate_image", "text_to_image", "generate_illustration"]
    supports = {"negative_prompt": False, "seed": False, "custom_size": False}
    best_for = [
        "product and brand imagery via Gemini image models",
        "general text-to-image when no fal.ai key is present",
    ]
    not_good_for = ["exact size control", "seeded reproducibility"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "model": {"type": "string"},  # optional gateway model id
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=100, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=2, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "model"]
    side_effects = ["writes image file to output_path", "calls Echon gateway"]
    user_visible_verification = ["Inspect generated image for relevance and quality"]

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
        return 0.04  # nominal per-image estimate (gateway-billed)

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        base, token = self._base(), self._token()
        if not (base and token):
            return ToolResult(success=False, error="Echon gateway not configured. " + self.install_instructions)

        import requests

        start = time.time()
        payload: dict[str, Any] = {"prompt": inputs["prompt"]}
        if inputs.get("model"):
            payload["model"] = inputs["model"]

        try:
            r = requests.post(
                f"{base}/gemini/image",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json=payload,
                timeout=180,
            )
            r.raise_for_status()
            data = r.json()

            images = data.get("images") or []
            if not images:
                return ToolResult(success=False, error=f"Gateway returned no image (text-only?): {str(data)[:200]}")
            data_url = images[0].get("data_url") or images[0].get("url") or ""
            if not data_url.startswith("data:image"):
                return ToolResult(success=False, error=f"Unexpected image field: {data_url[:80]}")

            header, b64 = data_url.split(",", 1)
            ext = "jpg" if "jpeg" in header or "jpg" in header else ("png" if "png" in header else "img")
            out = Path(inputs.get("output_path") or f"generated_image.{ext}")
            if out.suffix == "":
                out = out.with_suffix(f".{ext}")
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(base64.b64decode(b64))

        except Exception as e:
            return ToolResult(success=False, error=f"Echon gemini image failed: {e}")

        return ToolResult(
            success=True,
            data={
                "provider": "echon_gemini",
                "model": data.get("model"),
                "prompt": inputs["prompt"],
                "output": str(out),
            },
            artifacts=[str(out)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
            model=data.get("model"),
        )
