"""Tests for RMS hangover voice VAD."""

from __future__ import annotations

import numpy as np
from metamorph_engine.pipelines.base import RmsHangoverVad


def _tone(amplitude: float, length: int, sr: int = 22050, freq: float = 220.0) -> np.ndarray:
    t = np.arange(length, dtype=np.float32) / float(sr)
    return (amplitude * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


def test_rms_vad_subframe_peak_catches_late_speech_onset() -> None:
    """20ms sub-frame peak detects speech starting at the end of a 240ms block."""
    sr = 22050
    chunk = np.zeros(5292, dtype=np.float32)
    # Put 20ms of -19.5 dBFS speech only in the trailing 441 samples; whole-block RMS is ~-30.3 dBFS
    chunk[-441:] = _tone(0.15, 441, sr=sr)

    vad = RmsHangoverVad(threshold_db=-25.0, hangover_s=0.0)
    assert vad.is_speech(chunk, sr) is True


def test_rms_vad_adaptive_noise_floor_rejects_steady_hum_and_passes_speech() -> None:
    """Stationary background hum lifts the noise floor without swallowing dynamic speech."""
    sr = 22050
    vad = RmsHangoverVad(
        threshold_db=-45.0,
        hangover_s=0.0,
        adaptive_noise_floor=True,
        noise_margin_db=10.0,
    )
    # Steady -40 dBFS hum across all sub-frames (peak ~= floor)
    hum = _tone(0.01414, 5292, sr=sr, freq=120.0)
    assert vad.is_speech(hum, sr) is False
    assert vad.noise_floor_db is not None and -42.0 <= vad.noise_floor_db <= -38.0
    assert vad.is_speech(hum, sr) is False

    # Dynamic -12 dBFS speech modulates above both threshold and noise floor
    t = np.arange(5292, dtype=np.float32) / float(sr)
    speech = 0.35 * np.sin(2.0 * np.pi * 220.0 * t) * (0.5 + 0.5 * np.sin(2.0 * np.pi * 12.0 * t))
    floor_before = vad.noise_floor_db
    assert vad.is_speech(speech.astype(np.float32), sr) is True
    assert vad.noise_floor_db == floor_before


def test_rms_vad_hangover_handles_short_and_default_durations() -> None:
    """Short hangover <= chunk_s keeps 1 tail block; default 0.3s / 0.24s also keeps 1 tail."""
    sr = 22050
    voiced = _tone(0.2, 5292, sr=sr)
    silent = np.zeros(5292, dtype=np.float32)

    short_vad = RmsHangoverVad(threshold_db=-45.0, hangover_s=0.20)
    assert short_vad.is_speech(voiced, sr) is True
    assert short_vad.is_speech(silent, sr) is True
    assert short_vad.is_speech(silent, sr) is False

    default_vad = RmsHangoverVad(threshold_db=-45.0, hangover_s=0.30)
    assert default_vad.is_speech(voiced, sr) is True
    assert default_vad.is_speech(silent, sr) is True
    assert default_vad.is_speech(silent, sr) is False
