"""Real-time JoyAI-Video-Edit (RV2V / V2V) pipeline wrapper."""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import logging
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Generator, Sequence
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.base import (
    VideoFrameIn,
    VideoFrameOut,
    VideoGateEvent,
    VideoPipeline,
    VideoSession,
    VideoSessionConfig,
)
from metamorph_engine.protocol import FrameFlags, VideoCodec

logger = logging.getLogger("metamorph_engine.pipelines.video_joyai")

_NETWORK_OR_FUSE_FS_PREFIXES = (
    "fuse",
    "nfs",
    "ceph",
    "9p",
    "s3fs",
    "gcsfuse",
    "lustre",
    "glusterfs",
    "sshfs",
    "virtiofs",
    "cifs",
    "smb",
)

_CACHE_MODE_MARKER = ".metamorph_compile_mode"
_CACHE_SHAPES_MARKER = ".metamorph_warmed_shapes"
_COMPILE_MODE_RANK: dict[str, int] = {
    "none": 0,
    "default": 1,
    "reduce-overhead": 2,
    "max-autotune-no-cudagraphs": 3,
}


def _is_network_or_fuse_path(path: str | Path, *, mounts_file: str = "/proc/mounts") -> bool:
    """Return True if `path` resides on a FUSE or network mount where torch mmap crawls."""
    try:
        resolved = str(Path(path).resolve())
    except OSError:
        resolved = str(path)

    best_mount = ""
    best_fstype = ""
    try:
        with open(mounts_file, encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mount_point = parts[1].replace("\\040", " ")
                fstype = parts[2].lower()
                is_match = (
                    mount_point == "/"
                    or resolved == mount_point
                    or resolved.startswith(mount_point.rstrip("/") + "/")
                )
                if is_match and len(mount_point) > len(best_mount):
                    best_mount = mount_point
                    best_fstype = fstype
    except OSError:
        return False

    return any(
        best_fstype == prefix or best_fstype.startswith(prefix + ".")
        for prefix in _NETWORK_OR_FUSE_FS_PREFIXES
    )


def _should_disable_dit_mmap(dit_ckpt: str, setting: str) -> bool:
    """Decide whether to disable mmap for large checkpoints on network/FUSE volumes."""
    if setting == "true":
        return True
    if setting == "false":
        return False
    if _is_network_or_fuse_path(dit_ckpt):
        return True
    # RunPod global/network volumes mount under /models, /workspace, or /runpod-volume
    if os.environ.get("RUNPOD_POD_ID"):
        resolved = str(Path(dit_ckpt))
        if resolved.startswith(("/models/", "/workspace/", "/runpod-volume/")):
            return True
    return False


def _dir_has_files(path: Path) -> bool:
    try:
        return path.is_dir() and any(path.iterdir())
    except OSError:
        return False


def _read_compile_mode_marker(path: Path) -> str | None:
    try:
        val = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return val if val in _COMPILE_MODE_RANK else None


def _resolve_video_compile_mode(
    setting: str,
    *,
    cache_root: str | Path | None = None,
    inductor_cache_dir: str | Path | None = None,
) -> str:
    """Resolve effective `torch.compile` mode for xVAE.

    In `auto` mode, reuse `max-autotune-no-cudagraphs` or `reduce-overhead` only when a
    matching pre-warmed Inductor cache was seeded on disk; otherwise use `default` so cold
    pod boots finish in ~25-45s instead of running 15+ minutes of coordinate descent.
    """
    if setting != "auto":
        return setting

    root = Path(cache_root) if cache_root else None
    if root is None:
        env_root = os.environ.get("JOYOMNI_CACHE_ROOT", "").strip()
        root = Path(env_root) if env_root else None

    inductor_dir = Path(inductor_cache_dir) if inductor_cache_dir else None
    if inductor_dir is None:
        env_ind = os.environ.get("TORCHINDUCTOR_CACHE_DIR", "").strip()
        if env_ind:
            inductor_dir = Path(env_ind)
        elif root is not None:
            inductor_dir = root / "torchinductor"

    if root is not None and inductor_dir is not None and _dir_has_files(inductor_dir):
        seeded_mode = _read_compile_mode_marker(root / _CACHE_MODE_MARKER)
        if seeded_mode in ("max-autotune-no-cudagraphs", "reduce-overhead", "default"):
            return seeded_mode

    return "default"


def _parse_shapes_marker(path: Path) -> set[tuple[int, int]]:
    shapes: set[tuple[int, int]] = set()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return shapes
    for token in text.split():
        if "x" not in token:
            continue
        w_str, h_str = token.split("x", 1)
        try:
            w = int(w_str)
            h = int(h_str)
        except ValueError:
            continue
        if w > 0 and h > 0:
            shapes.add((w, h))
    return shapes


def _format_shapes_marker(shapes: set[tuple[int, int]]) -> str:
    return "".join(f"{w}x{h}\n" for w, h in sorted(shapes))


def _persist_compile_cache_archive(
    *,
    local_cache_root: Path,
    volume_cache_root: Path,
    compile_mode: str,
    warmed_shapes: Sequence[tuple[int, int]] = (),
    force: bool = False,
) -> Path | None:
    """Pack local compile cache into an atomic `.tar.zst` (or `.tar.gz`) archive on the volume."""
    if compile_mode == "none" or not _dir_has_files(local_cache_root):
        return None

    mode_sidecar = Path(f"{volume_cache_root}.compile_mode")
    shapes_sidecar = Path(f"{volume_cache_root}.shapes")
    use_zstd = shutil.which("zstd") is not None
    ext = ".tar.zst" if use_zstd else ".tar.gz"
    target_archive = Path(f"{volume_cache_root}{ext}")

    existing_mode = _read_compile_mode_marker(mode_sidecar)
    existing_archive = (
        Path(f"{volume_cache_root}.tar.zst").is_file()
        or Path(f"{volume_cache_root}.tar.gz").is_file()
    )
    existing_shapes = _parse_shapes_marker(shapes_sidecar)
    local_shapes = _parse_shapes_marker(local_cache_root / _CACHE_SHAPES_MARKER)
    requested_shapes = {
        (int(w), int(h)) for w, h in warmed_shapes if int(w) > 0 and int(h) > 0
    } | local_shapes
    persisted_shapes = requested_shapes

    if (
        not force
        and existing_archive
        and existing_mode is not None
        and _COMPILE_MODE_RANK.get(existing_mode, -1) >= _COMPILE_MODE_RANK.get(compile_mode, 0)
        and requested_shapes.issubset(existing_shapes)
    ):
        logger.info(
            "Persistent compile cache archive already exists at %s (mode=%s >= %s); skipping.",
            volume_cache_root,
            existing_mode,
            compile_mode,
        )
        return None

    persisted_mode = (
        compile_mode
        if force
        or existing_mode is None
        or _COMPILE_MODE_RANK.get(compile_mode, 0) >= _COMPILE_MODE_RANK.get(existing_mode, -1)
        else existing_mode
    )

    t0 = time.monotonic()
    local_tmp: Path | None = None
    volume_tmp: Path | None = None
    try:
        (local_cache_root / _CACHE_MODE_MARKER).write_text(f"{persisted_mode}\n", encoding="utf-8")
        if persisted_shapes:
            (local_cache_root / _CACHE_SHAPES_MARKER).write_text(
                _format_shapes_marker(persisted_shapes), encoding="utf-8"
            )
        volume_cache_root.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix="metamorph-cache-",
            suffix=ext,
            delete=False,
        ) as tmp_fh:
            local_tmp = Path(tmp_fh.name)

        tar_cmd = (
            ["tar", "--zstd", "-cf", str(local_tmp), "-C", str(local_cache_root), "."]
            if use_zstd
            else ["tar", "-czf", str(local_tmp), "-C", str(local_cache_root), "."]
        )
        for attempt in range(2):
            proc = subprocess.run(tar_cmd, check=False, capture_output=True)
            if proc.returncode == 0:
                break
            if proc.returncode == 1 and attempt == 0:
                time.sleep(0.25)
                continue
            if proc.returncode == 1 and local_tmp.is_file() and local_tmp.stat().st_size > 0:
                logger.warning(
                    "tar reported file modified while archiving %s; continuing with archive.",
                    local_cache_root,
                )
                break
            raise subprocess.CalledProcessError(
                proc.returncode, tar_cmd, output=proc.stdout, stderr=proc.stderr
            )

        volume_tmp = Path(f"{target_archive}.tmp.{os.getpid()}")
        shutil.copyfile(local_tmp, volume_tmp)
        os.replace(volume_tmp, target_archive)
        volume_tmp = None

        sidecar_tmp = Path(f"{mode_sidecar}.tmp.{os.getpid()}")
        sidecar_tmp.write_text(f"{persisted_mode}\n", encoding="utf-8")
        os.replace(sidecar_tmp, mode_sidecar)

        if persisted_shapes:
            shapes_tmp = Path(f"{shapes_sidecar}.tmp.{os.getpid()}")
            shapes_tmp.write_text(_format_shapes_marker(persisted_shapes), encoding="utf-8")
            os.replace(shapes_tmp, shapes_sidecar)

        size_mb = target_archive.stat().st_size / (1024 * 1024)
        logger.info(
            "Persisted compile cache archive %s (%.1f MiB, mode=%s, shapes=%d) in %.1fs",
            target_archive,
            size_mb,
            persisted_mode,
            len(persisted_shapes),
            time.monotonic() - t0,
        )
        return target_archive
    except Exception as exc:
        logger.warning(
            "Failed persisting compile cache archive to %s: %s",
            target_archive,
            exc,
        )
        return None
    finally:
        if local_tmp is not None:
            with contextlib.suppress(OSError):
                local_tmp.unlink()
        if volume_tmp is not None:
            with contextlib.suppress(OSError):
                volume_tmp.unlink()


def _schedule_compile_cache_persist(
    compile_mode: str,
    *,
    enabled: bool,
    warmed_shapes: Sequence[tuple[int, int]] = (),
) -> threading.Thread | None:
    """Record compile markers locally and asynchronously archive cache to persistent volume."""
    local_root_env = os.environ.get("JOYOMNI_CACHE_ROOT", "").strip()
    if not local_root_env or compile_mode == "none":
        return None

    local_root = Path(local_root_env)
    with contextlib.suppress(OSError):
        local_root.mkdir(parents=True, exist_ok=True)
        (local_root / _CACHE_MODE_MARKER).write_text(f"{compile_mode}\n", encoding="utf-8")
        existing_local = _parse_shapes_marker(local_root / _CACHE_SHAPES_MARKER)
        combined = existing_local | {
            (int(w), int(h)) for w, h in warmed_shapes if int(w) > 0 and int(h) > 0
        }
        if combined:
            (local_root / _CACHE_SHAPES_MARKER).write_text(
                _format_shapes_marker(combined), encoding="utf-8"
            )

    if not enabled:
        return None

    volume_root_env = os.environ.get("JOYOMNI_VOLUME_CACHE_ROOT", "").strip()
    if not volume_root_env:
        return None

    volume_root = Path(volume_root_env)
    try:
        if local_root.resolve() == volume_root.resolve():
            return None
    except OSError:
        if str(local_root) == str(volume_root):
            return None

    thread = threading.Thread(
        target=_persist_compile_cache_archive,
        kwargs={
            "local_cache_root": local_root,
            "volume_cache_root": volume_root,
            "compile_mode": compile_mode,
            "warmed_shapes": tuple(warmed_shapes),
        },
        name="joyai-cache-persist",
        daemon=True,
    )
    thread.start()
    return thread


class _BufferedTensorSlice:
    """Minimal `PySafeSlice`-compatible accessor backed by a sequential file read."""

    def __init__(self, opener: _BufferedSafeOpen, name: str, info: dict[str, Any]) -> None:
        self._opener = opener
        self._name = name
        self._info = info

    def get_shape(self) -> list[int]:
        return [int(dim) for dim in self._info.get("shape", ())]

    def get_dtype(self) -> str:
        return str(self._info.get("dtype", ""))

    def __getitem__(self, slices: Any) -> Any:
        return self._opener.get_tensor(self._name)[slices]


class _BufferedSafeOpen:
    """Drop-in `safetensors.safe_open` context manager avoiding `mmap` on FUSE mounts."""

    def __init__(
        self,
        filename: str | os.PathLike[str],
        *,
        load_bytes_fn: Any,
        framework: str = "pt",
        device: Any = "cpu",
    ) -> None:
        self._path = Path(filename)
        self._load_bytes_fn = load_bytes_fn
        self._framework = framework
        self._device = device
        self._tensors: dict[str, Any] | None = None

        with open(self._path, "rb") as fh:
            len_bytes = fh.read(8)
            if len(len_bytes) != 8:
                raise ValueError(f"Corrupt safetensors file (short header): {self._path}")
            header_len = struct.unpack("<Q", len_bytes)[0]
            header_raw = fh.read(header_len)
            if len(header_raw) != header_len:
                raise ValueError(f"Corrupt safetensors file (truncated header): {self._path}")
        header = json.loads(header_raw.decode("utf-8"))
        raw_meta = header.pop("__metadata__", None)
        self._metadata: dict[str, str] | None = (
            {str(k): str(v) for k, v in raw_meta.items()} if isinstance(raw_meta, dict) else None
        )
        self._header: dict[str, dict[str, Any]] = header

    def __enter__(self) -> _BufferedSafeOpen:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._tensors = None

    def metadata(self) -> dict[str, str] | None:
        return self._metadata

    def keys(self) -> list[str]:
        return list(self._header.keys())

    def _ensure_loaded(self) -> dict[str, Any]:
        if self._tensors is None:
            self._tensors = self._load_bytes_fn(self._path.read_bytes())
        assert self._tensors is not None
        return self._tensors

    def get_tensor(self, name: str) -> Any:
        return self._ensure_loaded()[name]

    def get_slice(self, name: str) -> _BufferedTensorSlice:
        return _BufferedTensorSlice(self, name, self._header[name])


@contextlib.contextmanager
def _patch_fuse_safetensors_loaders(
    *,
    disable_mmap: bool,
    mmap_setting: str,
) -> Generator[None]:
    """Avoid `mmap` page-fault storms on FUSE/network mounts for safetensors loaders."""
    if not disable_mmap:
        yield
        return

    restorers: list[Any] = []
    load_bytes: Any = None

    try:
        st_torch: Any = importlib.import_module("safetensors.torch")
        orig_load_file = getattr(st_torch, "load_file", None)
        load_bytes = getattr(st_torch, "load", None)
        if callable(orig_load_file) and callable(load_bytes):

            def _load_file_no_mmap(filename: str | os.PathLike[str], device: Any = "cpu") -> Any:
                if str(device) == "cpu" and _should_disable_dit_mmap(str(filename), mmap_setting):
                    return load_bytes(Path(filename).read_bytes())
                return orig_load_file(filename, device=device)

            st_torch.load_file = _load_file_no_mmap
            restorers.append(
                lambda mod=st_torch, orig=orig_load_file: setattr(mod, "load_file", orig)
            )
    except Exception:
        pass

    try:
        st_mod: Any = importlib.import_module("safetensors")
        orig_safe_open = getattr(st_mod, "safe_open", None)
        if callable(orig_safe_open) and callable(load_bytes):

            def _safe_open_no_mmap(
                filename: str | os.PathLike[str],
                framework: str = "pt",
                device: Any = "cpu",
            ) -> Any:
                if (
                    framework == "pt"
                    and str(device) == "cpu"
                    and _should_disable_dit_mmap(str(filename), mmap_setting)
                ):
                    return _BufferedSafeOpen(
                        filename,
                        load_bytes_fn=load_bytes,
                        framework=framework,
                        device=device,
                    )
                return orig_safe_open(filename, framework=framework, device=device)

            st_mod.safe_open = _safe_open_no_mmap
            restorers.append(
                lambda mod=st_mod, orig=orig_safe_open: setattr(mod, "safe_open", orig)
            )

            for mod_name in (
                "transformers.modeling_utils",
                "transformers.core_model_loading",
                "diffusers.models.modeling_utils",
            ):
                with contextlib.suppress(Exception):
                    importlib.import_module(mod_name)

            for mod_raw in list(sys.modules.values()):
                if mod_raw is None or mod_raw is st_mod:
                    continue
                mod: Any = mod_raw
                if getattr(mod, "safe_open", None) is orig_safe_open:
                    mod.safe_open = _safe_open_no_mmap
                    restorers.append(
                        lambda target=mod, orig=orig_safe_open: setattr(target, "safe_open", orig)
                    )
    except Exception:
        pass

    try:
        yield
    finally:
        for restore in reversed(restorers):
            with contextlib.suppress(Exception):
                restore()


@contextlib.contextmanager
def _patch_joyai_compile_and_warmup(
    *,
    streaming_mod: Any,
    compile_mode: str,
    warmup_height: int,
    warmup_width: int,
    warmup_both_orientations: bool,
    skip_ref_image_compile: bool,
) -> Generator[None]:
    """Configure upstream JoyAI xVAE compilation and warmup without modifying `vendor/`.

    Applies persistent runtime hooks on `xvideo.models.vae.vae_compile` (`compile_mode`
    selection and eager one-shot reference-image encoding) and temporary load-time filters
    that skip the transposed orientation and 49-shape dynamic warmup.
    """
    load_time_restorers: list[Any] = []

    vc: Any
    try:
        vc = importlib.import_module("xvideo.models.vae.vae_compile")
    except Exception:
        vc = None

    if vc is not None:
        vc_mod: Any = vc
        torch_mod: Any = importlib.import_module("torch")
        nn_mod = torch_mod.nn

        def _convert_conv3d_channels_last(vae: Any) -> int:
            n_conv = 0
            for m in vae.modules():
                if isinstance(m, nn_mod.Conv3d):
                    m.weight.data = m.weight.data.to(memory_format=torch_mod.channels_last_3d)
                    n_conv += 1
            return n_conv

        def _save_orig_encode(vae: Any) -> None:
            if hasattr(vae, "_metamorph_orig_encode"):
                return
            if hasattr(vae, "_encode"):
                vae._metamorph_orig_encode = vae._encode
                vae._metamorph_orig_encode_is_raw = True
            elif hasattr(vae, "encode"):
                vae._metamorph_orig_encode = vae.encode
                vae._metamorph_orig_encode_is_raw = False

        def _maybe_setup_decode(vae: Any) -> None:
            if id(vae) in vc_mod._configured:
                return
            n_conv = _convert_conv3d_channels_last(vae)
            if hasattr(vae, "_decode"):
                target = "_decode"
            elif hasattr(vae, "decode"):
                target = "decode"
            else:
                raise RuntimeError("VAE has neither _decode nor decode; cannot compile")
            if compile_mode != "none":
                setattr(
                    vae,
                    target,
                    torch_mod.compile(getattr(vae, target), mode=compile_mode, dynamic=False),
                )
            vc_mod._configured.add(id(vae))
            logger.info(
                "[vae_compile] %d Conv3d weights -> channels_last_3d (decode=%s, mode=%s)",
                n_conv,
                target,
                compile_mode,
            )

        def _maybe_setup_encode(vae: Any) -> None:
            if id(vae) in vc_mod._configured_encode:
                return
            _save_orig_encode(vae)
            n_conv = _convert_conv3d_channels_last(vae)
            if hasattr(vae, "_encode"):
                target = "_encode"
            elif hasattr(vae, "encode"):
                target = "encode"
            else:
                raise RuntimeError("VAE has neither _encode nor encode; cannot compile")
            if compile_mode != "none":
                setattr(
                    vae,
                    target,
                    torch_mod.compile(getattr(vae, target), mode=compile_mode, dynamic=False),
                )
            vc_mod._configured_encode.add(id(vae))
            logger.info(
                "[vae_compile] %d Conv3d weights -> channels_last_3d (encode=%s, mode=%s)",
                n_conv,
                target,
                compile_mode,
            )

        def _maybe_setup_encode_dynamic(vae: Any) -> None:
            if id(vae) in vc_mod._configured_encode_dynamic:
                return
            _save_orig_encode(vae)
            if skip_ref_image_compile or compile_mode == "none":
                vc_mod._configured_encode_dynamic.add(id(vae))
                logger.info(
                    "[vae_compile] skipping dynamic reference-image compile (eager one-shot encode)"
                )
                return
            core = getattr(vae, "_metamorph_orig_encode", None)
            if core is None:
                if hasattr(vae, "_encode"):
                    core = vae._encode
                elif hasattr(vae, "encode"):
                    core = vae.encode
                else:
                    raise RuntimeError("VAE has neither _encode nor encode; cannot compile")
            vae._encode_dynamic = torch_mod.compile(core, mode=compile_mode, dynamic=True)
            vc_mod._configured_encode_dynamic.add(id(vae))
            logger.info(
                "[vae_compile] compiled vae._encode_dynamic (mode=%s, dynamic=True)",
                compile_mode,
            )

        orig_encode_via_dynamic = vc_mod.encode_via_dynamic

        def _encode_via_dynamic(vae: Any, x: Any) -> Any:
            if skip_ref_image_compile or compile_mode == "none":
                orig_fn = getattr(vae, "_metamorph_orig_encode", None)
                if orig_fn is not None:
                    prepped = vc_mod.prep_input(x)
                    if getattr(vae, "_metamorph_orig_encode_is_raw", True):
                        vae_mod = importlib.import_module("xvideo.models.vae.vae")
                        h = orig_fn(prepped)
                        return vae_mod.EncoderOutput(
                            latent_dist=vae_mod.DiagonalGaussianDistribution(h)
                        )
                    return orig_fn(prepped)
            return orig_encode_via_dynamic(vae, x)

        vc_mod.maybe_setup_decode = _maybe_setup_decode
        vc_mod.maybe_setup_encode = _maybe_setup_encode
        vc_mod.maybe_setup_encode_dynamic = _maybe_setup_encode_dynamic
        vc_mod.encode_via_dynamic = _encode_via_dynamic

        if skip_ref_image_compile:
            orig_warmup_encode_dynamic = vc_mod.warmup_encode_dynamic

            def _skip_warmup_encode_dynamic(
                _vae: Any,
                _in_channels: int,
                hw_list: Any,
                *_args: Any,
                **_kwargs: Any,
            ) -> None:
                count = len(hw_list) if hasattr(hw_list, "__len__") else 0
                logger.info(
                    "[vae_compile] skipping warmup_encode_dynamic across %d reference-image shapes",
                    count,
                )

            vc_mod.warmup_encode_dynamic = _skip_warmup_encode_dynamic
            load_time_restorers.append(
                lambda: setattr(vc_mod, "warmup_encode_dynamic", orig_warmup_encode_dynamic)
            )

        if not warmup_both_orientations and warmup_height != warmup_width:
            orig_warmup_decode = vc_mod.warmup_decode
            orig_warmup_encode = vc_mod.warmup_encode
            want_portrait = warmup_height > warmup_width

            def _single_orientation_warmup_decode(
                vae: Any,
                latent_channels: int,
                h_lat: int,
                w_lat: int,
                *args: Any,
                **kwargs: Any,
            ) -> None:
                if h_lat != w_lat and (h_lat > w_lat) != want_portrait:
                    logger.info(
                        "[vae_compile] skipping transposed decode warmup (%sx%s)",
                        w_lat,
                        h_lat,
                    )
                    return
                orig_warmup_decode(vae, latent_channels, h_lat, w_lat, *args, **kwargs)

            def _single_orientation_warmup_encode(
                vae: Any,
                in_channels: int,
                h_px: int,
                w_px: int,
                *args: Any,
                **kwargs: Any,
            ) -> None:
                if (h_px, w_px) == (warmup_width, warmup_height):
                    logger.info(
                        "[vae_compile] skipping transposed encode warmup (%sx%s)",
                        w_px,
                        h_px,
                    )
                    return
                orig_warmup_encode(vae, in_channels, h_px, w_px, *args, **kwargs)

            vc_mod.warmup_decode = _single_orientation_warmup_decode
            vc_mod.warmup_encode = _single_orientation_warmup_encode
            load_time_restorers.append(lambda: setattr(vc_mod, "warmup_decode", orig_warmup_decode))
            load_time_restorers.append(lambda: setattr(vc_mod, "warmup_encode", orig_warmup_encode))

    runtime_cls = getattr(streaming_mod, "JoyOmniRuntime", None)
    if (
        runtime_cls is not None
        and not warmup_both_orientations
        and warmup_height != warmup_width
        and hasattr(runtime_cls, "warmup_full_pipeline")
    ):
        orig_warmup_full = runtime_cls.warmup_full_pipeline

        def _single_orientation_warmup_full(
            self_rt: Any,
            *,
            height: int = 720,
            width: int = 1248,
            **kwargs: Any,
        ) -> None:
            if (height, width) == (warmup_width, warmup_height):
                logger.info(
                    "Skipping transposed full-pipeline warmup (%sx%s) to preserve CUDA graph",
                    width,
                    height,
                )
                return
            orig_warmup_full(self_rt, height=height, width=width, **kwargs)

        runtime_cls.warmup_full_pipeline = _single_orientation_warmup_full
        load_time_restorers.append(
            lambda: setattr(runtime_cls, "warmup_full_pipeline", orig_warmup_full)
        )

    try:
        yield
    finally:
        for restore in reversed(load_time_restorers):
            with contextlib.suppress(Exception):
                restore()


def _decode_jpeg(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as img:
        return img.convert("RGB")


class JoyAIVideoSession(VideoSession):
    """Wraps `JoyOmniV2VStreamingSession` with MJPEG codec & PTS propagation."""

    def __init__(
        self,
        pipeline: JoyAIVideoPipeline,
        config: VideoSessionConfig,
        ref_image: Image.Image | None,
    ) -> None:
        self._pipeline = pipeline
        self._config = config
        self._ref_image = ref_image.convert("RGB") if ref_image is not None else None
        self._lock = threading.Lock()
        self._out_seq = 0
        self._session: Any | None = None
        self._create_streaming_session(config, self._ref_image)

    def _create_streaming_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None,
    ) -> None:
        mods = self._pipeline.require_modules()
        runtime = mods.runtime
        streaming_mod = mods.streaming
        serving_mod = mods.serving

        align = int(runtime.pipeline.vae.stem.stride) * 8
        snap = serving_mod._snap_to_align
        height = snap(config.height, align)
        width = snap(config.width, align)

        runtime.output_quality = config.output_quality
        runtime.lossless_output = False

        settings = streaming_mod.StreamingSettings(
            height=height,
            width=width,
            num_inference_steps=config.num_inference_steps,
            seed=config.seed,
            max_temporal_ids=config.max_temporal_ids,
            freeze_kv_on_static=config.freeze_kv_on_static,
            static_diff_thresh=config.static_diff_thresh,
            profile_timings=False,
            output_codec="mjpeg",
        )
        self._session = runtime.create_v2v_session(
            prompt=config.prompt,
            settings=settings,
            ref_image=ref_image,
        )

    def push_frame(self, frame: VideoFrameIn) -> VideoGateEvent | None:
        with self._lock:
            session = self._session
            if session is None:
                return None

            max_inflight = self._pipeline.settings.video_max_inflight_chunks
            if max_inflight and session.inflight_chunks() >= max_inflight:
                return VideoGateEvent(event_type="dropped", reason="backpressure")

            try:
                image = _decode_jpeg(frame.payload)
            except (UnidentifiedImageError, OSError, ValueError):
                logger.warning("Dropping corrupt/undecodable video frame seq=%s", frame.seq)
                return VideoGateEvent(event_type="dropped", reason="invalid_frame")
            meta = {
                "seq": frame.seq,
                "pts_us": frame.pts_us,
                "t_capture_ms": frame.pts_us / 1000.0,
            }
            with self._pipeline.infer_lock:
                session.push_frame(image, frame_meta=meta, drain_results=False)
            return None

    def poll_outputs(self, timeout: float = 0.05) -> list[VideoFrameOut]:
        with self._lock:
            session = self._session
        if session is None:
            time.sleep(timeout)
            return []

        try:
            result = session.wait_async_result(timeout=timeout)
        except RuntimeError as exc:
            with self._lock:
                replaced = self._session is not session
            if replaced and "stopped" in str(exc).lower():
                return []
            raise
        if result is None:
            return []

        items = result.jpegs or []
        metas = result.source_metas or [{} for _ in items]
        if result.valid_count is not None:
            items = items[: result.valid_count]
            metas = metas[: result.valid_count]

        if not items:
            return []

        out_frames: list[VideoFrameOut] = []
        total = len(items)
        for idx, raw_jpeg in enumerate(items):
            meta = metas[min(idx, len(metas) - 1)]
            pts_us = int(meta.get("pts_us", round(float(meta.get("t_capture_ms", 0.0)) * 1000.0)))
            self._out_seq += 1
            flags = FrameFlags.KEYFRAME
            if idx == total - 1:
                flags |= FrameFlags.END_OF_CHUNK
            out_frames.append(
                VideoFrameOut(
                    payload=bytes(raw_jpeg),
                    codec=VideoCodec.MJPEG,
                    seq=self._out_seq,
                    pts_us=pts_us,
                    flags=flags,
                )
            )
        return out_frames

    def update_config(self, config: VideoSessionConfig, ref_image: Image.Image | None) -> None:
        with self._lock:
            old = self._session
            self._session = None
            if old is not None:
                old.request_stop()
                old.close(timeout=self._pipeline.settings.video_session_close_timeout_s)
            self._config = config
            self._ref_image = ref_image.convert("RGB") if ref_image is not None else None
            self._create_streaming_session(config, self._ref_image)

    def close(self) -> None:
        with self._lock:
            session = self._session
            self._session = None
        if session is not None:
            session.request_stop()
            session.close(timeout=self._pipeline.settings.video_session_close_timeout_s)


class _JoyAIModules:
    def __init__(
        self,
        *,
        runtime: Any,
        streaming: Any,
        serving: Any,
    ) -> None:
        self.runtime = runtime
        self.streaming = streaming
        self.serving = serving


class JoyAIVideoPipeline(VideoPipeline):
    """JoyAI-Video-Edit streaming RV2V/V2V runtime wrapper."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.infer_lock = threading.Lock()
        self._modules: _JoyAIModules | None = None
        self._persist_thread: threading.Thread | None = None

    def require_modules(self) -> _JoyAIModules:
        """Return loaded JoyAI runtime & serving modules."""
        if self._modules is None:
            raise RuntimeError("JoyAI video pipeline is not loaded; call warmup() first.")
        return self._modules

    def warmup(self) -> None:
        if self._modules is not None:
            return

        deploy_dir = self.settings.resolved_vendor_dir / "JoyAI-Video-Edit" / "deploy"
        if not deploy_dir.is_dir():
            raise FileNotFoundError(
                f"vendor/JoyAI-Video-Edit/deploy directory not found at {deploy_dir}"
            )
        if str(deploy_dir) not in sys.path:
            sys.path.insert(0, str(deploy_dir))

        try:
            inductor_fix = importlib.import_module("xvideo.inductor_autotune_fix")
            inductor_fix.install()
        except Exception:
            pass

        streaming_mod = importlib.import_module("xvideo.serving.joyomni_streaming")
        serving_mod = importlib.import_module("xvideo.serving.serve_joyomni_streaming")

        ckpt_root = deploy_dir / "deps" / "checkpoints"
        dit_ckpt = self.settings.video_dit_ckpt or str(
            ckpt_root / "JoyAI-Video-Edit" / "dit" / "joyai_video_edit_dit_1101_face++.pth"
        )
        vae_ckpt = self.settings.video_vae_ckpt
        text_encoder_ckpt = self.settings.video_text_encoder_ckpt

        # Validate explicit checkpoint paths early so missing weights fail fast with a clear error
        missing: list[str] = []
        if self.settings.video_dit_ckpt and not Path(dit_ckpt).is_file():
            missing.append(f"DiT checkpoint ({dit_ckpt})")
        if vae_ckpt and not Path(vae_ckpt).exists():
            missing.append(f"VAE checkpoint ({vae_ckpt})")
        if text_encoder_ckpt and not Path(text_encoder_ckpt).exists():
            missing.append(f"MiMo-VL text encoder ({text_encoder_ckpt})")
        if missing:
            raise FileNotFoundError(
                "Missing required JoyAI video checkpoints: " + ", ".join(missing)
            )

        if not self.settings.warmup_on_startup:
            os.environ.setdefault("JOYOMNI_SKIP_LOAD_WARMUP", "1")

        # Snap warmup dimensions to xVAE 24px alignment (stem.stride=3 * 8) so warmup never asserts
        snap = getattr(serving_mod, "_snap_to_align", None)
        warmup_h = (
            snap(self.settings.video_height, 24) if callable(snap) else self.settings.video_height
        )
        warmup_w = (
            snap(self.settings.video_width, 24) if callable(snap) else self.settings.video_width
        )

        effective_compile_mode = _resolve_video_compile_mode(self.settings.video_compile_mode)

        # Upstream models.py disables mmap when SPACE_ID is present (mmap on FUSE crawls for hours)
        disable_mmap = _should_disable_dit_mmap(dit_ckpt, self.settings.video_disable_mmap)
        had_space_id = "SPACE_ID" in os.environ
        prev_space_id = os.environ.get("SPACE_ID")
        if disable_mmap and not had_space_id:
            os.environ["SPACE_ID"] = "1"
            logger.info(
                "Disabling mmap for JoyAI checkpoints on network/FUSE storage: %s",
                dit_ckpt,
            )

        t0 = time.monotonic()
        logger.info(
            "Loading JoyAI runtime (dit=%s, warmup=%sx%s, compile_mode=%s, "
            "both_orientations=%s, skip_ref_compile=%s, fp8_img=%s, fp8_txt=%s, low_vram=%s)",
            dit_ckpt,
            warmup_w,
            warmup_h,
            effective_compile_mode,
            self.settings.video_warmup_both_orientations,
            self.settings.video_skip_ref_image_compile,
            os.environ.get("JOYOMNI_FP8_IMG", ""),
            os.environ.get("JOYOMNI_FP8_TXT", ""),
            os.environ.get("JOYOMNI_LOW_VRAM", ""),
        )
        try:
            with (
                _patch_fuse_safetensors_loaders(
                    disable_mmap=disable_mmap,
                    mmap_setting=self.settings.video_disable_mmap,
                ),
                _patch_joyai_compile_and_warmup(
                    streaming_mod=streaming_mod,
                    compile_mode=effective_compile_mode,
                    warmup_height=warmup_h,
                    warmup_width=warmup_w,
                    warmup_both_orientations=self.settings.video_warmup_both_orientations,
                    skip_ref_image_compile=self.settings.video_skip_ref_image_compile,
                ),
            ):
                runtime = streaming_mod.JoyOmniRuntime.load(
                    dit_ckpt,
                    vae_ckpt=vae_ckpt,
                    text_encoder_ckpt=text_encoder_ckpt,
                    device=self.settings.device,
                    seed=self.settings.video_seed,
                    warmup_height=warmup_h,
                    warmup_width=warmup_w,
                )
        finally:
            if disable_mmap and not had_space_id:
                if prev_space_id is None:
                    os.environ.pop("SPACE_ID", None)
                else:
                    os.environ["SPACE_ID"] = prev_space_id

        logger.info("JoyAI runtime loaded and warmed up in %.1fs", time.monotonic() - t0)

        warmed_shapes = [(warmup_w, warmup_h)]
        if self.settings.video_warmup_both_orientations and warmup_w != warmup_h:
            warmed_shapes.append((warmup_h, warmup_w))

        self._persist_thread = _schedule_compile_cache_persist(
            effective_compile_mode,
            enabled=self.settings.video_persist_compile_cache,
            warmed_shapes=warmed_shapes,
        )

        self._modules = _JoyAIModules(
            runtime=runtime,
            streaming=streaming_mod,
            serving=serving_mod,
        )

    def create_session(
        self,
        config: VideoSessionConfig,
        ref_image: Image.Image | None = None,
    ) -> VideoSession:
        return JoyAIVideoSession(self, config, ref_image)

    def close(self) -> None:
        persist_thread = self._persist_thread
        self._persist_thread = None
        if persist_thread is not None and persist_thread.is_alive():
            persist_thread.join(timeout=30.0)
        self._modules = None
