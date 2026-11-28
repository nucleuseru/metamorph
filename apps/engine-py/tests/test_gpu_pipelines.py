"""Tests verifying GPU pipeline wrappers, vendor contracts, and Seed-VC/JoyAI compatibility."""

from __future__ import annotations

import ast
import builtins
import io
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.base import (
    AudioChunkIn,
    AudioSessionConfig,
    VideoFrameIn,
    VideoSessionConfig,
)
from metamorph_engine.pipelines.video_joyai import JoyAIVideoPipeline, JoyAIVideoSession
from metamorph_engine.pipelines.voice_seedvc import (
    SeedVCVoicePipeline,
    _ensure_dac_importable,
    _load_seedvc_checkpoint,
    _torch_load_compat,
)
from metamorph_engine.protocol import AudioCodec, FrameFlags, VideoCodec
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]


def _make_module(name: str, **attrs: Any) -> Any:
    mod: Any = types.ModuleType(name)
    for key, val in attrs.items():
        setattr(mod, key, val)
    return mod


def _parse_ast(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _ast_class(tree: ast.Module, name: str) -> ast.ClassDef:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    raise AssertionError(f"Class {name} not found")


def _ast_func(
    parent: ast.Module | ast.ClassDef,
    name: str,
) -> ast.FunctionDef | ast.AsyncFunctionDef:
    for node in parent.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"Function {name} not found")


def _arg_names(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    args = fn.args
    return {a.arg for a in (*args.posonlyargs, *args.args, *args.kwonlyargs)}


def _class_field_names(cls_node: ast.ClassDef) -> set[str]:
    fields: set[str] = set()
    for node in cls_node.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            fields.add(node.target.id)
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    fields.add(tgt.id)
    return fields


def test_joyai_vendor_contract_matches_wrapper() -> None:
    """Verify upstream vendor/JoyAI-Video-Edit symbols/args match video_joyai.py."""
    serving_dir = REPO_ROOT / "vendor" / "JoyAI-Video-Edit" / "deploy" / "xvideo" / "serving"
    if not serving_dir.is_dir():
        pytest.skip("JoyAI-Video-Edit vendor submodule is not populated.")

    streaming_ast = _parse_ast(serving_dir / "joyomni_streaming.py")
    serve_ast = _parse_ast(serving_dir / "serve_joyomni_streaming.py")

    settings_cls = _ast_class(streaming_ast, "StreamingSettings")
    assert {
        "height",
        "width",
        "num_inference_steps",
        "seed",
        "max_temporal_ids",
        "freeze_kv_on_static",
        "static_diff_thresh",
        "profile_timings",
        "output_codec",
    }.issubset(_class_field_names(settings_cls))

    runtime_cls = _ast_class(streaming_ast, "JoyOmniRuntime")
    assert {
        "vae_ckpt",
        "text_encoder_ckpt",
        "device",
        "seed",
        "warmup_height",
        "warmup_width",
    }.issubset(_arg_names(_ast_func(runtime_cls, "load")))
    assert {"prompt", "settings", "ref_image"}.issubset(
        _arg_names(_ast_func(runtime_cls, "create_v2v_session"))
    )

    session_cls = _ast_class(streaming_ast, "JoyOmniV2VStreamingSession")
    assert {"frame", "frame_meta", "drain_results"}.issubset(
        _arg_names(_ast_func(session_cls, "push_frame"))
    )
    assert "timeout" in _arg_names(_ast_func(session_cls, "wait_async_result"))
    _ast_func(session_cls, "inflight_chunks")
    _ast_func(session_cls, "request_stop")
    assert "timeout" in _arg_names(_ast_func(session_cls, "close"))

    _ast_func(serve_ast, "_snap_to_align")


def test_seedvc_vendor_contract_matches_wrapper() -> None:
    """Verify upstream vendor/seed-vc modules and presets match voice_seedvc.py."""
    seedvc_dir = REPO_ROOT / "vendor" / "seed-vc"
    if not seedvc_dir.is_dir():
        pytest.skip("seed-vc vendor submodule is not populated.")

    assert (seedvc_dir / "configs" / "presets" / "config_dit_mel_seed_uvit_xlsr_tiny.yml").is_file()
    assert (seedvc_dir / "configs" / "hifigan.yml").is_file()
    assert (seedvc_dir / "campplus_cn_common.bin").is_file()

    commons_ast = _parse_ast(seedvc_dir / "modules" / "commons.py")
    _ast_func(commons_ast, "build_model")
    _ast_func(commons_ast, "recursive_munch")

    audio_ast = _parse_ast(seedvc_dir / "modules" / "audio.py")
    _ast_func(audio_ast, "mel_spectrogram")

    flow_ast = _parse_ast(seedvc_dir / "modules" / "flow_matching.py")
    cfm_cls = _ast_class(flow_ast, "BASECFM")
    _ast_func(cfm_cls, "inference")

    reg_ast = _parse_ast(seedvc_dir / "modules" / "length_regulator.py")
    _ast_class(reg_ast, "InterpolateRegulator")

    campplus_ast = _parse_ast(seedvc_dir / "modules" / "campplus" / "DTDNN.py")
    _ast_class(campplus_ast, "CAMPPlus")

    hift_ast = _parse_ast(seedvc_dir / "modules" / "hifigan" / "generator.py")
    _ast_class(hift_ast, "HiFTGenerator")

    f0_ast = _parse_ast(seedvc_dir / "modules" / "hifigan" / "f0_predictor.py")
    _ast_class(f0_ast, "ConvRNNF0Predictor")


def test_joyai_pipeline_warmup_session_codecs_gates_backpressure_and_hotswap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify JoyAIVideoPipeline & JoyAIVideoSession wrap upstream runtime cleanly."""
    monkeypatch.setattr(sys, "path", list(sys.path))

    load_calls: list[dict[str, Any]] = []
    created_sessions: list[Any] = []

    @dataclass(frozen=True)
    class _StreamingSettings:
        height: int = 720
        width: int = 1248
        num_inference_steps: int = 2
        seed: int = 42
        max_temporal_ids: int | None = None
        freeze_kv_on_static: bool = True
        static_diff_thresh: float = 0.5
        profile_timings: bool = False
        output_codec: str = "mjpeg"

    class _FakeChunkResult:
        def __init__(
            self,
            *,
            jpegs: list[Any],
            source_metas: list[dict[str, Any]],
            valid_count: int | None = None,
        ) -> None:
            self.jpegs = jpegs
            self.source_metas = source_metas
            self.valid_count = valid_count

    class _FakeInnerSession:
        def __init__(self, prompt: str, settings: _StreamingSettings, ref_image: Any) -> None:
            self.prompt = prompt
            self.settings = settings
            self.ref_image = ref_image
            self.inflight = 0
            self.stopped = False
            self.closed = False
            self.flushed = False
            self.pushed: list[tuple[Image.Image, dict[str, Any] | None]] = []
            self.results: list[Any] = []
            self.raise_on_wait: BaseException | None = None
            created_sessions.append(self)

        def inflight_chunks(self) -> int:
            return self.inflight

        def push_frame(
            self,
            frame: Image.Image,
            frame_meta: dict[str, Any] | None = None,
            *,
            drain_results: bool = True,
        ) -> list[Any]:
            self.pushed.append((frame, frame_meta))
            return []

        def wait_async_result(self, timeout: float = 0.05) -> Any | None:
            if self.stopped:
                raise RuntimeError("streaming session stopped")
            if self.raise_on_wait is not None:
                raise self.raise_on_wait
            if self.results:
                return self.results.pop(0)
            return None

        def flush_pending(self) -> None:
            self.flushed = True

        def request_stop(self) -> None:
            self.stopped = True

        def close(self, timeout: float = 5.0) -> None:
            self.closed = True

    class _FakeRuntime:
        def __init__(self) -> None:
            self.pipeline = types.SimpleNamespace(
                vae=types.SimpleNamespace(stem=types.SimpleNamespace(stride=2))
            )
            self.output_quality = 60
            self.lossless_output = False

        @classmethod
        def load(cls, dit_ckpt: str | None, **kwargs: Any) -> _FakeRuntime:
            load_calls.append({"dit_ckpt": dit_ckpt, **kwargs})
            return cls()

        def create_v2v_session(
            self,
            prompt: str,
            *,
            settings: _StreamingSettings,
            ref_image: Any = None,
        ) -> _FakeInnerSession:
            return _FakeInnerSession(prompt, settings, ref_image)

    def _snap_to_align(val: int, align: int) -> int:
        return max(align, (val + align // 2) // align * align)

    fake_modules = {
        "xvideo": _make_module("xvideo"),
        "xvideo.inductor_autotune_fix": _make_module(
            "xvideo.inductor_autotune_fix",
            install=lambda: None,
        ),
        "xvideo.serving": _make_module("xvideo.serving"),
        "xvideo.serving.joyomni_streaming": _make_module(
            "xvideo.serving.joyomni_streaming",
            StreamingSettings=_StreamingSettings,
            JoyOmniRuntime=_FakeRuntime,
        ),
        "xvideo.serving.serve_joyomni_streaming": _make_module(
            "xvideo.serving.serve_joyomni_streaming",
            _snap_to_align=_snap_to_align,
        ),
    }
    for mod_name, mod_obj in fake_modules.items():
        monkeypatch.setitem(sys.modules, mod_name, mod_obj)

    settings = EngineSettings(
        backend="gpu",
        enable_voice=False,
        enable_video=True,
        warmup_on_startup=True,
        video_max_inflight_chunks=2,
    )
    pipe = JoyAIVideoPipeline(settings)
    pipe.warmup()
    assert len(load_calls) == 1
    assert load_calls[0]["warmup_width"] == 840
    assert load_calls[0]["warmup_height"] == 480

    ref_img = Image.new("RGB", (32, 32), color=(255, 0, 0))
    cfg = VideoSessionConfig(
        prompt="Wear silver armor",
        input_codec="mjpeg",
        output_codec="mjpeg",
        width=841,
        height=479,
    )
    sess = pipe.create_session(cfg, ref_img)
    assert isinstance(sess, JoyAIVideoSession)
    inner1 = created_sessions[-1]
    assert inner1.prompt == "Wear silver armor"
    # stride=2 -> align=16 -> 841 snaps to 848, 479 snaps to 480
    assert inner1.settings.width == 848
    assert inner1.settings.height == 480

    buf = io.BytesIO()
    Image.new("RGB", (64, 48), color=(0, 255, 0)).save(buf, format="JPEG")
    jpg_bytes = buf.getvalue()

    # Verify backpressure drop
    inner1.inflight = 2
    evt_drop = sess.push_frame(
        VideoFrameIn(jpg_bytes, VideoCodec.MJPEG, seq=1, pts_us=180_000, flags=FrameFlags.NONE)
    )
    assert (
        evt_drop is not None
        and evt_drop.event_type == "dropped"
        and evt_drop.reason == "backpressure"
    )

    # Normal push
    inner1.inflight = 0
    evt_ok = sess.push_frame(
        VideoFrameIn(jpg_bytes, VideoCodec.MJPEG, seq=2, pts_us=200_000, flags=FrameFlags.NONE)
    )
    assert evt_ok is None
    assert len(inner1.pushed) == 1
    first_meta = inner1.pushed[0][1]
    assert first_meta is not None and first_meta["pts_us"] == 200_000

    # Poll MJPEG results with valid_count truncation
    inner1.results.append(
        _FakeChunkResult(
            jpegs=[b"\xff\xd8\xffa", b"\xff\xd8\xffb", b"\xff\xd8\xffpad"],
            source_metas=[{"pts_us": 200_000}, {"pts_us": 240_000}, {"pts_us": 280_000}],
            valid_count=2,
        )
    )
    mjpeg_outs = sess.poll_outputs(timeout=0.01)
    assert len(mjpeg_outs) == 2
    assert [f.pts_us for f in mjpeg_outs] == [200_000, 240_000]
    assert mjpeg_outs[-1].flags & FrameFlags.END_OF_CHUNK

    # Hot-swap config and verify replaced session's "stopped" error is swallowed cleanly
    sess.update_config(
        VideoSessionConfig(prompt="Cyberpunk cloak", input_codec="mjpeg", output_codec="mjpeg"),
        None,
    )
    assert inner1.stopped is True and inner1.closed is True
    inner2 = created_sessions[-1]
    assert inner2 is not inner1

    class _RaceSwapSession(_FakeInnerSession):
        def wait_async_result(self, timeout: float = 0.05) -> Any | None:
            sess._session = inner2
            raise RuntimeError("streaming session stopped")

    race_sess = _RaceSwapSession("old", _StreamingSettings(), None)
    sess._session = race_sess
    assert sess.poll_outputs(timeout=0.01) == []
    assert sess._session is inner2

    # Unexpected error on current active session must still propagate
    inner2.raise_on_wait = RuntimeError("unexpected cuda fault")
    with pytest.raises(RuntimeError, match="unexpected cuda fault"):
        sess.poll_outputs(timeout=0.01)
    inner2.raise_on_wait = None

    sess.close()
    assert inner2.stopped is True and inner2.closed is True


def test_seedvc_dac_shim_and_weights_only_checkpoint_loader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify dac shim registers VectorQuantize and checkpoints use weights_only=False."""
    for name in ("dac", "dac.nn", "dac.nn.quantize"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr("importlib.util.find_spec", lambda name: None)

    _ensure_dac_importable()
    assert "dac.nn.quantize" in sys.modules
    dac_quant: Any = sys.modules["dac.nn.quantize"]
    with pytest.raises(ImportError, match="descript-audio-codec"):
        dac_quant.VectorQuantize(384, 1024, 8)

    load_kwargs: list[dict[str, Any]] = []

    class _FakeSubmodule:
        def __init__(self, expected: dict[str, Any]) -> None:
            self._expected = expected
            self.loaded: dict[str, Any] = {}
            self.eval_called = False

        def state_dict(self) -> dict[str, Any]:
            return self._expected

        def load_state_dict(self, state: dict[str, Any], strict: bool = True) -> None:
            self.loaded = state

        def eval(self) -> None:
            self.eval_called = True

    class _FakeTorch:
        @staticmethod
        def load(path: str, map_location: str = "cpu", **kwargs: Any) -> Any:
            load_kwargs.append({"path": path, "map_location": map_location, **kwargs})
            return {
                "net": {
                    "cfm": {
                        "module.weight": np.zeros((4, 4), dtype=np.float32),
                        "wrong_shape": np.zeros((99, 99), dtype=np.float32),
                    }
                }
            }

    state = _torch_load_compat(_FakeTorch, "/tmp/ckpt.pth")
    assert "net" in state
    assert load_kwargs[0]["weights_only"] is False

    cfm = _FakeSubmodule(
        {"weight": np.zeros((4, 4), dtype=np.float32), "wrong_shape": np.zeros((2, 2))}
    )
    _load_seedvc_checkpoint(_FakeTorch, {"cfm": cfm}, "/tmp/ckpt.pth")
    assert cfm.eval_called is True
    assert list(cfm.loaded.keys()) == ["weight"]


def test_seedvc_warmup_exercises_infer_window_and_vocoder_runs_outside_autocast(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Verify SeedVCVoicePipeline warmup executes full DiT/HiFT pass and keeps HiFT in float32."""
    monkeypatch.setattr(sys, "path", list(sys.path))

    state: dict[str, Any] = {
        "autocast_depth": 0,
        "cfm_calls": 0,
        "hift_autocast_depths": [],
        "hift_dtypes": [],
    }

    class _FakeTensor:
        def __init__(self, data: np.ndarray) -> None:
            self.arr = np.asarray(data)

        @property
        def shape(self) -> tuple[int, ...]:
            return self.arr.shape

        @property
        def dtype(self) -> np.dtype[Any]:
            return self.arr.dtype

        @property
        def device(self) -> str:
            return "cpu"

        def size(self, dim: int | None = None) -> Any:
            return self.arr.shape if dim is None else self.arr.shape[dim]

        def numel(self) -> int:
            return int(self.arr.size)

        def item(self) -> builtins.float | int:
            return self.arr.item()

        def to(self, *args: Any, **kwargs: Any) -> _FakeTensor:
            return self

        def half(self) -> _FakeTensor:
            return _FakeTensor(self.arr.astype(np.float16))

        def float(self) -> _FakeTensor:
            return _FakeTensor(self.arr.astype(np.float32))

        def cpu(self) -> _FakeTensor:
            return self

        def numpy(self) -> np.ndarray:
            return self.arr

        def clone(self) -> _FakeTensor:
            return _FakeTensor(self.arr.copy())

        def detach(self) -> _FakeTensor:
            return self

        def squeeze(self, dim: int | None = None) -> _FakeTensor:
            return _FakeTensor(
                np.squeeze(self.arr) if dim is None else np.squeeze(self.arr, axis=dim)
            )

        def unsqueeze(self, dim: int) -> _FakeTensor:
            return _FakeTensor(np.expand_dims(self.arr, axis=dim))

        def mean(self, dim: int | None = None, keepdim: bool = False) -> _FakeTensor:
            return _FakeTensor(self.arr.mean(axis=dim, keepdims=keepdim))

        def __len__(self) -> int:
            return int(self.arr.shape[0])

        def __getitem__(self, idx: Any) -> _FakeTensor:
            return _FakeTensor(self.arr[idx])

        def __setitem__(self, idx: Any, value: Any) -> None:
            val_arr = value.arr if isinstance(value, _FakeTensor) else value
            self.arr[idx] = val_arr

        def __mul__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            return _FakeTensor(self.arr * rhs)

        def __rmul__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            return _FakeTensor(rhs * self.arr)

        def __imul__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            self.arr *= rhs
            return self

        def __truediv__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            return _FakeTensor(self.arr / rhs)

        def __add__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            return _FakeTensor(self.arr + rhs)

        def __radd__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            return _FakeTensor(rhs + self.arr)

        def __iadd__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            self.arr += rhs
            return self

        def __sub__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            return _FakeTensor(self.arr - rhs)

        def __rsub__(self, other: Any) -> _FakeTensor:
            rhs = other.arr if isinstance(other, _FakeTensor) else other
            return _FakeTensor(rhs - self.arr)

        def __pow__(self, other: Any) -> _FakeTensor:
            return _FakeTensor(self.arr**other)

    class _Ctx:
        def __init__(self, track_autocast: bool = False) -> None:
            self._track = track_autocast

        def __enter__(self) -> None:
            if self._track:
                state["autocast_depth"] += 1

        def __exit__(self, *args: object) -> None:
            if self._track:
                state["autocast_depth"] -= 1

    class _FakeDevice:
        def __init__(self, spec: str) -> None:
            self.type = "cuda" if "cuda" in spec else "cpu"

    class _FakeCuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def Stream(device: Any = None) -> object:
            return object()

        @staticmethod
        def stream(_s: Any) -> _Ctx:
            return _Ctx()

    fake_torch = _make_module(
        "torch",
        float16=np.float16,
        float32=np.float32,
        cuda=_FakeCuda,
        device=_FakeDevice,
        no_grad=lambda: _Ctx(),
        inference_mode=lambda: _Ctx(),
        autocast=lambda **kw: _Ctx(track_autocast=True),
        zeros=lambda *s, **kw: _FakeTensor(np.zeros(s if len(s) > 1 else s[0], dtype=np.float32)),
        zeros_like=lambda t: _FakeTensor(np.zeros_like(t.arr)),
        ones=lambda *s, **kw: _FakeTensor(np.ones(s, dtype=np.float32)),
        linspace=lambda a, b, steps=10, **kw: _FakeTensor(
            np.linspace(a, b, steps, dtype=np.float32)
        ),
        sin=lambda t: _FakeTensor(np.sin(t.arr).astype(np.float32)),
        from_numpy=lambda arr: _FakeTensor(np.array(arr, dtype=np.float32)),
        LongTensor=lambda vals: _FakeTensor(np.asarray(vals, dtype=np.int64)),
        cat=lambda ts, dim=0: _FakeTensor(np.concatenate([t.arr for t in ts], axis=dim)),
        sqrt=lambda t: _FakeTensor(np.sqrt(t.arr).astype(np.float32)),
        argmax=lambda t, dim=0: _FakeTensor(np.asarray(np.argmax(t.arr, axis=dim))),
        load=lambda path, **kw: {"net": {}},
    )

    def _conv1d(inp: _FakeTensor, weight: _FakeTensor) -> _FakeTensor:
        out_len = max(1, inp.shape[-1] - weight.shape[-1] + 1)
        return _FakeTensor(np.ones((1, 1, out_len), dtype=np.float32))

    def _pad(t: _FakeTensor, pad_spec: tuple[int, int]) -> _FakeTensor:
        return _FakeTensor(np.pad(t.arr, pad_spec))

    fake_f = _make_module("torch.nn.functional", conv1d=_conv1d, pad=_pad)

    def _resample_np(t: _FakeTensor, orig_freq: int, new_freq: int) -> _FakeTensor:
        arr = t.arr
        n_in = arr.shape[-1]
        n_out = max(1, round(n_in * builtins.float(new_freq) / builtins.float(orig_freq)))
        out = np.zeros((*arr.shape[:-1], n_out), dtype=np.float32) + 0.01
        return _FakeTensor(out)

    class _ResampleTransform:
        def __init__(self, orig_freq: int, new_freq: int, dtype: Any = None) -> None:
            self.orig_freq = orig_freq
            self.new_freq = new_freq

        def to(self, _dev: Any) -> _ResampleTransform:
            return self

        def __call__(self, t: _FakeTensor) -> _FakeTensor:
            return _resample_np(t, self.orig_freq, self.new_freq)

    fake_torchaudio = _make_module(
        "torchaudio",
        functional=types.SimpleNamespace(resample=_resample_np),
        transforms=types.SimpleNamespace(Resample=_ResampleTransform),
        compliance=types.SimpleNamespace(
            kaldi=types.SimpleNamespace(
                fbank=lambda w, **kw: _FakeTensor(np.ones((10, 80), dtype=np.float32))
            )
        ),
    )

    class _Munch(dict):
        def __getattr__(self, name: str) -> Any:
            return self[name]

        def __setattr__(self, name: str, value: Any) -> None:
            self[name] = value

    def _to_munch(obj: Any) -> Any:
        if isinstance(obj, dict):
            return _Munch((k, _to_munch(v)) for k, v in obj.items())
        if isinstance(obj, list):
            return [_to_munch(v) for v in obj]
        return obj

    class _FakeEstimator:
        def setup_caches(self, max_batch_size: int, max_seq_length: int) -> None:
            pass

    class _FakeCFM:
        def __init__(self) -> None:
            self.estimator = _FakeEstimator()

        def state_dict(self) -> dict[str, Any]:
            return {}

        def load_state_dict(self, *_a: Any, **_kw: Any) -> None:
            pass

        def eval(self) -> _FakeCFM:
            return self

        def to(self, _d: Any) -> _FakeCFM:
            return self

        def inference(
            self,
            mu: _FakeTensor,
            _x_lens: _FakeTensor,
            mel2: _FakeTensor,
            _style: _FakeTensor,
            _f0: Any,
            *,
            n_timesteps: int,
            inference_cfg_rate: builtins.float,
        ) -> _FakeTensor:
            state["cfm_calls"] += 1
            state.setdefault("diffusion_steps", []).append(n_timesteps)
            state.setdefault("cfg_rates", []).append(inference_cfg_rate)
            total_mel_frames = mu.shape[1]
            # Simulate flow matching producing fp16 inside autocast
            return _FakeTensor(np.zeros((1, 80, total_mel_frames), dtype=np.float16))

    class _FakeRegulator:
        def state_dict(self) -> dict[str, Any]:
            return {}

        def load_state_dict(self, *_a: Any, **_kw: Any) -> None:
            pass

        def eval(self) -> _FakeRegulator:
            return self

        def to(self, _d: Any) -> _FakeRegulator:
            return self

        def __call__(
            self, s_tok: _FakeTensor, ylens: _FakeTensor, **_kw: Any
        ) -> tuple[_FakeTensor]:
            t_len = int(ylens.arr[0])
            return (_FakeTensor(np.zeros((1, t_len, 384), dtype=np.float32)),)

    class _FakeCAMPPlus:
        def __init__(self, **_kw: Any) -> None:
            pass

        def load_state_dict(self, *_a: Any) -> None:
            pass

        def eval(self) -> _FakeCAMPPlus:
            return self

        def to(self, _d: Any) -> _FakeCAMPPlus:
            return self

        def __call__(self, _feat: _FakeTensor) -> _FakeTensor:
            return _FakeTensor(np.ones((1, 192), dtype=np.float32))

    class _FakeHiFT:
        def __init__(self, **_kw: Any) -> None:
            pass

        def load_state_dict(self, *_a: Any) -> None:
            pass

        def eval(self) -> _FakeHiFT:
            return self

        def to(self, _d: Any) -> _FakeHiFT:
            return self

        def __call__(self, mel: _FakeTensor) -> _FakeTensor:
            state["hift_autocast_depths"].append(state["autocast_depth"])
            state["hift_dtypes"].append(mel.dtype)
            n_samples = round(mel.shape[2] * 256) + 512
            return _FakeTensor(np.full((1, n_samples), 0.1, dtype=np.float32))

    def _safe_load(fh: Any) -> dict[str, Any]:
        name = getattr(fh, "name", "")
        if "hifigan" in name:
            return {"hift": {"sampling_rate": 22050}, "f0_predictor": {}}
        return {
            "preprocess_params": {
                "sr": 22050,
                "spect_params": {
                    "n_fft": 1024,
                    "win_length": 1024,
                    "hop_length": 256,
                    "n_mels": 80,
                    "fmin": 0,
                    "fmax": 8000,
                },
            },
            "model_params": {
                "vocoder": {"type": "hifigan"},
                "speech_tokenizer": {
                    "type": "xlsr",
                    "name": "facebook/wav2vec2-xls-r-300m",
                    "output_layer": 12,
                },
            },
        }

    def _hf_download(
        *,
        repo_id: str,
        filename: str,
        local_dir: str | None = None,
        cache_dir: str | None = None,
        force_download: bool = False,
    ) -> str:
        base = local_dir or cache_dir or str(tmp_path)
        out = Path(base) / filename
        out.parent.mkdir(parents=True, exist_ok=True)
        if force_download or not out.is_file():
            out.write_bytes(b"ckpt")
        return str(out)

    class _FakeW2V:
        def __init__(self) -> None:
            self.encoder = types.SimpleNamespace(layers=list(range(24)))

        def to(self, _d: Any) -> _FakeW2V:
            return self

        def eval(self) -> _FakeW2V:
            return self

        def half(self) -> _FakeW2V:
            return self

        def __call__(self, inp: _FakeTensor) -> Any:
            n_frames = max(1, inp.shape[-1] // 320)
            return types.SimpleNamespace(
                last_hidden_state=_FakeTensor(
                    np.zeros((inp.shape[0], n_frames, 1024), dtype=np.float32)
                )
            )

    fake_modules = {
        "torch": fake_torch,
        "torch.nn.functional": fake_f,
        "torchaudio": fake_torchaudio,
        "yaml": _make_module("yaml", safe_load=_safe_load),
        "huggingface_hub": _make_module("huggingface_hub", hf_hub_download=_hf_download),
        "transformers": _make_module(
            "transformers",
            Wav2Vec2FeatureExtractor=types.SimpleNamespace(
                from_pretrained=lambda _name: (
                    lambda lst, **_kw: types.SimpleNamespace(
                        input_values=_FakeTensor(np.asarray(lst, dtype=np.float32)),
                        to=lambda _d: types.SimpleNamespace(
                            input_values=_FakeTensor(np.asarray(lst, dtype=np.float32))
                        ),
                    )
                )
            ),
            Wav2Vec2Model=types.SimpleNamespace(from_pretrained=lambda _name: _FakeW2V()),
        ),
        "modules": _make_module("modules"),
        "modules.commons": _make_module(
            "modules.commons",
            recursive_munch=_to_munch,
            build_model=lambda _p, stage="DiT": _Munch(
                cfm=_FakeCFM(),
                length_regulator=_FakeRegulator(),
            ),
        ),
        "modules.audio": _make_module(
            "modules.audio",
            mel_spectrogram=lambda x, **kw: _FakeTensor(
                np.zeros((x.shape[0], 80, max(1, x.shape[-1] // kw["hop_size"])), dtype=np.float32)
            ),
        ),
        "modules.campplus": _make_module("modules.campplus"),
        "modules.campplus.DTDNN": _make_module("modules.campplus.DTDNN", CAMPPlus=_FakeCAMPPlus),
        "modules.hifigan": _make_module("modules.hifigan"),
        "modules.hifigan.generator": _make_module(
            "modules.hifigan.generator", HiFTGenerator=_FakeHiFT
        ),
        "modules.hifigan.f0_predictor": _make_module(
            "modules.hifigan.f0_predictor",
            ConvRNNF0Predictor=lambda **_kw: object(),
        ),
    }
    for mod_name, mod_obj in fake_modules.items():
        monkeypatch.setitem(sys.modules, mod_name, mod_obj)
    for dac_name in ("dac", "dac.nn", "dac.nn.quantize"):
        monkeypatch.delitem(sys.modules, dac_name, raising=False)

    settings = EngineSettings(
        backend="gpu",
        enable_voice=True,
        enable_video=False,
        warmup_on_startup=True,
        voice_cache_dir=str(tmp_path / "seedvc_cache"),
    )
    pipe = SeedVCVoicePipeline(settings)
    pipe.warmup()

    # Warmup runs fast 2-step cfm.inference + HiFT outside autocast with fp32 mel, then clears ref
    assert state["cfm_calls"] == 1
    assert state["diffusion_steps"] == [2]
    assert state["cfg_rates"] == [0.7]
    assert state["hift_autocast_depths"] == [0]
    assert state["hift_dtypes"] == [np.float32]
    assert pipe.has_reference_audio is False

    # Exercise live session: silence gate, passthrough, live conversion + flush
    sess = pipe.create_session(AudioSessionConfig(vad_threshold_db=-40.0))
    pipe.set_reference_audio(np.ones(22050, dtype=np.float32) * 0.1, 22050)
    assert pipe.has_reference_audio is True

    # Silent chunk (320ms = 16 * 441 = 7056 samples) -> VAD marks SILENCE without running cfm
    silent_outs = sess.push_audio(
        AudioChunkIn(
            samples=np.zeros(7056, dtype=np.float32),
            sample_rate=22050,
            codec=AudioCodec.PCM_S16LE,
            seq=1,
            pts_us=0,
        )
    )
    assert len(silent_outs) == 1
    assert bool(silent_outs[0].flags & FrameFlags.SILENCE) is True
    assert state["cfm_calls"] == 1

    # Voiced chunk -> runs infer_window with balanced 20 steps + HiFT outside autocast
    voiced = (0.2 * np.sin(2.0 * np.pi * 220.0 * np.arange(7056) / 22050.0)).astype(np.float32)
    voiced_outs = sess.push_audio(
        AudioChunkIn(
            samples=voiced,
            sample_rate=22050,
            codec=AudioCodec.PCM_S16LE,
            seq=2,
            pts_us=320_000,
        )
    )
    assert len(voiced_outs) == 1
    assert bool(voiced_outs[0].flags & FrameFlags.SPEECH_ACTIVE) is True
    assert state["cfm_calls"] == 2
    assert state["diffusion_steps"] == [2, 20]
    assert state["hift_autocast_depths"] == [0, 0]
    assert state["hift_dtypes"] == [np.float32, np.float32]

    sess.close()
    pipe.close()


def test_seedvc_checkpoint_loader_recovers_from_corrupted_volume_file(tmp_path: Path) -> None:
    """When a cached checkpoint on a shared/global volume raises EOFError, retry via local temp."""
    from metamorph_engine.pipelines.voice_seedvc import _load_torch_hf_checkpoint

    volume_dir = tmp_path / "global_volume"
    volume_dir.mkdir(parents=True, exist_ok=True)
    corrupted = volume_dir / "DiT_uvit_tat_xlsr_ema.pth"
    corrupted.write_bytes(b"truncated")

    calls: list[tuple[str, bool]] = []

    class _FakeHfHub:
        @staticmethod
        def hf_hub_download(
            *,
            repo_id: str,
            filename: str,
            local_dir: str,
            force_download: bool = False,
        ) -> str:
            calls.append((local_dir, force_download))
            out = Path(local_dir) / filename
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"valid-checkpoint-bytes")
            return str(out)

    class _FakeTorch:
        @staticmethod
        def load(
            path: str, map_location: str = "cpu", weights_only: bool = False
        ) -> dict[str, Any]:
            if Path(path).read_bytes() != b"valid-checkpoint-bytes":
                raise EOFError("Ran out of input")
            return {"net": {"ok": True}}

    loaded = _load_torch_hf_checkpoint(
        _FakeTorch,
        _FakeHfHub,
        repo_id="Plachta/Seed-VC",
        filename="DiT_uvit_tat_xlsr_ema.pth",
        cache_dir=str(volume_dir),
        label="Seed-VC DiT checkpoint",
    )

    assert loaded == {"net": {"ok": True}}
    assert len(calls) == 1
    assert calls[0][1] is True
    assert corrupted.read_bytes() == b"valid-checkpoint-bytes"


def test_soft_limit_audio_transparent_below_threshold_and_bounds_peaks() -> None:
    """Verify soft_limit_audio preserves normal speech levels and smoothly caps hot peaks."""
    from metamorph_engine.pipelines.base import soft_limit_audio

    quiet = np.array([-0.85, -0.2, 0.0, 0.4, 0.9], dtype=np.float32)
    np.testing.assert_allclose(soft_limit_audio(quiet), quiet, atol=1e-7)

    hot = np.array([-2.5, -1.2, -0.5, 0.0, 0.5, 1.2, 2.5], dtype=np.float32)
    limited = soft_limit_audio(hot, threshold=0.9, ceiling=0.98)
    assert limited.dtype == np.float32
    np.testing.assert_allclose(limited[2:5], hot[2:5], atol=1e-7)
    assert float(np.max(np.abs(limited))) < 0.98
    assert float(limited[0]) < float(limited[1]) < -0.9
    assert 0.9 < float(limited[5]) < float(limited[6]) < 0.98


def test_prepare_reference_audio_trims_silence_removes_dc_and_normalizes() -> None:
    """Reference conditioning trims dead edges before capping length and normalizes quiet clips."""
    from metamorph_engine.pipelines.base import prepare_reference_audio

    sr = 22050
    lead_silence = np.zeros(sr * 2, dtype=np.float32)
    t = np.arange(sr * 2, dtype=np.float32) / float(sr)
    # Quiet -26 dBFS speech with +0.05 DC bias
    speech = (0.05 * np.sin(2.0 * np.pi * 220.0 * t) + 0.05).astype(np.float32)
    trail_silence = np.zeros(sr * 2, dtype=np.float32)
    raw = np.concatenate([lead_silence, speech, trail_silence])

    cleaned = prepare_reference_audio(raw, sr, max_duration_s=3.0)
    # Leading/trailing 2s silence trimmed down to ~2s + 0.1s padding, leaving full speech intact
    assert 1.9 * sr <= cleaned.shape[0] <= 2.2 * sr
    # DC offset removed & normalized to ~-1 dBFS (0.891)
    assert abs(float(np.mean(cleaned))) < 0.02
    assert 0.85 <= float(np.max(np.abs(cleaned))) <= 0.91


def test_voice_engine_defaults_favor_high_clarity() -> None:
    """Verify balanced 20-step Seed-VC & fast startup parameters stay internally consistent."""
    settings = EngineSettings()
    assert settings.voice_diffusion_steps == 20
    assert settings.voice_warmup_diffusion_steps == 2
    assert settings.voice_parallel_load is True
    assert settings.voice_cfg_rate == 0.7
    assert settings.voice_max_prompt_length_s == 8.0
    assert settings.voice_extra_context_left_s == 3.0
    assert settings.voice_extra_dit_context_left_s == 1.5
    assert settings.voice_extra_context_right_s == 0.12
    assert settings.voice_crossfade_s == 0.08
    assert settings.voice_block_time_s == 0.32
    assert settings.voice_vad_hangover_s == 0.5
    assert settings.voice_vad_threshold_db == -48.0
    assert settings.video_compile_mode == "auto"
    assert settings.video_warmup_both_orientations is False
    assert settings.video_skip_ref_image_compile is True
    assert settings.video_persist_compile_cache is True

    session_cfg = AudioSessionConfig()
    assert session_cfg.diffusion_steps == settings.voice_diffusion_steps
    assert session_cfg.cfg_rate == settings.voice_cfg_rate
    assert session_cfg.block_time_s == settings.voice_block_time_s
    assert session_cfg.vad_threshold_db == settings.voice_vad_threshold_db


def test_joyai_detects_fuse_mount_and_disables_mmap_safely(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """FUSE/network volumes disable DiT mmap (via temporary SPACE_ID) to avoid multi-hour stalls."""
    from metamorph_engine.pipelines.video_joyai import (
        _is_network_or_fuse_path,
        _should_disable_dit_mmap,
    )

    mounts = tmp_path / "mounts"
    mounts.write_text(
        "/dev/nvme0n1p1 / ext4 rw,relatime 0 0\n"
        "runpod-global /models fuse.s3fs rw,nosuid,nodev 0 0\n",
        encoding="utf-8",
    )
    assert _is_network_or_fuse_path("/models/checkpoints/dit.pth", mounts_file=str(mounts)) is True
    assert _is_network_or_fuse_path("/tmp/dit.pth", mounts_file=str(mounts)) is False

    monkeypatch.setenv("RUNPOD_POD_ID", "pod-abc")
    assert _should_disable_dit_mmap("/models/checkpoints/dit.pth", "auto") is True
    assert _should_disable_dit_mmap("/models/checkpoints/dit.pth", "false") is False
    assert _should_disable_dit_mmap("/tmp/dit.pth", "true") is True
    assert _should_disable_dit_mmap("/tmp/dit.pth", "auto") is False


def test_seedvc_load_xlsr_short_circuits_local_and_prefers_pruned_fp16(tmp_path: Path) -> None:
    """Local XLSR directories must bypass HuggingFace snapshot_download and prefer pruned fp16."""
    from metamorph_engine.pipelines.voice_seedvc import _load_xlsr_model

    cache_dir = tmp_path / "seedvc"
    raw_dir = cache_dir / "facebook__wav2vec2-xls-r-300m"
    pruned_dir = cache_dir / "facebook__wav2vec2-xls-r-300m-l12-fp16"
    for d in (raw_dir, pruned_dir):
        d.mkdir(parents=True)
        (d / "config.json").write_text("{}", encoding="utf-8")
        (d / "model.safetensors").write_bytes(b"weights")

    snapshot_calls: list[dict[str, Any]] = []
    feat_calls: list[tuple[str, dict[str, Any]]] = []
    model_calls: list[tuple[str, dict[str, Any]]] = []

    fake_hf = _make_module(
        "huggingface_hub",
        snapshot_download=lambda **kw: snapshot_calls.append(kw),
    )
    fake_tf = _make_module(
        "transformers",
        Wav2Vec2FeatureExtractor=types.SimpleNamespace(
            from_pretrained=lambda src, **kw: (feat_calls.append((src, kw)), "feat")[1]
        ),
        Wav2Vec2Model=types.SimpleNamespace(
            from_pretrained=lambda src, **kw: (model_calls.append((src, kw)), "w2v")[1]
        ),
    )

    feat, w2v = _load_xlsr_model(
        fake_tf,
        fake_hf,
        model_name="facebook/wav2vec2-xls-r-300m",
        cache_dir=str(cache_dir),
        output_layer=12,
        torch_dtype="fp16_sentinel",
    )
    assert (feat, w2v) == ("feat", "w2v")
    assert snapshot_calls == []
    assert feat_calls == [(str(pruned_dir), {"local_files_only": True})]
    assert model_calls == [
        (str(pruned_dir), {"local_files_only": True, "torch_dtype": "fp16_sentinel"})
    ]


def test_joyai_compile_mode_resolution_and_cache_archive_persistence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Auto compile mode reuses seeded cache, tracks multi-res shapes, and tolerates tar rc=1."""
    import subprocess
    import threading

    from metamorph_engine.pipelines.video_joyai import (
        _CACHE_MODE_MARKER,
        _CACHE_SHAPES_MARKER,
        _persist_compile_cache_archive,
        _resolve_video_compile_mode,
    )

    local_cache = tmp_path / "local_cache"
    inductor_dir = local_cache / "torchinductor"
    inductor_dir.mkdir(parents=True)

    # Cold empty cache -> fast default mode
    assert _resolve_video_compile_mode("auto", cache_root=local_cache) == "default"
    assert _resolve_video_compile_mode("none", cache_root=local_cache) == "none"

    # Seeded max-autotune cache -> reuses max-autotune-no-cudagraphs
    (inductor_dir / "kernel.bin").write_bytes(b"compiled")
    (local_cache / _CACHE_MODE_MARKER).write_text("max-autotune-no-cudagraphs\n", encoding="utf-8")
    assert (
        _resolve_video_compile_mode("auto", cache_root=local_cache) == "max-autotune-no-cudagraphs"
    )

    # Persist archive with initial resolution 840x480
    vol_cache = tmp_path / "volume" / "cache" / "nvidia_rtx_5090"
    archive = _persist_compile_cache_archive(
        local_cache_root=local_cache,
        volume_cache_root=vol_cache,
        compile_mode="default",
        warmed_shapes=[(840, 480)],
    )
    assert archive is not None and archive.is_file()
    assert Path(f"{vol_cache}.compile_mode").read_text(encoding="utf-8").strip() == "default"
    assert Path(f"{vol_cache}.shapes").read_text(encoding="utf-8").splitlines() == ["840x480"]

    # Upgrading default -> max-autotune-no-cudagraphs succeeds
    upgraded = _persist_compile_cache_archive(
        local_cache_root=local_cache,
        volume_cache_root=vol_cache,
        compile_mode="max-autotune-no-cudagraphs",
        warmed_shapes=[(840, 480)],
    )
    assert upgraded is not None and upgraded.is_file()
    assert (
        Path(f"{vol_cache}.compile_mode").read_text(encoding="utf-8").strip()
        == "max-autotune-no-cudagraphs"
    )

    # Duplicate persist with same mode & subset shape is skipped
    assert (
        _persist_compile_cache_archive(
            local_cache_root=local_cache,
            volume_cache_root=vol_cache,
            compile_mode="max-autotune-no-cudagraphs",
            warmed_shapes=[(840, 480)],
        )
        is None
    )

    # New resolution in the same local cache (which retained 840x480) updates archive + .shapes
    new_shape = _persist_compile_cache_archive(
        local_cache_root=local_cache,
        volume_cache_root=vol_cache,
        compile_mode="max-autotune-no-cudagraphs",
        warmed_shapes=[(1280, 720)],
    )
    assert new_shape is not None
    assert sorted(Path(f"{vol_cache}.shapes").read_text(encoding="utf-8").splitlines()) == [
        "1280x720",
        "840x480",
    ]
    assert sorted(
        (local_cache / _CACHE_SHAPES_MARKER).read_text(encoding="utf-8").splitlines()
    ) == [
        "1280x720",
        "840x480",
    ]

    # Downgrading max-autotune-no-cudagraphs -> default with subset shapes is skipped
    downgrade = _persist_compile_cache_archive(
        local_cache_root=local_cache,
        volume_cache_root=vol_cache,
        compile_mode="default",
        warmed_shapes=[(840, 480)],
    )
    assert downgrade is None

    # force=True overwrites even when mode & shapes already match
    forced = _persist_compile_cache_archive(
        local_cache_root=local_cache,
        volume_cache_root=vol_cache,
        compile_mode="max-autotune-no-cudagraphs",
        warmed_shapes=[(1280, 720)],
        force=True,
    )
    assert forced is not None

    # GNU tar exit-code 1 (live write race) retries & succeeds; exit-code 2 fails cleanly
    real_run: Any = subprocess.run
    tar_calls = {"n": 0}

    def _flaky_tar(cmd: list[str], **kw: Any) -> Any:
        if cmd and cmd[0] == "tar":
            tar_calls["n"] += 1
            res = real_run(cmd, **{**kw, "check": False})
            if tar_calls["n"] <= 2:
                return subprocess.CompletedProcess(
                    cmd, 1, res.stdout, b"file changed as we read it"
                )
            return subprocess.CompletedProcess(cmd, 2, res.stdout, b"fatal tar error")
        return real_run(cmd, **kw)

    monkeypatch.setattr(subprocess, "run", _flaky_tar)
    rc1_ok = _persist_compile_cache_archive(
        local_cache_root=local_cache,
        volume_cache_root=vol_cache,
        compile_mode="max-autotune-no-cudagraphs",
        force=True,
    )
    assert rc1_ok is not None and tar_calls["n"] == 2
    rc2_fail = _persist_compile_cache_archive(
        local_cache_root=local_cache,
        volume_cache_root=vol_cache,
        compile_mode="max-autotune-no-cudagraphs",
        force=True,
    )
    assert rc2_fail is None

    # Pipeline.close() waits for its background persist thread
    release_bg = threading.Event()
    started_bg = threading.Event()

    def _bg_worker() -> None:
        started_bg.set()
        release_bg.wait(timeout=2.0)

    bg_thread = threading.Thread(target=_bg_worker, daemon=True)
    bg_thread.start()
    started_bg.wait(timeout=1.0)
    pipe = JoyAIVideoPipeline(EngineSettings(backend="mock"))
    pipe._persist_thread = bg_thread
    release_bg.set()
    pipe.close()
    assert bg_thread.is_alive() is False


def test_joyai_hooks_single_orientation_skip_ref_compile_and_eager_ref_encode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify compile hooks skip 49-shape dynamic warmup, portrait orientation, and double-wrap."""
    from metamorph_engine.pipelines.video_joyai import _patch_joyai_compile_and_warmup

    compile_calls: list[dict[str, Any]] = []
    decode_warmups: list[tuple[int, int]] = []
    encode_warmups: list[tuple[int, int]] = []
    dynamic_warmups: list[Any] = []
    full_warmups: list[tuple[int, int]] = []
    eager_encode_calls: list[str] = []

    class _FakeWeightData:
        def __init__(self) -> None:
            self.formats: list[Any] = []

        def to(self, **kw: Any) -> _FakeWeightData:
            self.formats.append(kw.get("memory_format"))
            return self

    class _FakeConv3d:
        def __init__(self) -> None:
            self.weight = types.SimpleNamespace(data=_FakeWeightData())

    class _FakeVAE:
        def __init__(self) -> None:
            self._conv = _FakeConv3d()

        def modules(self) -> list[Any]:
            return [self._conv]

        def _encode(self, x: Any) -> str:
            eager_encode_calls.append(f"eager:{x}")
            return f"lat:{x}"

        def _decode(self, z: Any) -> str:
            return f"dec:{z}"

    def _fake_compile(fn: Any, *, mode: str, dynamic: bool) -> Any:
        compile_calls.append({"fn": fn, "mode": mode, "dynamic": dynamic})

        def _compiled(x: Any) -> str:
            return f"compiled({mode},{dynamic}):{x}"

        return _compiled

    fake_torch = _make_module(
        "torch",
        nn=types.SimpleNamespace(Conv3d=_FakeConv3d),
        channels_last_3d="channels_last_3d",
        compile=_fake_compile,
    )
    fake_vae_mod = _make_module(
        "xvideo.models.vae.vae",
        DiagonalGaussianDistribution=lambda h: ("dist", h),
        EncoderOutput=lambda latent_dist: types.SimpleNamespace(latent_dist=latent_dist),
    )
    fake_vc = _make_module(
        "xvideo.models.vae.vae_compile",
        _configured=set(),
        _configured_encode=set(),
        _configured_encode_dynamic=set(),
        prep_input=lambda x: f"prep({x})",
        maybe_setup_decode=lambda vae: None,
        maybe_setup_encode=lambda vae: None,
        maybe_setup_encode_dynamic=lambda vae: None,
        encode_via_dynamic=lambda vae, x: "orig_dyn",
        warmup_decode=lambda vae, c, h, w, *a, **kw: decode_warmups.append((h, w)),
        warmup_encode=lambda vae, c, h, w, *a, **kw: encode_warmups.append((h, w)),
        warmup_encode_dynamic=lambda vae, c, hw, *a, **kw: dynamic_warmups.append(hw),
    )

    class _FakeRuntime:
        def warmup_full_pipeline(self, *, height: int = 720, width: int = 1248, **kw: Any) -> None:
            full_warmups.append((height, width))

    fake_streaming = _make_module("xvideo.serving.joyomni_streaming", JoyOmniRuntime=_FakeRuntime)

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "xvideo.models.vae.vae", fake_vae_mod)
    monkeypatch.setitem(sys.modules, "xvideo.models.vae.vae_compile", fake_vc)

    vae = _FakeVAE()
    rt = _FakeRuntime()

    with _patch_joyai_compile_and_warmup(
        streaming_mod=fake_streaming,
        compile_mode="default",
        warmup_height=480,
        warmup_width=840,
        warmup_both_orientations=False,
        skip_ref_image_compile=True,
    ):
        fake_vc.maybe_setup_decode(vae)
        fake_vc.maybe_setup_encode(vae)
        fake_vc.maybe_setup_encode_dynamic(vae)

        # Simulate upstream dual-orientation warmup loop
        for wh, ww in ((480, 840), (840, 480)):
            fake_vc.warmup_decode(vae, 16, wh // 16, ww // 16)
            fake_vc.warmup_encode(vae, 3, wh, ww)
            rt.warmup_full_pipeline(height=wh, width=ww)

        fake_vc.warmup_encode_dynamic(vae, 3, [(384, 1344)] * 49)

    # Compile mode must be "default" (only decode + encode, NEVER dynamic)
    assert len(compile_calls) == 2
    assert all(c["mode"] == "default" and c["dynamic"] is False for c in compile_calls)

    # Only landscape orientation ran; portrait orientation was skipped everywhere
    assert decode_warmups == [(30, 52)]
    assert encode_warmups == [(480, 840)]
    assert full_warmups == [(480, 840)]
    assert dynamic_warmups == []

    # Reference-image encode must run eager on the saved uncompiled _encode
    out = fake_vc.encode_via_dynamic(vae, "ref_img")
    assert eager_encode_calls == ["eager:prep(ref_img)"]
    assert out.latent_dist == ("dist", "lat:prep(ref_img)")


def test_joyai_fuse_safetensors_loader_disables_mmap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify FUSE safetensors patch bypasses mmap for safe_open & load_file across bindings."""
    import json
    import struct

    from metamorph_engine.pipelines.video_joyai import _patch_fuse_safetensors_loaders

    orig_calls: list[tuple[str, str]] = []
    seen_bytes_loads: list[bytes] = []

    arr = np.array([[1.5, -2.5], [3.0, 4.0]], dtype="<f4")
    raw_tensor = arr.tobytes()
    header_obj = {
        "__metadata__": {"format": "pt"},
        "w": {"dtype": "F32", "shape": [2, 2], "data_offsets": [0, len(raw_tensor)]},
    }
    header_bytes = json.dumps(header_obj).encode("utf-8")
    st_bytes = struct.pack("<Q", len(header_bytes)) + header_bytes + raw_tensor
    st_file = tmp_path / "model.safetensors"
    st_file.write_bytes(st_bytes)

    def _orig_safe_open(filename: str, framework: str = "pt", device: Any = "cpu") -> str:
        orig_calls.append((str(filename), str(device)))
        return f"mmap-open:{device}"

    def _orig_load_file(filename: str, device: Any = "cpu") -> dict[str, Any]:
        orig_calls.append((str(filename), str(device)))
        return {"via": f"mmap:{device}"}

    def _load_bytes(raw: bytes) -> dict[str, Any]:
        seen_bytes_loads.append(raw)
        h_len = struct.unpack("<Q", raw[:8])[0]
        hdr = json.loads(raw[8 : 8 + h_len].decode("utf-8"))
        payload = raw[8 + h_len :]
        out: dict[str, Any] = {}
        for k, meta in hdr.items():
            if k == "__metadata__":
                continue
            lo, hi = meta["data_offsets"]
            out[k] = np.frombuffer(payload[lo:hi], dtype="<f4").reshape(meta["shape"]).copy()
        return out

    fake_st = _make_module("safetensors", safe_open=_orig_safe_open)
    fake_st_torch = _make_module("safetensors.torch", load_file=_orig_load_file, load=_load_bytes)
    fake_tf_mu = _make_module("transformers.modeling_utils", safe_open=_orig_safe_open)
    fake_tf_core = _make_module("transformers.core_model_loading", safe_open=_orig_safe_open)
    fake_df_mu = _make_module("diffusers.models.modeling_utils", safe_open=_orig_safe_open)
    fake_tf = _make_module(
        "transformers", modeling_utils=fake_tf_mu, core_model_loading=fake_tf_core
    )
    fake_df = _make_module("diffusers", models=_make_module("diffusers.models"))

    for mod_name, mod_obj in (
        ("safetensors", fake_st),
        ("safetensors.torch", fake_st_torch),
        ("transformers", fake_tf),
        ("transformers.modeling_utils", fake_tf_mu),
        ("transformers.core_model_loading", fake_tf_core),
        ("diffusers", fake_df),
        ("diffusers.models", fake_df.models),
        ("diffusers.models.modeling_utils", fake_df_mu),
    ):
        monkeypatch.setitem(sys.modules, mod_name, mod_obj)

    with _patch_fuse_safetensors_loaders(disable_mmap=True, mmap_setting="true"):
        # Header-only inspection via transformers binding must NOT read full payload prematurely
        with fake_tf_mu.safe_open(str(st_file), framework="pt", device="cpu") as f:
            assert f.keys() == ["w"]
            assert f.metadata() == {"format": "pt"}
            slc = f.get_slice("w")
            assert slc.get_shape() == [2, 2]
            assert slc.get_dtype() == "F32"
            assert seen_bytes_loads == []
            np.testing.assert_allclose(slc[0], arr[0])
            np.testing.assert_allclose(f.get_tensor("w"), arr)

        # Diffusers module binding also uses sequential buffered reader
        with fake_df_mu.safe_open(str(st_file), framework="pt", device="cpu") as f2:
            np.testing.assert_allclose(f2.get_tensor("w"), arr)

        assert orig_calls == []
        loaded_cpu = fake_st_torch.load_file(str(st_file), device="cpu")
        np.testing.assert_allclose(loaded_cpu["w"], arr)
        assert len(seen_bytes_loads) == 3

        # Non-CPU device falls through to orig_safe_open / orig_load_file
        assert (
            fake_st.safe_open(str(st_file), framework="pt", device="cuda:0") == "mmap-open:cuda:0"
        )
        assert fake_st_torch.load_file(str(st_file), device="cuda:0") == {"via": "mmap:cuda:0"}

    # Originals restored on context exit across every module
    assert fake_st.safe_open is _orig_safe_open
    assert fake_tf_mu.safe_open is _orig_safe_open
    assert fake_tf_core.safe_open is _orig_safe_open
    assert fake_df_mu.safe_open is _orig_safe_open
    assert fake_st_torch.load_file is _orig_load_file


def test_seedvc_librosa_mel_shim_produces_slaney_filterbank(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify pure-NumPy librosa.filters.mel shim works without librosa installed."""
    from metamorph_engine.pipelines.voice_seedvc import _ensure_librosa_importable

    for name in ("librosa", "librosa.filters"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr("importlib.util.find_spec", lambda name: None)

    _ensure_librosa_importable()
    assert "librosa.filters" in sys.modules
    librosa_filters: Any = sys.modules["librosa.filters"]

    mel_8k = librosa_filters.mel(sr=22050, n_fft=1024, n_mels=80, fmin=0, fmax=8000)
    assert mel_8k.shape == (80, 513)
    assert mel_8k.dtype == np.float32
    assert np.all(mel_8k >= 0.0)
    assert np.all(mel_8k.sum(axis=1) > 0.0)
    # Bins strictly above fmax=8000 Hz (bin index > 8000 / (22050 / 1024) ~= 371.5) must be zero
    assert np.all(mel_8k[:, 380:] == 0.0)

    mel_nyq = librosa_filters.mel(sr=22050, n_fft=1024, n_mels=80, fmin=0, fmax=None)
    assert mel_nyq.shape == (80, 513)
    assert mel_nyq.dtype == np.float32
    assert np.all(mel_nyq.sum(axis=1) > 0.0)


def test_optimize_voice_checkpoints_converts_floats_and_strips_training_keys(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify optimize_voice_checkpoints.py casts floats to fp16 and keeps only net in DiT."""
    import importlib.util

    script_path = REPO_ROOT / "apps" / "engine-py" / "scripts" / "optimize_voice_checkpoints.py"
    spec = importlib.util.spec_from_file_location("optimize_voice_checkpoints", script_path)
    assert spec is not None and spec.loader is not None
    opt_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(opt_mod)

    class _FakeTensor:
        def __init__(self, arr: np.ndarray) -> None:
            self.arr = arr

        def is_floating_point(self) -> bool:
            return np.issubdtype(self.arr.dtype, np.floating)

        def to(self, *, dtype: Any) -> _FakeTensor:
            return _FakeTensor(self.arr.astype(dtype))

    dit_path = tmp_path / "DiT_uvit_tat_xlsr_ema.pth"
    hift_path = tmp_path / "hift.pt"
    dit_path.write_bytes(b"placeholder-dit")
    hift_path.write_bytes(b"placeholder-hift")

    stored: dict[str, Any] = {
        str(dit_path): {
            "net": {
                "cfm": {
                    "weight": _FakeTensor(np.ones((2, 2), dtype=np.float32)),
                    "step": _FakeTensor(np.array([42], dtype=np.int64)),
                }
            },
            "optimizer": {"lr": _FakeTensor(np.array([1e-4], dtype=np.float32))},
            "epoch": 100,
        },
        str(hift_path): {
            "conv.weight": _FakeTensor(np.ones((4,), dtype=np.float32)),
            "num_batches": 5,
        },
    }

    def _fake_load(path: str, map_location: str = "cpu", weights_only: bool = False) -> Any:
        del map_location, weights_only
        return stored[path]

    def _fake_save(obj: Any, path: str) -> None:
        final_path = path[:-4] if path.endswith(".tmp") else path
        stored[final_path] = obj
        Path(path).write_bytes(b"saved")

    fake_torch = _make_module(
        "torch",
        float16=np.float16,
        bfloat16=np.float16,
        load=_fake_load,
        save=_fake_save,
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    rc_keep = opt_mod.main(["--cache-dir", str(tmp_path)])
    assert rc_keep == 0

    dit_keep = stored[str(dit_path)]
    assert list(dit_keep.keys()) == ["net"]
    assert dit_keep["net"]["cfm"]["weight"].arr.dtype == np.float32
    assert dit_keep["net"]["cfm"]["step"].arr.dtype == np.int64

    hift_keep = stored[str(hift_path)]
    assert hift_keep["conv.weight"].arr.dtype == np.float32
    assert hift_keep["num_batches"] == 5

    rc_fp16 = opt_mod.main(["--cache-dir", str(tmp_path), "--dtype", "float16"])
    assert rc_fp16 == 0

    dit_out = stored[str(dit_path)]
    assert list(dit_out.keys()) == ["net"]
    assert dit_out["net"]["cfm"]["weight"].arr.dtype == np.float16
    assert dit_out["net"]["cfm"]["step"].arr.dtype == np.int64

    hift_out = stored[str(hift_path)]
    assert hift_out["conv.weight"].arr.dtype == np.float16
    assert hift_out["num_batches"] == 5


def test_seedvc_cast_state_to_float32_and_to_device_float32() -> None:
    """Verify fp16 checkpoint tensors are upcast to float32 before loading into modules."""
    from metamorph_engine.pipelines.voice_seedvc import (
        _cast_state_to_float32,
        _to_device_float32,
    )

    class _FakeTensor:
        def __init__(self, arr: np.ndarray) -> None:
            self.arr = arr

        @property
        def dtype(self) -> Any:
            return self.arr.dtype

        def is_floating_point(self) -> bool:
            return bool(np.issubdtype(self.arr.dtype, np.floating))

        def float(self) -> _FakeTensor:
            return _FakeTensor(self.arr.astype(np.float32))

    fake_torch = types.SimpleNamespace(float32=np.float32)
    fp16_state = {
        "resblocks.0.convs2.0.weight": _FakeTensor(np.ones((2, 2), dtype=np.float16)),
        "resblocks.0.convs2.0.bias": _FakeTensor(np.zeros((2,), dtype=np.float16)),
        "num_batches": _FakeTensor(np.array([7], dtype=np.int64)),
    }
    upcast = _cast_state_to_float32(fp16_state, fake_torch)
    assert upcast["resblocks.0.convs2.0.weight"].dtype == np.float32
    assert upcast["resblocks.0.convs2.0.bias"].dtype == np.float32
    assert upcast["num_batches"].dtype == np.int64

    calls: list[str] = []

    class _FakeModule:
        def to(self, dev: Any) -> _FakeModule:
            calls.append(f"to:{dev}")
            return self

        def float(self) -> _FakeModule:
            calls.append("float")
            return self

    mod = _to_device_float32(_FakeModule(), "cuda:0")
    assert isinstance(mod, _FakeModule)
    assert calls == ["to:cuda:0", "float"]


def test_joyai_session_drops_corrupt_jpeg_frame() -> None:
    """Corrupt JPEG payloads return VideoGateEvent(reason='invalid_frame') instead of crashing."""
    inner_calls: list[Any] = []

    class _InnerSess:
        def inflight_chunks(self) -> int:
            return 0

        def push_frame(self, image: Any, **kw: Any) -> None:
            inner_calls.append((image, kw))

    sess = object.__new__(JoyAIVideoSession)
    sess._pipeline = JoyAIVideoPipeline(EngineSettings(backend="mock"))
    sess._lock = __import__("threading").Lock()
    sess._session = _InnerSess()

    evt = sess.push_frame(
        VideoFrameIn(b"corrupt-jpeg", VideoCodec.MJPEG, seq=1, pts_us=1000, flags=FrameFlags.NONE)
    )
    assert evt is not None
    assert evt.event_type == "dropped"
    assert evt.reason == "invalid_frame"
    assert inner_calls == []


def test_seedvc_cpu_fallback_cuda_stream_and_gpu_xlsr_normalization(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Verify CPU keeps w2v fp32, GPU XLSR normalizes in-tensor, tqdm silences, and stream runs."""
    monkeypatch.setattr(sys, "path", list(sys.path))
    events: dict[str, Any] = {
        "w2v_half_calls": 0,
        "feat_ext_runtime_calls": 0,
        "stream_enters": 0,
        "w2v_input_dtype": None,
        "w2v_normalized": None,
        "cuda_available": False,
    }

    class _FakeTensor:
        def __init__(self, data: np.ndarray) -> None:
            self.arr = np.asarray(data)

        @property
        def shape(self) -> tuple[int, ...]:
            return self.arr.shape

        @property
        def dtype(self) -> np.dtype[Any]:
            return self.arr.dtype

        @property
        def device(self) -> str:
            return "cuda:0" if events["cuda_available"] else "cpu"

        def size(self, dim: int | None = None) -> Any:
            return self.arr.shape if dim is None else self.arr.shape[dim]

        def to(self, *args: Any, **kwargs: Any) -> _FakeTensor:
            return self

        def half(self) -> _FakeTensor:
            return _FakeTensor(self.arr.astype(np.float16))

        def float(self) -> _FakeTensor:
            return _FakeTensor(self.arr.astype(np.float32))

        def cpu(self) -> _FakeTensor:
            return self

        def numpy(self) -> np.ndarray:
            return self.arr

        def unsqueeze(self, dim: int) -> _FakeTensor:
            return _FakeTensor(np.expand_dims(self.arr, axis=dim))

        def mean(self, dim: int | None = None, keepdim: bool = False) -> _FakeTensor:
            return _FakeTensor(self.arr.mean(axis=dim, keepdims=keepdim))

        def __sub__(self, other: Any) -> _FakeTensor:
            return _FakeTensor(self.arr - (other.arr if isinstance(other, _FakeTensor) else other))

        def __add__(self, other: Any) -> _FakeTensor:
            return _FakeTensor(self.arr + (other.arr if isinstance(other, _FakeTensor) else other))

        def __truediv__(self, other: Any) -> _FakeTensor:
            return _FakeTensor(self.arr / (other.arr if isinstance(other, _FakeTensor) else other))

        def __pow__(self, power: Any) -> _FakeTensor:
            return _FakeTensor(self.arr**power)

    class _StreamCtx:
        def __enter__(self) -> None:
            events["stream_enters"] += 1

        def __exit__(self, *_args: object) -> None:
            pass

    class _FakeCuda:
        @staticmethod
        def is_available() -> bool:
            return bool(events["cuda_available"])

        @staticmethod
        def Stream(device: Any = None) -> object:
            return ("cuda_stream", device)

        @staticmethod
        def stream(_s: Any) -> _StreamCtx:
            return _StreamCtx()

    class _FakeDevice:
        def __init__(self, spec: str) -> None:
            self.type = "cuda" if "cuda" in spec else "cpu"

    fake_torch = _make_module(
        "torch",
        float16=np.float16,
        float32=np.float32,
        cuda=_FakeCuda,
        device=_FakeDevice,
        no_grad=lambda: _StreamCtx(),
        inference_mode=lambda: _StreamCtx(),
        from_numpy=lambda arr: _FakeTensor(np.array(arr, dtype=np.float32)),
        LongTensor=lambda vals: _FakeTensor(np.asarray(vals, dtype=np.int64)),
        sqrt=lambda t: _FakeTensor(np.sqrt(t.arr).astype(np.float32)),
        load=lambda path, **kw: {"net": {}},
    )

    class _FakeW2V:
        def __init__(self) -> None:
            self.encoder = types.SimpleNamespace(layers=list(range(24)))

        def to(self, _d: Any) -> _FakeW2V:
            return self

        def eval(self) -> _FakeW2V:
            return self

        def half(self) -> _FakeW2V:
            events["w2v_half_calls"] += 1
            return self

        def __call__(self, inp: _FakeTensor) -> Any:
            events["w2v_input_dtype"] = inp.dtype
            events["w2v_normalized"] = inp.arr.copy()
            return types.SimpleNamespace(
                last_hidden_state=_FakeTensor(np.zeros((1, 4, 1024), dtype=np.float32))
            )

    def _feat_ext(*_a: Any, **_kw: Any) -> Any:
        events["feat_ext_runtime_calls"] += 1
        raise AssertionError("CPU feature_extractor should not be invoked during live semantic_fn")

    class _DummyMod:
        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def load_state_dict(self, *_a: Any, **_kw: Any) -> None:
            pass

        def eval(self) -> _DummyMod:
            return self

        def to(self, _d: Any) -> _DummyMod:
            return self

        def __call__(self, *_a: Any, **_kw: Any) -> Any:
            return _FakeTensor(np.ones((1, 192), dtype=np.float32))

    class _Reg:
        def __init__(self) -> None:
            self.eval = lambda: self
            self.to = lambda _d: self

        def __call__(self, *_a: Any, ylens: _FakeTensor, **_kw: Any) -> tuple[_FakeTensor]:
            return (_FakeTensor(np.zeros((1, int(ylens.arr[0]), 384), dtype=np.float32)),)

    class _CFM:
        estimator = types.SimpleNamespace(setup_caches=lambda **_kw: None)

        def state_dict(self) -> dict[str, Any]:
            return {}

        def load_state_dict(self, *_a: Any) -> None:
            return None

        def eval(self) -> _CFM:
            return self

        def to(self, _d: Any) -> _CFM:
            return self

    class _Munch(dict):
        __getattr__ = dict.__getitem__
        __setattr__ = dict.__setitem__

    def _safe_load(fh: Any) -> dict[str, Any]:
        if "hifigan" in getattr(fh, "name", ""):
            return {"hift": {"sampling_rate": 22050}, "f0_predictor": {}}
        return {
            "preprocess_params": {
                "sr": 22050,
                "spect_params": {
                    "n_fft": 1024,
                    "win_length": 1024,
                    "hop_length": 256,
                    "n_mels": 80,
                },
            },
            "model_params": {
                "vocoder": {"type": "hifigan"},
                "speech_tokenizer": {
                    "type": "xlsr",
                    "name": "facebook/wav2vec2-xls-r-300m",
                    "output_layer": 12,
                },
            },
        }

    def _dl(*, filename: str, local_dir: str, **_kw: Any) -> str:
        p = Path(local_dir) / filename
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"ckpt")
        return str(p)

    fm_mod = _make_module("modules.flow_matching", tqdm=lambda it, *a, **kw: ("wrapped", it))
    fake_mods = {
        "torch": fake_torch,
        "torch.nn.functional": _make_module("torch.nn.functional"),
        "torchaudio": _make_module(
            "torchaudio",
            functional=types.SimpleNamespace(
                resample=lambda t, _o, _n: _FakeTensor(np.ones((1, 640), dtype=np.float32))
            ),
            compliance=types.SimpleNamespace(
                kaldi=types.SimpleNamespace(
                    fbank=lambda *_a, **_kw: _FakeTensor(np.ones((4, 80), dtype=np.float32))
                )
            ),
        ),
        "yaml": _make_module("yaml", safe_load=_safe_load),
        "huggingface_hub": _make_module("huggingface_hub", hf_hub_download=_dl),
        "transformers": _make_module(
            "transformers",
            Wav2Vec2FeatureExtractor=types.SimpleNamespace(from_pretrained=lambda _s: _feat_ext),
            Wav2Vec2Model=types.SimpleNamespace(from_pretrained=lambda _s: _FakeW2V()),
        ),
        "modules": _make_module("modules"),
        "modules.flow_matching": fm_mod,
        "modules.commons": _make_module(
            "modules.commons",
            recursive_munch=lambda d: _Munch(
                {k: (_Munch(v) if isinstance(v, dict) else v) for k, v in d.items()}
            ),
            build_model=lambda _p, stage="DiT": _Munch(
                cfm=_CFM(),
                length_regulator=_Reg(),
            ),
        ),
        "modules.audio": _make_module(
            "modules.audio",
            mel_spectrogram=lambda *_a, **_kw: _FakeTensor(np.zeros((1, 80, 8), dtype=np.float32)),
        ),
        "modules.campplus": _make_module("modules.campplus"),
        "modules.campplus.DTDNN": _make_module("modules.campplus.DTDNN", CAMPPlus=_DummyMod),
        "modules.hifigan": _make_module("modules.hifigan"),
        "modules.hifigan.generator": _make_module(
            "modules.hifigan.generator", HiFTGenerator=_DummyMod
        ),
        "modules.hifigan.f0_predictor": _make_module(
            "modules.hifigan.f0_predictor", ConvRNNF0Predictor=lambda **_kw: object()
        ),
    }
    for k, v in fake_mods.items():
        monkeypatch.setitem(sys.modules, k, v)
    for mod_del in ("dac", "dac.nn", "dac.nn.quantize", "librosa", "librosa.filters"):
        monkeypatch.delitem(sys.modules, mod_del, raising=False)

    # CPU fallback with dtype="bfloat16": must resolve voice_dtype="auto" -> float32, no .half()
    cpu_settings = EngineSettings(
        backend="gpu",
        enable_voice=True,
        enable_video=False,
        dtype="bfloat16",
        warmup_on_startup=False,
        voice_cache_dir=str(tmp_path / "cpu_cache"),
    )
    cpu_pipe = SeedVCVoicePipeline(cpu_settings)
    cpu_pipe.warmup()
    assert cpu_pipe.require_loaded().dtype == np.float32
    assert events["w2v_half_calls"] == 0
    # tqdm patched on modules.flow_matching to identity passthrough
    assert list(fm_mod.tqdm([1, 2, 3], desc="steps")) == [1, 2, 3]

    wave_raw = _FakeTensor(np.array([[1.0, 2.0, 3.0, 4.0]], dtype=np.float32))
    cpu_pipe.require_loaded().semantic_fn(wave_raw)
    assert events["feat_ext_runtime_calls"] == 0
    assert events["w2v_input_dtype"] == np.float32
    expected_norm = (wave_raw.arr - 2.5) / np.sqrt(np.mean((wave_raw.arr - 2.5) ** 2) + 1e-7)
    np.testing.assert_allclose(np.asarray(events["w2v_normalized"]), expected_norm, atol=1e-5)

    # CUDA enabled: set_reference_audio enters torch.cuda.stream(pipe.cuda_stream)
    events["cuda_available"] = True
    events["stream_enters"] = 0
    gpu_pipe = SeedVCVoicePipeline(
        EngineSettings(
            backend="gpu",
            enable_voice=True,
            enable_video=False,
            warmup_on_startup=False,
            voice_cache_dir=str(tmp_path / "gpu_cache"),
        )
    )
    gpu_pipe.warmup()
    assert events["w2v_half_calls"] == 1
    gpu_pipe.set_reference_audio(np.ones(22050, dtype=np.float32) * 0.2, 22050)
    assert events["stream_enters"] >= 1


def test_seedvc_load_xlsr_uses_dtype_kwarg_on_transformers_v5(tmp_path: Path) -> None:
    """transformers v5 passes `dtype=` while older versions pass `torch_dtype=`."""
    from metamorph_engine.pipelines.voice_seedvc import _load_xlsr_model

    model_dir = tmp_path / "seedvc" / "facebook__wav2vec2-xls-r-300m-l12-fp16"
    model_dir.mkdir(parents=True)
    (model_dir / "config.json").write_text("{}", encoding="utf-8")
    (model_dir / "model.safetensors").write_bytes(b"weights")

    model_kwargs_seen: list[dict[str, Any]] = []

    def _strict_v5_from_pretrained(
        src: str, *, local_files_only: bool = False, dtype: Any = None
    ) -> str:
        del src, local_files_only
        model_kwargs_seen.append({"dtype": dtype})
        return "w2v_v5"

    tf_v5 = _make_module(
        "transformers",
        __version__="5.20.2",
        Wav2Vec2FeatureExtractor=types.SimpleNamespace(from_pretrained=lambda _s, **_kw: "feat"),
        Wav2Vec2Model=types.SimpleNamespace(from_pretrained=_strict_v5_from_pretrained),
    )
    hf_hub = _make_module("huggingface_hub")
    feat, w2v = _load_xlsr_model(
        tf_v5,
        hf_hub,
        model_name="facebook/wav2vec2-xls-r-300m",
        cache_dir=str(tmp_path / "seedvc"),
        output_layer=12,
        torch_dtype="fp16_v5",
    )
    assert (feat, w2v) == ("feat", "w2v_v5")
    assert model_kwargs_seen == [{"dtype": "fp16_v5"}]


def test_prune_xlsr_prunes_layers_casts_fp16_and_removes_src(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify scripts/prune_xlsr.py slices encoder to N layers, saves fp16, and removes src."""
    import importlib.util
    import json

    script_path = REPO_ROOT / "apps" / "engine-py" / "scripts" / "prune_xlsr.py"
    spec = importlib.util.spec_from_file_location("prune_xlsr", script_path)
    assert spec is not None and spec.loader is not None
    prune_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prune_mod)

    src_dir = tmp_path / "raw_xlsr"
    dest_dir = tmp_path / "pruned_xlsr"
    src_dir.mkdir()
    (src_dir / "config.json").write_text("{}", encoding="utf-8")

    saved_args: dict[str, Any] = {}

    class _FakeModel:
        def __init__(self) -> None:
            self.encoder = types.SimpleNamespace(layers=list(range(24)))
            self.config = types.SimpleNamespace(num_hidden_layers=24, torch_dtype="float32")
            self.cast_dtype: Any = None

        def to(self, *, dtype: Any) -> _FakeModel:
            self.cast_dtype = dtype
            return self

        def eval(self) -> _FakeModel:
            return self

        def save_pretrained(self, out_dir: str, *, safe_serialization: bool = False) -> None:
            saved_args["safe_serialization"] = safe_serialization
            saved_args["layers"] = len(self.encoder.layers)
            saved_args["config_layers"] = self.config.num_hidden_layers
            saved_args["dtype"] = self.cast_dtype
            p = Path(out_dir)
            (p / "model.safetensors").write_bytes(b"pruned-fp16")
            (p / "config.json").write_text(
                json.dumps({"num_hidden_layers": self.config.num_hidden_layers}),
                encoding="utf-8",
            )

    class _FakeFeatExt:
        def save_pretrained(self, out_dir: str) -> None:
            (Path(out_dir) / "preprocessor_config.json").write_text("{}", encoding="utf-8")

    fake_torch = _make_module("torch", float16="fp16", bfloat16="bf16", float32="fp32")
    fake_tf = _make_module(
        "transformers",
        Wav2Vec2FeatureExtractor=types.SimpleNamespace(
            from_pretrained=lambda *_a, **_kw: _FakeFeatExt()
        ),
        Wav2Vec2Model=types.SimpleNamespace(from_pretrained=lambda *_a, **_kw: _FakeModel()),
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "transformers", fake_tf)

    rc = prune_mod.main(["--src", str(src_dir), "--dest", str(dest_dir), "--remove-src"])
    assert rc == 0
    assert saved_args == {
        "safe_serialization": True,
        "layers": 12,
        "config_layers": 12,
        "dtype": "fp16",
    }
    assert (dest_dir / "model.safetensors").is_file()
    assert json.loads((dest_dir / "config.json").read_text(encoding="utf-8")) == {
        "num_hidden_layers": 12
    }
    assert not src_dir.exists()


def test_stateful_audio_resampler_preserves_continuity_and_spectrum(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify StatefulAudioResampler has zero chunk-edge clicks and preserves sine spectrum."""
    from metamorph_engine.pipelines.base import StatefulAudioResampler

    # Force pure-NumPy SOS fallback branch to guarantee CPU-only behavior is always exercised
    monkeypatch.setitem(sys.modules, "scipy", None)
    monkeypatch.setitem(sys.modules, "scipy.signal", None)

    sr_in = 48000
    sr_mid = 22050
    t = np.arange(sr_in, dtype=np.float32) / float(sr_in)
    wave_48k = (0.6 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    chunks = [wave_48k[i : i + 960] for i in range(0, sr_in, 960)]

    r_chunk = StatefulAudioResampler(sr_in, sr_mid)
    r_whole = StatefulAudioResampler(sr_in, sr_mid)
    down_chunks = [r_chunk.process(c) for c in chunks]
    down_cat = np.concatenate(down_chunks)
    down_ref = r_whole.process(wave_48k)

    assert 22000 <= down_cat.size <= 22055
    np.testing.assert_allclose(down_cat, down_ref, atol=1e-5)
    # Continuous derivative across all 20ms chunk boundaries (no step click)
    assert float(np.max(np.abs(np.diff(down_cat[200:])))) < 0.12

    # Steady-state frequency correlation check at 440 Hz
    steady = down_cat[1000:]
    ts = np.arange(steady.size, dtype=np.float32) / float(sr_mid)
    c440 = float(np.mean(steady * np.cos(2.0 * np.pi * 440.0 * ts)))
    s440 = float(np.mean(steady * np.sin(2.0 * np.pi * 440.0 * ts)))
    tone_rms = float(np.hypot(c440, s440)) * np.sqrt(2.0)
    sig_rms = float(np.sqrt(np.mean(steady**2)))
    assert tone_rms / sig_rms > 0.98

    # Upsample back 22050 -> 48000 chunk-by-chunk & verify continuity
    r_up_chunk = StatefulAudioResampler(sr_mid, sr_in)
    r_up_whole = StatefulAudioResampler(sr_mid, sr_in)
    up_cat = np.concatenate([r_up_chunk.process(c) for c in down_chunks])
    up_ref = r_up_whole.process(down_ref)
    np.testing.assert_allclose(up_cat, up_ref, atol=1e-5)
    assert float(np.max(np.abs(np.diff(up_cat[400:])))) < 0.06

    # reset() clears state and matches fresh instance
    r_chunk.reset()
    np.testing.assert_allclose(r_chunk.process(chunks[0]), down_chunks[0], atol=1e-6)

    # Identity sample rate returns exact samples
    r_id = StatefulAudioResampler(22050, 22050)
    np.testing.assert_allclose(r_id.process(chunks[0]), chunks[0], atol=1e-7)
