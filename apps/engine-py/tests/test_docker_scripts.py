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

    prune_script = SCRIPTS_DIR / "prune_xlsr.py"
    assert prune_script.is_file()
    assert os.access(prune_script, os.X_OK)
    res_help = subprocess.run(
        ["python3", str(prune_script), "--help"],
        capture_output=True,
        text=True,
    )
    assert res_help.returncode == 0, res_help.stderr
    assert "--layers" in res_help.stdout


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
        "--index-strategy unsafe-best-match",
        '"setuptools<82"',
        "librosa>=0.11.0",
        "numpy==2.2.6",
        "pillow==12.2.0",
        "ENGINE_ASYNC_STARTUP=true",
    ):
        assert expected in docker_content, f"Dockerfile missing expected line: {expected}"


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
