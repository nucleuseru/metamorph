#!/usr/bin/env python3
"""Optimize Seed-VC DiT and HiFT checkpoints for slim voice-only images.

Converts floating-point tensors in `DiT_uvit_tat_xlsr_ema.pth` and `hift.pt`
to float16 (or bfloat16) and strips non-inference keys from the DiT checkpoint,
cutting bundled voice checkpoint storage roughly in half.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path
from typing import Any


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache-dir",
        required=True,
        help="Directory containing Seed-VC checkpoints (DiT_uvit_tat_xlsr_ema.pth, hift.pt).",
    )
    parser.add_argument(
        "--dtype",
        choices=("float16", "bfloat16"),
        default="float16",
        help="Target floating-point storage dtype (default: float16).",
    )
    return parser.parse_args(argv)


def _convert_state_dict(obj: Any, target_dtype: Any) -> Any:
    """Recursively cast floating-point tensors to `target_dtype`."""
    if isinstance(obj, dict):
        return {k: _convert_state_dict(v, target_dtype) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_convert_state_dict(v, target_dtype) for v in obj]
    if isinstance(obj, tuple):
        return tuple(_convert_state_dict(v, target_dtype) for v in obj)
    if hasattr(obj, "is_floating_point") and obj.is_floating_point():
        return obj.to(dtype=target_dtype)
    return obj


def _torch_load(torch_mod: Any, path: Path) -> Any:
    try:
        return torch_mod.load(str(path), map_location="cpu", weights_only=False)
    except TypeError:
        return torch_mod.load(str(path), map_location="cpu")


def _atomic_torch_save(torch_mod: Any, obj: Any, path: Path) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    torch_mod.save(obj, str(tmp_path))
    tmp_path.replace(path)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    cache_dir = Path(args.cache_dir)
    if not cache_dir.is_dir():
        raise SystemExit(f"Cache directory not found: {cache_dir}")

    torch_mod: Any = importlib.import_module("torch")
    target_dtype = getattr(torch_mod, args.dtype)

    dit_path = cache_dir / "DiT_uvit_tat_xlsr_ema.pth"
    if dit_path.is_file():
        before_mb = dit_path.stat().st_size / (1024 * 1024)
        state = _torch_load(torch_mod, dit_path)
        optimized = (
            {"net": _convert_state_dict(state["net"], target_dtype)}
            if isinstance(state, dict) and "net" in state
            else _convert_state_dict(state, target_dtype)
        )
        _atomic_torch_save(torch_mod, optimized, dit_path)
        after_mb = dit_path.stat().st_size / (1024 * 1024)
        print(
            f"[optimize_voice_checkpoints] {dit_path.name}: "
            f"{before_mb:.1f} MiB -> {after_mb:.1f} MiB ({args.dtype})",
            flush=True,
        )

    hift_path = cache_dir / "hift.pt"
    if hift_path.is_file():
        before_mb = hift_path.stat().st_size / (1024 * 1024)
        state = _torch_load(torch_mod, hift_path)
        optimized = _convert_state_dict(state, target_dtype)
        _atomic_torch_save(torch_mod, optimized, hift_path)
        after_mb = hift_path.stat().st_size / (1024 * 1024)
        print(
            f"[optimize_voice_checkpoints] {hift_path.name}: "
            f"{before_mb:.1f} MiB -> {after_mb:.1f} MiB ({args.dtype})",
            flush=True,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
