#!/usr/bin/env python3
"""Whisper 强制对齐桥接脚本 — 给 Node 后端调.

用法:
    py -3.12 whisper_transcribe.py <audio_path> [--language zh] [--model small]
                                   [--device auto|cpu|cuda] [--compute-type auto|int8|float16]

stdout 输出 JSON:
    {
        "ok": true,
        "method": "python_faster_whisper",
        "language": "zh",
        "model": "small",
        "device": "cuda",
        "duration": 4.18,
        "segments": [
            {"start": 0.0, "end": 0.8, "text": "完美"},
            {"start": 0.9, "end": 1.4, "text": "今天"},
            ...
        ]
    }

失败时退出码非 0, stderr 写人话错误, stdout 空.
依赖: faster-whisper (>=1.0). 已在用户 OpenClaw workspace Python 3.12 装好.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    """写 stderr — 用 buffer.write 绕过 Windows Python 默认 GBK encoding."""
    sys.stderr.buffer.write((msg + "\n").encode("utf-8"))
    sys.stderr.buffer.flush()


def _stdout_utf8(text: str) -> None:
    """写 stdout — 用 buffer.write 强制 UTF-8 字节 (Windows redirect 到 pipe 时 sys.stdout 是 GBK)."""
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


def main() -> int:
    ap = argparse.ArgumentParser(description="Force-align audio to subtitles with faster-whisper.")
    ap.add_argument("audio", help="Audio file path (mp3/wav/m4a).")
    ap.add_argument("--language", default="zh", help="Language code (default zh; 'auto' for auto-detect).")
    ap.add_argument("--model", default="small", help="Whisper model size (tiny/base/small/medium/large-v3).")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"], help="Compute device.")
    ap.add_argument("--compute-type", default="auto", help="Compute type (int8/float16/auto).")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--no-vad", action="store_true", help="Disable VAD filter (default on).")
    ap.add_argument(
        "--initial-prompt",
        default=None,
        help="Optional initial prompt for biased decoding (= shot 台词 text).",
    )
    args = ap.parse_args()

    audio_path = Path(args.audio).expanduser().resolve()
    if not audio_path.exists():
        _eprint(f"audio file not found: {audio_path}")
        return 2

    try:
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
    except ImportError as err:
        _eprint(f"faster-whisper not installed: {err}")
        return 3

    # 2026-05-25 — 减少 HF Hub 警告刷屏 (Windows symlink unsupported, 不影响功能)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    except Exception as err:  # pylint: disable=broad-except
        _eprint(f"model load failed: {err}")
        return 4

    try:
        segments_gen, info = model.transcribe(
            str(audio_path),
            language=None if args.language == "auto" else args.language,
            beam_size=args.beam_size,
            vad_filter=not args.no_vad,
            initial_prompt=args.initial_prompt,
            # word_timestamps=True,  # 词级时间戳, 暂时不开 (segment 级够用)
        )

        out_segments = []
        for seg in segments_gen:
            out_segments.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": (seg.text or "").strip(),
                }
            )
    except Exception as err:  # pylint: disable=broad-except
        _eprint(f"transcribe failed: {err}")
        return 5

    if not out_segments:
        _eprint("transcribe returned 0 segments")
        return 6

    result = {
        "ok": True,
        "method": "python_faster_whisper",
        "language": info.language if hasattr(info, "language") else args.language,
        "model": args.model,
        "device": args.device,
        "duration": float(info.duration) if hasattr(info, "duration") else out_segments[-1]["end"],
        "segments": out_segments,
    }
    _stdout_utf8(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
