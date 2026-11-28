"""Tests for Docker entrypoint, provisioning scripts, and Ed25519 key tooling."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]
ENTRYPOINT = ENGINE_DIR / "docker" / "entrypoint.sh"
SCRIPTS_DIR = ENGINE_DIR / "scripts"
ALL_SHELL_SCRIPTS = [
    ENTRYPOINT,
    SCRIPTS_DIR / "download_models.sh",
    SCRIPTS_DIR / "prewarm_cache.sh",
]


def test_shell_scripts_are_executable_and_valid_bash() -> None:
    for script in ALL_SHELL_SCRIPTS:
        assert script.is_file(), f"Missing script: {script}"
        assert os.access(script, os.X_OK), f"Script is not executable: {script}"
        res = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        assert res.returncode == 0, f"bash -n failed for {script}: {res.stderr}"

    for script_name, flag in (
        ("prune_xlsr.py", "--layers"),
        ("optimize_voice_checkpoints.py", "--cache-dir"),
    ):
        py_script = SCRIPTS_DIR / script_name
        assert py_script.is_file()
        assert os.access(py_script, os.X_OK)
        res_help = subprocess.run(
            ["python3", str(py_script), "--help"],
            capture_output=True,
            text=True,
        )
        assert res_help.returncode == 0, res_help.stderr
        assert flag in res_help.stdout


def test_entrypoint_resolves_volume_paths_and_respects_overrides(tmp_path: Path) -> None:
    env = {
        "PATH": os.environ["PATH"],
        "ENGINE_BACKEND": "mock",
        "MODEL_VOLUME_DIR": str(tmp_path),
    }
    res = subprocess.run(
        [str(ENTRYPOINT), "--print-env"],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    parsed = dict(line.split("=", 1) for line in res.stdout.strip().splitlines() if "=" in line)
    assert parsed["MODEL_VOLUME_DIR"] == str(tmp_path)
    assert parsed["HF_HOME"] == str(tmp_path / "hf_cache")
    assert parsed["ENGINE_VOICE_CACHE_DIR"] == str(tmp_path / "checkpoints" / "seed-vc")
    expected_dit = (
        tmp_path
        / "checkpoints"
        / "JoyAI-Video-Edit"
        / "dit"
        / "joyai_video_edit_dit_1101_face++.pth"
    )
    assert parsed["ENGINE_VIDEO_DIT_CKPT"] == str(expected_dit)
    assert parsed["JOYOMNI_CACHE_ROOT"] == str(tmp_path / "cache" / "cpu")
    assert parsed["JOYOMNI_FP8_IMG"] == "1"
    assert parsed["JOYOMNI_FP8_TXT"] == "1"
    assert parsed["JOYOMNI_CUDA_GRAPH"] == "1"

    # Explicit override must win
    custom_dit = str(tmp_path / "custom.pth")
    env["ENGINE_VIDEO_DIT_CKPT"] = custom_dit
    res2 = subprocess.run(
        [str(ENTRYPOINT), "--print-env"],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    parsed2 = dict(line.split("=", 1) for line in res2.stdout.strip().splitlines() if "=" in line)
    assert parsed2["ENGINE_VIDEO_DIT_CKPT"] == custom_dit


def test_github_workflow_builds_and_deploys_all_targets() -> None:
    repo_root = ENGINE_DIR.parents[1]
    workflow = repo_root / ".github" / "workflows" / "engine-docker.yml"
    dockerfile = ENGINE_DIR / "Dockerfile"
    assert workflow.is_file(), f"Missing workflow: {workflow}"
    assert dockerfile.is_file(), f"Missing Dockerfile: {dockerfile}"

    content = workflow.read_text(encoding="utf-8")
    for required in (
        "apps/engine-py/Dockerfile",
        "docker/login-action",
        "docker/build-push-action",
        "DOCKERHUB_USERNAME",
        "DOCKERHUB_TOKEN",
        "- mock",
        "- voice",
        "- full",
        "fromJSON(needs.test.outputs.targets)",
        (
            "INSTALL_SAGE_ATTN=${{ github.event_name == 'workflow_dispatch' "
            "&& inputs.install_sage_attn == false && '0' || '1' }}"
        ),
    ):
        assert required in content, f"Workflow missing expected entry: {required}"

    job_if_lines = [line for line in content.splitlines() if line.startswith("    if:")]
    assert all("matrix." not in line for line in job_if_lines)

    docker_content = dockerfile.read_text(encoding="utf-8")
    dockerignore_content = (ENGINE_DIR / "Dockerfile.dockerignore").read_text(encoding="utf-8")
    assert "ARG INSTALL_SAGE_ATTN=1" in docker_content
    assert "ARG BUNDLE_VOICE_WEIGHTS=1" in docker_content
    assert "zstd" in docker_content
    assert "vendor/JoyAI-Video-Edit/deploy/rv2v_reference" in dockerignore_content
    assert "BUNDLE_VOICE_WEIGHTS=" in content
    assert 'NVCC_APPEND_FLAGS="--threads ${MAX_JOBS}"' in docker_content
    assert "python -m pip" not in docker_content
    assert "setup.py install" not in docker_content
    assert "uv pip install --python /app/.venv/bin/python --no-build-isolation --no-deps" in (
        docker_content
    )
    for expected in (
        "FROM ghcr.io/astral-sh/uv:0.12 AS uv-bin",
        "FROM python:3.12-slim AS voice-builder",
        "FROM python:3.12-slim AS voice",
        "FROM ubuntu:22.04 AS full",
        'ARG CUDA_ARCHS="89;90a;100a;120a"',
        "NVIDIA_VISIBLE_DEVICES=all",
        "--optimize-voice-ckpts",
        "--skip-campplus",
        "--index-strategy unsafe-best-match",
        '"nvidia-nvjpeg-cu12>=12.3.5,<13"',
        "nvidia/nvjpeg/lib",
        "libnvjpeg.so.12",
        '"setuptools<82"',
        "numpy==2.2.6",
        "pillow==12.2.0",
        "ENGINE_ASYNC_STARTUP=true",
        "CUDA_ARCHS=${{ inputs.cuda_archs || '89;90a;100a;120a' }}",
        'default: "89;90a;100a;120a"',
    ):
        assert expected in (docker_content + "\n" + content), (
            f"Dockerfile/workflow missing expected line: {expected}"
        )

    voice_section = docker_content.split("AS voice-builder", 1)[1].split(
        "# Stage 3: Full GPU builder", 1
    )[0]
    for forbidden in ("ffmpeg", "sox", "librosa", "soundfile", "torch/bin"):
        assert forbidden not in voice_section, f"voice stage should not contain {forbidden}"
    assert "uv sync --frozen --no-dev --inexact" not in voice_section

    full_builder_section = docker_content.split("AS full-builder", 1)[1].split(
        "# Stage 4: Final full GPU image", 1
    )[0]
    for required_kept in ("site-packages/torch/include", "site-packages/torch/bin"):
        assert required_kept not in full_builder_section, (
            f"full-builder should not delete {required_kept}"
        )
    assert "uv sync --frozen --no-dev --inexact" not in full_builder_section

    full_runtime_section = docker_content.split("AS full\n", 1)[1]
    for forbidden in (
        "ffmpeg",
        "sox",
        "libsndfile1",
        "librosa",
        "soundfile",
        "imageio-ffmpeg",
        "COPY --from=uv-bin",
    ):
        assert forbidden not in full_runtime_section, (
            f"full runtime stage should not contain {forbidden}"
        )


def test_download_models_dry_run_covers_entrypoint_checkpoints(tmp_path: Path) -> None:
    res = subprocess.run(
        [
            str(SCRIPTS_DIR / "download_models.sh"),
            "--dest",
            str(tmp_path / "checkpoints"),
            "--all",
            "--dry-run",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    out = res.stdout
    for expected in (
        "Plachta/Seed-VC",
        "DiT_uvit_tat_xlsr_ema.pth",
        "FunAudioLLM/CosyVoice-300M",
        "hift.pt",
        "funasr/campplus",
        "campplus_cn_common.bin",
        "facebook/wav2vec2-xls-r-300m",
        "jdopensource/JoyAI-Video-Edit",
        "joyai_video_edit_dit_1101_face++.pth",
        "XiaomiMiMo/MiMo-VL-7B-RL-2508",
    ):
        assert expected in out, f"download_models.sh missing expected asset: {expected}"


def test_entrypoint_warns_for_dual_modality_on_32gb_gpu(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    nvidia_smi = fake_bin / "nvidia-smi"
    nvidia_smi.write_text("#!/usr/bin/env bash\necho 'NVIDIA GeForce RTX 5090, 32607'\n")
    nvidia_smi.chmod(0o755)

    ckpt_root = tmp_path / "checkpoints"
    dit_path = ckpt_root / "JoyAI-Video-Edit" / "dit" / "joyai_video_edit_dit_1101_face++.pth"
    dit_path.parent.mkdir(parents=True)
    dit_path.write_bytes(b"")
    (ckpt_root / "JoyAI-Video-Edit" / "vae").mkdir(parents=True)
    (ckpt_root / "MiMo-VL-7B-RL-2508").mkdir(parents=True)

    base_env = {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "MODEL_VOLUME_DIR": str(tmp_path),
        "ENGINE_BACKEND": "gpu",
        "ENGINE_ENABLE_VIDEO": "true",
        "ENGINE_ENABLE_VOICE": "true",
        "ENGINE_CMD": "true",
    }
    dual = subprocess.run(
        [str(ENTRYPOINT)],
        env=base_env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert "WARNING: Video + Voice together" in dual.stderr
    assert "RTX PRO 6000" in dual.stderr

    video_only = subprocess.run(
        [str(ENTRYPOINT)],
        env={**base_env, "ENGINE_ENABLE_VOICE": "false"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert "WARNING: Video + Voice together" not in video_only.stderr


def test_entrypoint_prefers_bundled_voice_weights_and_extracts_cache_archive(
    tmp_path: Path,
) -> None:
    bundled_dir = tmp_path / "bundled_seedvc"
    bundled_dir.mkdir()
    (bundled_dir / "DiT_uvit_tat_xlsr_ema.pth").write_bytes(b"dit")

    vol_dir = tmp_path / "vol"
    cache_src = tmp_path / "cache_src"
    (cache_src / "torchinductor").mkdir(parents=True)
    (cache_src / "torchinductor" / "cached_kernel.bin").write_bytes(b"ok")
    (cache_src / ".metamorph_compile_mode").write_text(
        "max-autotune-no-cudagraphs\n", encoding="utf-8"
    )

    vol_cache_dir = vol_dir / "cache"
    vol_cache_dir.mkdir(parents=True)
    archive_path = vol_cache_dir / "cpu.tar.gz"
    subprocess.run(
        ["tar", "-czf", str(archive_path), "-C", str(cache_src), "."],
        check=True,
    )

    local_cache = tmp_path / "local_ssd_cache"
    env = {
        "PATH": os.environ["PATH"],
        "ENGINE_BACKEND": "mock",
        "MODEL_VOLUME_DIR": str(vol_dir),
        "ENGINE_BUNDLED_VOICE_DIR": str(bundled_dir),
        "JOYOMNI_CACHE_ROOT": str(local_cache),
        "ENGINE_CMD": "true",
    }

    env_res = subprocess.run(
        [str(ENTRYPOINT), "--print-env"],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    parsed = dict(line.split("=", 1) for line in env_res.stdout.strip().splitlines() if "=" in line)
    assert parsed["ENGINE_VOICE_CACHE_DIR"] == str(bundled_dir)
    assert parsed["JOYOMNI_VOLUME_CACHE_ROOT"] == str(vol_cache_dir / "cpu")

    subprocess.run([str(ENTRYPOINT)], env=env, capture_output=True, text=True, check=True)
    assert (local_cache / "torchinductor" / "cached_kernel.bin").read_bytes() == b"ok"
    assert (local_cache / ".metamorph_compile_mode").read_text(
        encoding="utf-8"
    ).strip() == "max-autotune-no-cudagraphs"

    # Voice-only pods (ENGINE_ENABLE_VIDEO=false) must skip video compile cache seeding
    voice_cache = tmp_path / "voice_only_cache"
    voice_res = subprocess.run(
        [str(ENTRYPOINT)],
        env={
            **env,
            "ENGINE_ENABLE_VIDEO": "false",
            "ENGINE_ENABLE_VOICE": "true",
            "JOYOMNI_CACHE_ROOT": str(voice_cache),
        },
        capture_output=True,
        text=True,
        check=True,
    )
    assert not (voice_cache / "torchinductor" / "cached_kernel.bin").exists()
    assert "Extracting compile cache archive" not in voice_res.stderr
    assert "Seeding local compile cache" not in voice_res.stderr


def test_download_models_flags_skip_campplus_force_and_pruned_xlsr_skip(tmp_path: Path) -> None:
    ckpt_dir = tmp_path / "checkpoints"
    pruned_dir = ckpt_dir / "seed-vc" / "facebook__wav2vec2-xls-r-300m-l12-fp16"
    pruned_dir.mkdir(parents=True)
    (pruned_dir / "model.safetensors").write_bytes(b"pruned")

    res = subprocess.run(
        [
            str(SCRIPTS_DIR / "download_models.sh"),
            "--dest",
            str(ckpt_dir),
            "--voice",
            "--skip-campplus",
            "--force",
            "--dry-run",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "campplus_cn_common.bin" not in res.stdout
    assert "force_download=True" in res.stdout
    assert "facebook/wav2vec2-xls-r-300m" in res.stdout

    # Without --force, existing pruned XLSR skips raw XLSR snapshot download
    res_skip = subprocess.run(
        [
            str(SCRIPTS_DIR / "download_models.sh"),
            "--dest",
            str(ckpt_dir),
            "--voice",
            "--skip-campplus",
            "--dry-run",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "skipping raw download" in res_skip.stdout
    assert "snapshot_download" not in res_skip.stdout


def test_entrypoint_5090_skips_sageattention_probe_when_video_disabled(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    nvidia_smi = fake_bin / "nvidia-smi"
    nvidia_smi.write_text("#!/usr/bin/env bash\necho 'NVIDIA GeForce RTX 5090, 32607'\n")
    nvidia_smi.chmod(0o755)

    res = subprocess.run(
        [str(ENTRYPOINT), "--print-env"],
        env={
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "ENGINE_BACKEND": "gpu",
            "ENGINE_ENABLE_VIDEO": "false",
            "ENGINE_ENABLE_VOICE": "true",
        },
        capture_output=True,
        text=True,
        check=True,
    )
    parsed = dict(line.split("=", 1) for line in res.stdout.strip().splitlines() if "=" in line)
    assert parsed["JOYOMNI_SAGE_ATTN"] == "0"
    assert parsed["JOYOMNI_FA4_ATTN"] == "0"


def test_prewarm_cache_preserves_mode_sidecar_before_atomic_write() -> None:
    prewarm_src = (SCRIPTS_DIR / "prewarm_cache.sh").read_text(encoding="utf-8")
    assert 'rm -f "${JOYOMNI_VOLUME_CACHE_ROOT}.compile_mode"' not in prewarm_src
    assert "force=True" in prewarm_src
    assert "warmed_shapes=warmed_shapes" in prewarm_src
