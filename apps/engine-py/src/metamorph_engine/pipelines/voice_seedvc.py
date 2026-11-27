"""Real-time Seed-VC voice cloning pipeline wrapper."""

from __future__ import annotations

import contextlib
import importlib
import importlib.util
import logging
import shutil
import sys
import tempfile
import threading
import types
from pathlib import Path
from typing import Any

import numpy as np

from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.base import (
    AudioChunkIn,
    AudioChunkOut,
    AudioSessionConfig,
    RmsHangoverVad,
    VoicePipeline,
    VoiceSession,
    encode_pcm_bytes,
    resample_audio_linear,
    soft_limit_audio,
)
from metamorph_engine.protocol import AudioCodec, FrameFlags

logger = logging.getLogger("metamorph_engine.pipelines.voice_seedvc")


def _file_size_or_none(path: str | Path) -> int | None:
    try:
        return Path(path).stat().st_size
    except OSError:
        return None


def _download_hf_file(
    hf_hub: Any,
    *,
    repo_id: str,
    filename: str,
    target_dir: str,
    force_download: bool = False,
) -> str:
    """Download a single HuggingFace file as a real file (avoiding FUSE-unfriendly symlinks)."""
    dest = Path(target_dir) / filename
    if not force_download and dest.is_file() and (_file_size_or_none(dest) or 0) > 0:
        return str(dest)

    Path(target_dir).mkdir(parents=True, exist_ok=True)
    try:
        return str(
            hf_hub.hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=target_dir,
                force_download=force_download,
            )
        )
    except TypeError:
        return str(
            hf_hub.hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                cache_dir=target_dir,
            )
        )


def _load_torch_hf_checkpoint(
    torch_mod: Any,
    hf_hub: Any,
    *,
    repo_id: str,
    filename: str,
    cache_dir: str,
    label: str,
) -> Any:
    """Download and `torch.load` a HF checkpoint, recovering from truncated/FUSE-corrupted files."""
    ckpt_path = _download_hf_file(
        hf_hub,
        repo_id=repo_id,
        filename=filename,
        target_dir=cache_dir,
    )
    try:
        return _torch_load_compat(torch_mod, ckpt_path)
    except (EOFError, RuntimeError, OSError) as first_exc:
        first_size = _file_size_or_none(ckpt_path)
        logger.warning(
            "Failed loading %s from %s (size=%s): %s: %s; retrying via local temp storage",
            label,
            ckpt_path,
            first_size,
            type(first_exc).__name__,
            first_exc,
        )
        local_tmp_dir = Path(tempfile.gettempdir()) / "metamorph-voice-cache"
        local_tmp_dir.mkdir(parents=True, exist_ok=True)
        try:
            fresh_path = _download_hf_file(
                hf_hub,
                repo_id=repo_id,
                filename=filename,
                target_dir=str(local_tmp_dir),
                force_download=True,
            )
            loaded = _torch_load_compat(torch_mod, fresh_path)
        except Exception as retry_exc:
            retry_size = _file_size_or_none(local_tmp_dir / filename)
            raise RuntimeError(
                f"Failed loading {label} ({repo_id}/{filename}; volume_size={first_size}, "
                f"retry_size={retry_size}): {type(retry_exc).__name__}: {retry_exc}"
            ) from retry_exc

        # Best-effort repair of the persistent volume copy so subsequent boots stay warm
        with contextlib.suppress(OSError):
            target_file = Path(cache_dir) / filename
            target_file.parent.mkdir(parents=True, exist_ok=True)
            tmp_copy = target_file.with_suffix(target_file.suffix + ".tmp")
            shutil.copyfile(fresh_path, tmp_copy)
            tmp_copy.replace(target_file)
        return loaded


def _load_xlsr_model(
    transformers_mod: Any,
    hf_hub: Any,
    *,
    model_name: str,
    cache_dir: str,
) -> tuple[Any, Any]:
    """Load XLSR feature extractor and encoder using symlink-free storage with SSD fallback."""
    xlsr_dir = Path(cache_dir) / model_name.replace("/", "__")
    snapshot_fn = getattr(hf_hub, "snapshot_download", None)
    source = model_name
    if callable(snapshot_fn):
        with contextlib.suppress(Exception):
            xlsr_dir.mkdir(parents=True, exist_ok=True)
            snapshot_fn(
                repo_id=model_name,
                local_dir=str(xlsr_dir),
                allow_patterns=[
                    "config.json",
                    "preprocessor_config.json",
                    "pytorch_model.bin",
                    "model.safetensors",
                ],
            )
            if (xlsr_dir / "config.json").is_file():
                source = str(xlsr_dir)

    try:
        feat_ext = transformers_mod.Wav2Vec2FeatureExtractor.from_pretrained(source)
        w2v = transformers_mod.Wav2Vec2Model.from_pretrained(source)
        return feat_ext, w2v
    except (EOFError, RuntimeError, OSError) as first_exc:
        logger.warning(
            "Failed loading XLSR %s from %s: %s: %s; retrying via local temp storage",
            model_name,
            source,
            type(first_exc).__name__,
            first_exc,
        )
        local_tmp = Path(tempfile.gettempdir()) / "metamorph-voice-cache" / "xlsr"
        local_tmp.mkdir(parents=True, exist_ok=True)
        try:
            if callable(snapshot_fn):
                snapshot_fn(
                    repo_id=model_name,
                    local_dir=str(local_tmp),
                    force_download=True,
                    allow_patterns=[
                        "config.json",
                        "preprocessor_config.json",
                        "pytorch_model.bin",
                        "model.safetensors",
                    ],
                )
                feat_ext = transformers_mod.Wav2Vec2FeatureExtractor.from_pretrained(str(local_tmp))
                w2v = transformers_mod.Wav2Vec2Model.from_pretrained(str(local_tmp))
                return feat_ext, w2v
            feat_ext = transformers_mod.Wav2Vec2FeatureExtractor.from_pretrained(
                model_name, cache_dir=str(local_tmp), force_download=True
            )
            w2v = transformers_mod.Wav2Vec2Model.from_pretrained(
                model_name, cache_dir=str(local_tmp), force_download=True
            )
            return feat_ext, w2v
        except Exception as retry_exc:
            raise RuntimeError(
                f"Failed loading XLSR ({model_name}): {type(retry_exc).__name__}: {retry_exc}"
            ) from retry_exc


def _ensure_dac_importable() -> None:
    """Provide a stub `dac.nn.quantize.VectorQuantize` when descript-audio-codec is absent.

    `vendor/seed-vc/modules/length_regulator.py` imports `VectorQuantize` at module
    import time even though `config_dit_mel_seed_uvit_xlsr_tiny.yml` keeps
    `vector_quantize: false` and never instantiates it.
    """
    if importlib.util.find_spec("dac") is not None or "dac.nn.quantize" in sys.modules:
        return

    dac_mod: Any = types.ModuleType("dac")
    dac_nn_mod: Any = types.ModuleType("dac.nn")
    dac_quantize_mod: Any = types.ModuleType("dac.nn.quantize")

    class _UnavailableVectorQuantize:
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise ImportError("Install descript-audio-codec to use vector_quantize=True")

    dac_quantize_mod.VectorQuantize = _UnavailableVectorQuantize
    dac_nn_mod.quantize = dac_quantize_mod
    dac_mod.nn = dac_nn_mod
    sys.modules["dac"] = dac_mod
    sys.modules["dac.nn"] = dac_nn_mod
    sys.modules["dac.nn.quantize"] = dac_quantize_mod


def _torch_load_compat(torch_mod: Any, path: str) -> Any:
    """Load legacy Seed-VC checkpoints under PyTorch 2.6+ where `weights_only=True` by default."""
    try:
        return torch_mod.load(path, map_location="cpu", weights_only=False)
    except TypeError:
        return torch_mod.load(path, map_location="cpu")


def _load_seedvc_state_dict(model: Any, state: Any) -> None:
    """Apply loaded Seed-VC `net` state dicts onto the DiT/length-regulator modules."""
    params = state["net"]
    for key in model:
        if key not in params:
            continue
        sub_params = dict(params[key])
        for param_name in list(sub_params.keys()):
            if param_name.startswith("module."):
                sub_params[param_name[len("module.") :]] = sub_params.pop(param_name)
        model_state = model[key].state_dict()
        filtered = {
            k: v
            for k, v in sub_params.items()
            if k in model_state
            and getattr(v, "shape", None) == getattr(model_state[k], "shape", None)
        }
        model[key].load_state_dict(filtered, strict=False)
        model[key].eval()


def _load_seedvc_checkpoint(torch_mod: Any, model: Any, ckpt_path: str) -> None:
    """Load `net` state dicts from Seed-VC DiT/length-regulator checkpoints safely."""
    state = _torch_load_compat(torch_mod, ckpt_path)
    _load_seedvc_state_dict(model, state)


class _LoadedSeedVC:
    """Container for dynamically loaded Seed-VC modules and torch weights."""

    def __init__(
        self,
        *,
        torch_mod: Any,
        torchaudio_mod: Any,
        torch_f: Any,
        device: Any,
        dtype: Any,
        sr: int,
        hop_length: int,
        model: Any,
        semantic_fn: Any,
        vocoder_fn: Any,
        campplus_model: Any,
        to_mel: Any,
    ) -> None:
        self.torch = torch_mod
        self.torchaudio = torchaudio_mod
        self.F = torch_f
        self.device = device
        self.dtype = dtype
        self.sr = sr
        self.hop_length = hop_length
        self.model = model
        self.semantic_fn = semantic_fn
        self.vocoder_fn = vocoder_fn
        self.campplus_model = campplus_model
        self.to_mel = to_mel


class SeedVCVoiceSession(VoiceSession):
    """Streaming Seed-VC ring buffer + SOLA crossfade voice conversion session."""

    def __init__(self, pipeline: SeedVCVoicePipeline, config: AudioSessionConfig) -> None:
        self._pipeline = pipeline
        self._config = config
        self._loaded = pipeline.require_loaded()
        self._torch = self._loaded.torch
        self._sr = self._loaded.sr
        self._zc = self._sr // 50  # 20ms frame hop at 50Hz semantic rate

        self._vad = RmsHangoverVad(
            threshold_db=config.vad_threshold_db,
            hangover_s=pipeline.settings.voice_vad_hangover_s,
            adaptive_noise_floor=pipeline.settings.voice_vad_adaptive_noise_floor,
            noise_margin_db=pipeline.settings.voice_vad_noise_margin_db,
        )

        self._out_seq = 0
        self._pending_in = np.zeros(0, dtype=np.float32)
        self._pending_start_pts_us: int | None = None
        self._resampler_in: Any | None = None
        self._resampler_in_sr: int | None = None
        self._resampler_out: Any | None = None
        self._resampler_out_sr: int | None = None

        self._init_buffers()

    def _init_buffers(self) -> None:
        torch = self._torch
        settings = self._pipeline.settings
        device = self._loaded.device

        self._block_frame = (
            max(1, round(self._config.block_time_s * self._sr / self._zc)) * self._zc
        )
        self._crossfade_frame = (
            max(1, round(settings.voice_crossfade_s * self._sr / self._zc)) * self._zc
        )
        self._sola_buffer_frame = min(self._crossfade_frame, 4 * self._zc)
        self._sola_search_frame = self._zc
        self._extra_frame = (
            max(1, round(settings.voice_extra_context_left_s * self._sr / self._zc)) * self._zc
        )
        self._extra_dit_frame = (
            max(1, round(settings.voice_extra_dit_context_left_s * self._sr / self._zc)) * self._zc
        )
        if self._extra_frame < self._extra_dit_frame:
            self._extra_frame = self._extra_dit_frame
        self._extra_frame_right = (
            max(0, round(settings.voice_extra_context_right_s * self._sr / self._zc)) * self._zc
        )

        self._skip_head = self._extra_frame // self._zc
        self._skip_tail = self._extra_frame_right // self._zc
        self._return_length = (
            self._block_frame + self._sola_buffer_frame + self._sola_search_frame
        ) // self._zc
        self._ce_dit_diff_s = max(
            0.0,
            (self._extra_frame - self._extra_dit_frame) / float(self._sr),
        )
        self._lookahead_us = round(
            (self._extra_frame_right + self._sola_buffer_frame + self._sola_search_frame)
            * 1_000_000
            / float(self._sr)
        )

        total_len = (
            self._extra_frame
            + self._crossfade_frame
            + self._sola_search_frame
            + self._block_frame
            + self._extra_frame_right
        )
        self._input_wav = torch.zeros(total_len, device=device, dtype=torch.float32)
        self._input_wav_res = torch.zeros(
            320 * total_len // self._zc, device=device, dtype=torch.float32
        )
        self._sola_buffer = torch.zeros(self._sola_buffer_frame, device=device, dtype=torch.float32)
        self._fade_in_window = (
            torch.sin(
                0.5 * np.pi * torch.linspace(0.0, 1.0, steps=self._sola_buffer_frame, device=device)
            )
            ** 2
        )
        self._fade_out_window = 1.0 - self._fade_in_window

    def _resample_incoming(self, samples: np.ndarray, input_sr: int) -> np.ndarray:
        if input_sr == self._sr or samples.size == 0:
            return samples
        if self._loaded.torchaudio is not None:
            if self._resampler_in is None or self._resampler_in_sr != input_sr:
                self._resampler_in = self._loaded.torchaudio.transforms.Resample(
                    orig_freq=input_sr,
                    new_freq=self._sr,
                    dtype=self._torch.float32,
                ).to(self._loaded.device)
                self._resampler_in_sr = input_sr
            with self._torch.inference_mode():
                t = self._torch.from_numpy(samples).to(self._loaded.device)
                return self._resampler_in(t).detach().cpu().numpy().astype(np.float32)
        return resample_audio_linear(samples, input_sr, self._sr)

    def _resample_outgoing(self, tensor: Any, output_sr: int) -> np.ndarray:
        if output_sr == self._sr:
            return tensor.detach().cpu().numpy().astype(np.float32)
        if self._loaded.torchaudio is not None:
            if self._resampler_out is None or self._resampler_out_sr != output_sr:
                self._resampler_out = self._loaded.torchaudio.transforms.Resample(
                    orig_freq=self._sr,
                    new_freq=output_sr,
                    dtype=self._torch.float32,
                ).to(self._loaded.device)
                self._resampler_out_sr = output_sr
            return self._resampler_out(tensor).detach().cpu().numpy().astype(np.float32)
        return resample_audio_linear(
            tensor.detach().cpu().numpy().astype(np.float32),
            self._sr,
            output_sr,
        )

    def _check_speech(self, block_model_sr: np.ndarray) -> bool:
        if self._pipeline.settings.voice_vad_backend == "none":
            return True
        return self._vad.is_speech(block_model_sr, self._sr)

    def push_audio(self, chunk: AudioChunkIn) -> list[AudioChunkOut]:
        samples = self._resample_incoming(chunk.samples, chunk.sample_rate)
        if samples.size == 0:
            return []
        if self._pending_in.size == 0:
            self._pending_start_pts_us = chunk.pts_us
        self._pending_in = np.concatenate([self._pending_in, samples])

        outputs: list[AudioChunkOut] = []
        block_dur_us = round(self._block_frame * 1_000_000 / float(self._sr))

        while self._pending_in.shape[0] >= self._block_frame:
            block = self._pending_in[: self._block_frame]
            self._pending_in = self._pending_in[self._block_frame :]
            block_pts_us = (
                self._pending_start_pts_us
                if self._pending_start_pts_us is not None
                else chunk.pts_us
            )
            if self._pending_in.size > 0 and self._pending_start_pts_us is not None:
                self._pending_start_pts_us += block_dur_us
            else:
                self._pending_start_pts_us = None

            out_chunk = self._process_block(block, block_pts_us)
            outputs.append(out_chunk)
        return outputs

    def _process_block(self, block: np.ndarray, block_pts_us: int) -> AudioChunkOut:
        torch = self._torch
        F = self._loaded.F
        device = self._loaded.device

        out_pts_us = max(0, block_pts_us - self._lookahead_us)
        speech_active = self._check_speech(block)

        with self._pipeline.infer_lock, torch.inference_mode():
            stream_ctx = (
                torch.cuda.stream(self._pipeline.cuda_stream)
                if self._pipeline.cuda_stream is not None
                else contextlib.nullcontext()
            )
            with stream_ctx:
                self._input_wav[: -self._block_frame] = self._input_wav[self._block_frame :].clone()
                self._input_wav[-self._block_frame :] = torch.from_numpy(block).to(device)

                block_16k = 320 * self._block_frame // self._zc
                self._input_wav_res[:-block_16k] = self._input_wav_res[block_16k:].clone()
                tail_src = self._input_wav[-self._block_frame - 2 * self._zc :]
                tail_16k = self._loaded.torchaudio.functional.resample(
                    tail_src.unsqueeze(0), self._sr, 16000
                ).squeeze(0)
                fill_len = 320 * (self._block_frame // self._zc + 1)
                slice_16k = tail_16k[320 : 320 + fill_len]
                if slice_16k.shape[0] < fill_len:
                    slice_16k = F.pad(slice_16k, (0, fill_len - slice_16k.shape[0]))
                self._input_wav_res[-fill_len:] = slice_16k

                flags = FrameFlags.NONE
                if self._config.passthrough or not self._pipeline.has_reference_audio:
                    infer_wav = self._input_wav[self._extra_frame :].clone()
                    if self._config.passthrough:
                        flags |= FrameFlags.PASSTHROUGH
                elif not speech_active:
                    infer_wav = torch.zeros_like(self._input_wav[self._extra_frame :])
                    flags |= FrameFlags.SILENCE
                else:
                    infer_wav = self._pipeline.infer_window(
                        input_wav_res=self._input_wav_res,
                        skip_head=self._skip_head,
                        skip_tail=self._skip_tail,
                        return_length=self._return_length,
                        diffusion_steps=self._config.diffusion_steps,
                        cfg_rate=self._config.cfg_rate,
                        ce_dit_diff_s=self._ce_dit_diff_s,
                    )
                    flags |= FrameFlags.SPEECH_ACTIVE

                # SOLA crossfade for artifact-free chunk stitching
                conv_input = infer_wav[
                    None, None, : self._sola_buffer_frame + self._sola_search_frame
                ]
                cor_nom = F.conv1d(conv_input, self._sola_buffer[None, None, :])
                cor_den = torch.sqrt(
                    F.conv1d(
                        conv_input**2,
                        torch.ones(1, 1, self._sola_buffer_frame, device=device),
                    )
                    + 1e-8
                )
                scores = cor_nom[0, 0] / cor_den[0, 0]
                sola_offset = int(torch.argmax(scores, dim=0).item()) if scores.numel() > 1 else 0

                infer_wav = infer_wav[sola_offset:]
                infer_wav[: self._sola_buffer_frame] *= self._fade_in_window
                infer_wav[: self._sola_buffer_frame] += self._sola_buffer * self._fade_out_window
                self._sola_buffer[:] = infer_wav[
                    self._block_frame : self._block_frame + self._sola_buffer_frame
                ]
                emitted_tensor = infer_wav[: self._block_frame]
                emitted_np = self._resample_outgoing(
                    emitted_tensor, self._config.output_sample_rate
                )
                emitted_np = soft_limit_audio(emitted_np)

        self._out_seq += 1
        return AudioChunkOut(
            payload=encode_pcm_bytes(emitted_np, self._config.output_codec),
            codec=self._config.output_codec,
            sample_rate=self._config.output_sample_rate,
            seq=self._out_seq,
            pts_us=out_pts_us,
            flags=flags,
        )

    def update_config(self, config: AudioSessionConfig) -> None:
        reinit = abs(config.block_time_s - self._config.block_time_s) > 1e-4
        self._config = config
        self._vad.update_threshold(config.vad_threshold_db)
        if reinit:
            self._init_buffers()

    def update_reference_audio(self, audio_f32: np.ndarray, sample_rate: int) -> None:
        self._pipeline.set_reference_audio(audio_f32, sample_rate)

    def close(self) -> None:
        self._pending_in = np.zeros(0, dtype=np.float32)


class SeedVCVoicePipeline(VoicePipeline):
    """Seed-VC v1 real-time zero-shot voice conversion pipeline."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.infer_lock = threading.Lock()
        self.cuda_stream: Any | None = None
        self._loaded: _LoadedSeedVC | None = None

        # Precomputed reference speaker features
        self._prompt_condition: Any | None = None
        self._mel2: Any | None = None
        self._style2: Any | None = None

    @property
    def has_reference_audio(self) -> bool:
        return (
            self._prompt_condition is not None
            and self._mel2 is not None
            and self._style2 is not None
        )

    def require_loaded(self) -> _LoadedSeedVC:
        """Return loaded Seed-VC state or raise if warmup hasn't completed."""
        if self._loaded is None:
            raise RuntimeError("Seed-VC pipeline is not loaded; call warmup() first.")
        return self._loaded

    def warmup(self) -> None:
        if self._loaded is not None:
            return

        seed_vc_dir = self.settings.resolved_vendor_dir / "seed-vc"
        if not seed_vc_dir.is_dir():
            raise FileNotFoundError(f"vendor/seed-vc directory not found at {seed_vc_dir}")
        if str(seed_vc_dir) not in sys.path:
            sys.path.insert(0, str(seed_vc_dir))

        torch = importlib.import_module("torch")
        torchaudio = importlib.import_module("torchaudio")
        torch_f = importlib.import_module("torch.nn.functional")
        yaml = importlib.import_module("yaml")
        hf_hub = importlib.import_module("huggingface_hub")
        transformers = importlib.import_module("transformers")
        _ensure_dac_importable()
        commons = importlib.import_module("modules.commons")
        audio_mod = importlib.import_module("modules.audio")
        campplus_mod = importlib.import_module("modules.campplus.DTDNN")

        device = torch.device(self.settings.device if torch.cuda.is_available() else "cpu")
        dtype = torch.float16 if self.settings.dtype in ("float16", "bfloat16") else torch.float32
        if device.type == "cuda":
            self.cuda_stream = torch.cuda.Stream(device=device)

        cache_dir = self.settings.voice_cache_dir or str(seed_vc_dir / "checkpoints")
        Path(cache_dir).mkdir(parents=True, exist_ok=True)

        use_custom_ckpt = bool(
            self.settings.voice_checkpoint_path and self.settings.voice_config_path
        )
        if use_custom_ckpt:
            cfg_path = str(self.settings.voice_config_path)
        else:
            preset_cfg = (
                seed_vc_dir / "configs" / "presets" / "config_dit_mel_seed_uvit_xlsr_tiny.yml"
            )
            cfg_path = (
                str(preset_cfg)
                if preset_cfg.is_file()
                else _download_hf_file(
                    hf_hub,
                    repo_id="Plachta/Seed-VC",
                    filename="config_dit_mel_seed_uvit_xlsr_tiny.yml",
                    target_dir=cache_dir,
                )
            )

        with open(cfg_path, encoding="utf-8") as fh:
            config = yaml.safe_load(fh)
        model_params = commons.recursive_munch(config["model_params"])
        model_params.dit_type = "DiT"
        model = commons.build_model(model_params, stage="DiT")
        sr = int(config["preprocess_params"]["sr"])
        hop_length = int(config["preprocess_params"]["spect_params"]["hop_length"])

        if use_custom_ckpt:
            _load_seedvc_checkpoint(torch, model, str(self.settings.voice_checkpoint_path))
        else:
            dit_state = _load_torch_hf_checkpoint(
                torch,
                hf_hub,
                repo_id="Plachta/Seed-VC",
                filename="DiT_uvit_tat_xlsr_ema.pth",
                cache_dir=cache_dir,
                label="Seed-VC DiT checkpoint",
            )
            _load_seedvc_state_dict(model, dit_state)
        for key in model:
            model[key].eval()
            model[key].to(device)
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)

        # CAMPPlus speaker encoder (bundled in vendor/seed-vc/)
        local_campplus = seed_vc_dir / "campplus_cn_common.bin"
        campplus_model = campplus_mod.CAMPPlus(feat_dim=80, embedding_size=192)
        campplus_state: Any | None = None
        if local_campplus.is_file() and (_file_size_or_none(local_campplus) or 0) > 0:
            try:
                campplus_state = _torch_load_compat(torch, str(local_campplus))
            except (EOFError, RuntimeError, OSError) as exc:
                logger.warning(
                    "Bundled CAMPPlus checkpoint at %s failed to load (%s: %s); falling back to HF",
                    local_campplus,
                    type(exc).__name__,
                    exc,
                )
        if campplus_state is None:
            campplus_state = _load_torch_hf_checkpoint(
                torch,
                hf_hub,
                repo_id="funasr/campplus",
                filename="campplus_cn_common.bin",
                cache_dir=cache_dir,
                label="CAMPPlus speaker encoder",
            )
        campplus_model.load_state_dict(campplus_state)
        campplus_model.eval()
        campplus_model.to(device)

        # Vocoder (HiFT for real-time v1 preset)
        vocoder_type = model_params.vocoder.type
        if vocoder_type != "hifigan":
            raise ValueError(f"Unsupported Seed-VC vocoder type: {vocoder_type}")
        hifigan_gen_mod = importlib.import_module("modules.hifigan.generator")
        hifigan_f0_mod = importlib.import_module("modules.hifigan.f0_predictor")
        hift_cfg_path = seed_vc_dir / "configs" / "hifigan.yml"
        with open(hift_cfg_path, encoding="utf-8") as fh:
            hift_config = yaml.safe_load(fh)
        hift_gen = hifigan_gen_mod.HiFTGenerator(
            **hift_config["hift"],
            f0_predictor=hifigan_f0_mod.ConvRNNF0Predictor(**hift_config["f0_predictor"]),
        )
        hift_state = _load_torch_hf_checkpoint(
            torch,
            hf_hub,
            repo_id="FunAudioLLM/CosyVoice-300M",
            filename="hift.pt",
            cache_dir=cache_dir,
            label="HiFT vocoder checkpoint",
        )
        hift_gen.load_state_dict(hift_state)
        hift_gen.eval()
        hift_gen.to(device)
        vocoder_fn = hift_gen

        # Speech tokenizer (XLSR for real-time tiny preset)
        tokenizer_type = model_params.speech_tokenizer.type
        if tokenizer_type != "xlsr":
            raise ValueError(f"Unsupported Seed-VC speech tokenizer: {tokenizer_type}")
        model_name = config["model_params"]["speech_tokenizer"]["name"]
        output_layer = config["model_params"]["speech_tokenizer"]["output_layer"]
        feat_ext, w2v = _load_xlsr_model(
            transformers,
            hf_hub,
            model_name=model_name,
            cache_dir=cache_dir,
        )
        w2v.encoder.layers = w2v.encoder.layers[:output_layer]
        w2v = w2v.to(device).eval().half()

        def semantic_fn(waves_16k: Any) -> Any:
            inputs_list = [waves_16k[idx].cpu().numpy() for idx in range(len(waves_16k))]
            inputs = feat_ext(
                inputs_list,
                return_tensors="pt",
                return_attention_mask=True,
                padding=True,
                sampling_rate=16000,
            ).to(device)
            with torch.no_grad():
                outputs = w2v(inputs.input_values.half())
            return outputs.last_hidden_state.float()

        spect_cfg = config["preprocess_params"]["spect_params"]
        mel_fn_args = {
            "n_fft": spect_cfg["n_fft"],
            "win_size": spect_cfg["win_length"],
            "hop_size": spect_cfg["hop_length"],
            "num_mels": spect_cfg["n_mels"],
            "sampling_rate": sr,
            "fmin": spect_cfg.get("fmin", 0),
            "fmax": None if spect_cfg.get("fmax", "None") == "None" else 8000,
            "center": False,
        }

        def to_mel(x: Any) -> Any:
            return audio_mod.mel_spectrogram(x, **mel_fn_args)

        self._loaded = _LoadedSeedVC(
            torch_mod=torch,
            torchaudio_mod=torchaudio,
            torch_f=torch_f,
            device=device,
            dtype=dtype,
            sr=sr,
            hop_length=hop_length,
            model=model,
            semantic_fn=semantic_fn,
            vocoder_fn=vocoder_fn,
            campplus_model=campplus_model,
            to_mel=to_mel,
        )

        # Warmup pass with synthetic reference + non-silent source audio so full DiT/HiFT compiles
        if self.settings.warmup_on_startup:
            t_ref = np.arange(sr, dtype=np.float32) / float(sr)
            dummy_ref = (0.05 * np.sin(2.0 * np.pi * 220.0 * t_ref)).astype(np.float32)
            self.set_reference_audio(dummy_ref, sr)
            sess = self.create_session(AudioSessionConfig(vad_threshold_db=-90.0))
            zc = sr // 50
            blk_len = max(1, round(self.settings.voice_block_time_s * sr / zc)) * zc
            t_blk = np.arange(blk_len, dtype=np.float32) / float(sr)
            dummy_blk = (0.05 * np.sin(2.0 * np.pi * 220.0 * t_blk)).astype(np.float32)
            sess.push_audio(
                AudioChunkIn(
                    samples=dummy_blk,
                    sample_rate=sr,
                    codec=AudioCodec.PCM_S16LE,
                    seq=1,
                    pts_us=0,
                )
            )
            sess.close()
            # Clear warmup dummy reference so real user audio isn't confused with warmup
            self._prompt_condition = None
            self._mel2 = None
            self._style2 = None

    def set_reference_audio(self, audio_f32: np.ndarray, sample_rate: int) -> None:
        loaded = self.require_loaded()
        torch = loaded.torch
        torchaudio = loaded.torchaudio
        sr = loaded.sr
        max_samples = int(sr * self.settings.voice_max_prompt_length_s)

        with self.infer_lock, torch.inference_mode():
            if sample_rate == sr:
                ref_tensor = torch.from_numpy(
                    np.asarray(audio_f32[:max_samples], dtype=np.float32)
                ).to(loaded.device)
            elif torchaudio is not None:
                raw_max = int(sample_rate * self.settings.voice_max_prompt_length_s) + sample_rate
                raw_tensor = torch.from_numpy(np.asarray(audio_f32[:raw_max], dtype=np.float32)).to(
                    loaded.device
                )
                ref_tensor = torchaudio.functional.resample(raw_tensor, sample_rate, sr)[
                    :max_samples
                ]
            else:
                resampled = resample_audio_linear(audio_f32, sample_rate, sr)
                ref_tensor = torch.from_numpy(resampled[:max_samples]).to(loaded.device)
            waves_16k = torchaudio.functional.resample(ref_tensor, sr, 16000)
            s_ori = loaded.semantic_fn(waves_16k.unsqueeze(0))
            feat2 = torchaudio.compliance.kaldi.fbank(
                waves_16k.unsqueeze(0),
                num_mel_bins=80,
                dither=0,
                sample_frequency=16000,
            )
            feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
            style2 = loaded.campplus_model(feat2.unsqueeze(0))
            mel2 = loaded.to_mel(ref_tensor.unsqueeze(0))
            target2_lengths = torch.LongTensor([mel2.size(2)]).to(mel2.device)
            prompt_condition = loaded.model.length_regulator(
                s_ori, ylens=target2_lengths, n_quantizers=3, f0=None
            )[0]

            self._prompt_condition = prompt_condition
            self._mel2 = mel2
            self._style2 = style2

    def infer_window(
        self,
        *,
        input_wav_res: Any,
        skip_head: int,
        skip_tail: int,
        return_length: int,
        diffusion_steps: int,
        cfg_rate: float,
        ce_dit_diff_s: float,
    ) -> Any:
        """Run one causal sliding-window inference through Seed-VC."""
        loaded = self.require_loaded()
        torch = loaded.torch
        if self._prompt_condition is None or self._mel2 is None or self._style2 is None:
            raise RuntimeError("No reference audio loaded for Seed-VC.")

        s_alt = loaded.semantic_fn(input_wav_res.unsqueeze(0))
        ce_frames = int(ce_dit_diff_s * 50)
        s_alt = s_alt[:, ce_frames:]
        target_len = int(
            (skip_head + return_length + skip_tail - ce_frames)
            / 50
            * loaded.sr
            // loaded.hop_length
        )
        target_lengths = torch.LongTensor([max(1, target_len)]).to(s_alt.device)
        cond = loaded.model.length_regulator(s_alt, ylens=target_lengths, n_quantizers=3, f0=None)[
            0
        ]
        cat_cond = torch.cat([self._prompt_condition, cond], dim=1)

        with torch.autocast(device_type=loaded.device.type, dtype=loaded.dtype):
            vc_target = loaded.model.cfm.inference(
                cat_cond,
                torch.LongTensor([cat_cond.size(1)]).to(self._mel2.device),
                self._mel2,
                self._style2,
                None,
                n_timesteps=diffusion_steps,
                inference_cfg_rate=cfg_rate,
            )
            vc_target = vc_target[:, :, self._mel2.size(-1) :]

        # Keep HiFT outside fp16/bf16 autocast so torch.stft/istft stay float32
        vc_wave = loaded.vocoder_fn(vc_target.float()).squeeze()

        output_len = return_length * loaded.sr // 50
        tail_len = skip_tail * loaded.sr // 50
        end_idx = -tail_len if tail_len > 0 else None
        return vc_wave[-output_len - tail_len : end_idx]

    def create_session(self, config: AudioSessionConfig) -> VoiceSession:
        return SeedVCVoiceSession(self, config)

    def close(self) -> None:
        self._prompt_condition = None
        self._mel2 = None
        self._style2 = None
        self._loaded = None
