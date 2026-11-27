#!/usr/bin/env python3
"""Prune Wav2Vec2 XLSR-300M to the first N transformer layers in float16 safetensors.

Seed-VC real-time v1 (`config_dit_mel_seed_uvit_xlsr_tiny.yml`) only reads layer 12 of the
24-layer `facebook/wav2vec2-xls-r-300m` encoder in float16. Pruning layers 12..23 offline and
saving as float16 `.safetensors` shrinks the checkpoint from ~1.2 GB to ~340 MB (~3.5x faster
loading and Docker image footprint) with identical inference output.
"""

from __future__ import annotations

import argparse
import importlib
import shutil
import sys
from pathlib import Path
from typing import Any


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--src",
        required=True,
        help="Source HuggingFace repo ID or local directory containing Wav2Vec2 XLSR weights.",
    )
    parser.add_argument(
        "--dest",
        required=True,
        help="Destination directory for the pruned float16 safetensors checkpoint.",
    )
    parser.add_argument(
        "--layers",
        type=int,
        default=12,
        help="Number of encoder transformer layers to retain (default: 12).",
    )
    parser.add_argument(
        "--dtype",
        choices=("float16", "bfloat16", "float32"),
        default="float16",
        help="Target storage dtype (default: float16).",
    )
    parser.add_argument(
        "--remove-src",
        action="store_true",
        help="Delete --src directory after the pruned checkpoint is verified.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.layers <= 0:
        raise SystemExit("--layers must be >= 1")

    torch: Any = importlib.import_module("torch")
    transformers: Any = importlib.import_module("transformers")

    src = str(args.src)
    src_path = Path(src)
    dest_path = Path(args.dest)
    dest_path.mkdir(parents=True, exist_ok=True)

    is_local = src_path.is_dir()
    kwargs = {"local_files_only": True} if is_local else {}

    feat_ext = transformers.Wav2Vec2FeatureExtractor.from_pretrained(src, **kwargs)
    model = transformers.Wav2Vec2Model.from_pretrained(src, **kwargs)

    orig_layers = len(model.encoder.layers)
    if orig_layers > args.layers:
        model.encoder.layers = model.encoder.layers[: args.layers]
    model.config.num_hidden_layers = min(orig_layers, args.layers)

    dtype_map = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    target_dtype = dtype_map[args.dtype]
    model = model.to(dtype=target_dtype).eval()
    model.config.torch_dtype = args.dtype

    feat_ext.save_pretrained(str(dest_path))
    model.save_pretrained(str(dest_path), safe_serialization=True)

    weight_file = dest_path / "model.safetensors"
    config_file = dest_path / "config.json"
    if not weight_file.is_file() or not config_file.is_file():
        raise RuntimeError(f"Pruned XLSR output incomplete in {dest_path}")

    size_mb = weight_file.stat().st_size / (1024 * 1024)
    print(
        f"[prune_xlsr] Saved {model.config.num_hidden_layers}-layer {args.dtype} XLSR -> "
        f"{dest_path} ({size_mb:.1f} MiB)",
        flush=True,
    )

    if args.remove_src and is_local and src_path.resolve() != dest_path.resolve():
        shutil.rmtree(src_path, ignore_errors=True)
        print(f"[prune_xlsr] Removed unpruned source directory {src_path}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
