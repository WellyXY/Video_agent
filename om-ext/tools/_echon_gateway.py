"""Shared client for the Echon gateway unified /aigc API.

All generators submit a task and poll GET /tasks/{id} until it succeeds.
Configure with ECHON_GATEWAY_URL + ECHON_GATEWAY_TOKEN (see OpenMontage/.env).
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable


def config() -> tuple[str | None, str | None]:
    base = os.environ.get("ECHON_GATEWAY_URL")
    return (base.rstrip("/") if base else None), os.environ.get("ECHON_GATEWAY_TOKEN")


def available() -> bool:
    base, token = config()
    return bool(base and token)


def _headers(token: str, json_body: bool = True) -> dict[str, str]:
    h = {"Authorization": f"Bearer {token}"}
    if json_body:
        h["Content-Type"] = "application/json"
    return h


def submit(path: str, payload: dict[str, Any], timeout: int = 60) -> str:
    """POST a generation request; return the task id."""
    import requests

    base, token = config()
    if not (base and token):
        raise RuntimeError("Echon gateway not configured (ECHON_GATEWAY_URL / ECHON_GATEWAY_TOKEN)")
    r = requests.post(f"{base}{path}", headers=_headers(token), json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"submit {path} failed {r.status_code}: {r.text[:200]}")
    d = r.json()
    tid = d.get("id") or d.get("task_id") or (d.get("data") or {}).get("id")
    if not tid:
        raise RuntimeError(f"no task id in response: {str(d)[:200]}")
    return tid


def poll(task_id: str, extract: Callable[[dict], Any], interval: float = 5.0, timeout: float = 600.0) -> Any:
    """Poll GET /tasks/{id} until `extract(task)` returns a truthy value; return it."""
    import requests

    base, token = config()
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        time.sleep(interval)
        try:
            r = requests.get(f"{base}/tasks/{task_id}", headers=_headers(token, json_body=False), timeout=30)
        except Exception:
            continue
        if r.status_code >= 400:
            continue
        d = r.json()
        last = d.get("status")
        val = extract(d)
        if val:
            return val
        if str(last).lower() in ("failed", "error", "canceled", "cancelled"):
            reason = d.get("fail_reason") or (d.get("result") or {}).get("error") or d.get("error") or ""
            raise RuntimeError(f"task {last}: {reason}")
    raise RuntimeError(f"task not ready within {int(timeout)}s (last status: {last})")


def download(url: str, out_path: str, timeout: int = 180) -> str:
    import requests

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    out.write_bytes(r.content)
    return str(out)


# ---- result extractors for each modality ----
def extract_image_url(task: dict) -> str | None:
    res = task.get("result") or {}
    return res.get("cdn_url") or (res.get("cdn_urls") or [None])[0]


def extract_video_url(task: dict) -> str | None:
    res = task.get("result") or {}
    return task.get("video_url") or res.get("video_url")


def extract_audio_url(task: dict) -> str | None:
    res = task.get("result") or {}
    clips = res.get("clips") or []
    if clips and isinstance(clips[0], dict) and clips[0].get("audio_url"):
        return clips[0]["audio_url"]
    return res.get("audio_url") or res.get("cdn_url") or task.get("audio_url")
