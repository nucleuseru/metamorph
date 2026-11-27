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

    # Warmup must run cfm.inference + HiFT outside autocast with fp32 mel, then clear ref audio
    assert state["cfm_calls"] == 1
    assert state["diffusion_steps"] == [30]
    assert state["cfg_rates"] == [0.7]
    assert state["hift_autocast_depths"] == [0]
    assert state["hift_dtypes"] == [np.float32]
    assert pipe.has_reference_audio is False

    # Exercise live session: silence gate, passthrough, live conversion + flush
    sess = pipe.create_session(AudioSessionConfig(vad_threshold_db=-40.0))
    pipe.set_reference_audio(np.ones(22050, dtype=np.float32) * 0.1, 22050)
    assert pipe.has_reference_audio is True

    # Silent chunk (400ms = 20 * 441 = 8820 samples) -> VAD marks SILENCE without running cfm
    silent_outs = sess.push_audio(
        AudioChunkIn(
            samples=np.zeros(8820, dtype=np.float32),
            sample_rate=22050,
            codec=AudioCodec.PCM_S16LE,
            seq=1,
            pts_us=0,
        )
    )
    assert len(silent_outs) == 1
    assert bool(silent_outs[0].flags & FrameFlags.SILENCE) is True
    assert state["cfm_calls"] == 1

    # Voiced chunk -> runs infer_window + HiFT outside autocast
    voiced = (0.2 * np.sin(2.0 * np.pi * 220.0 * np.arange(8820) / 22050.0)).astype(np.float32)
    voiced_outs = sess.push_audio(
        AudioChunkIn(
            samples=voiced,
            sample_rate=22050,
            codec=AudioCodec.PCM_S16LE,
            seq=2,
            pts_us=400_000,
        )
    )
    assert len(voiced_outs) == 1
    assert bool(voiced_outs[0].flags & FrameFlags.SPEECH_ACTIVE) is True
    assert state["cfm_calls"] == 2
    assert state["diffusion_steps"] == [30, 30]
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
    """Verify maxed-out default Seed-VC parameters stay internally consistent."""
    settings = EngineSettings()
    assert settings.voice_diffusion_steps == 30
    assert settings.voice_cfg_rate == 0.7
    assert settings.voice_max_prompt_length_s == 15.0
    assert settings.voice_extra_context_left_s == 5.0
    assert settings.voice_extra_dit_context_left_s == 2.5
    assert settings.voice_extra_context_right_s == 0.16
    assert settings.voice_crossfade_s == 0.08
    assert settings.voice_block_time_s == 0.40
    assert settings.voice_vad_hangover_s == 0.5
    assert settings.voice_vad_threshold_db == -48.0

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
