"""Tests for Docker entrypoint, provisioning scripts, and Ed25519 key tooling."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from metamorph_engine.auth import JWTAuthenticator
from metamorph_engine.config import EngineSettings

ENGINE_DIR = Path(__file__).resolve().parents[1]
ENTRYPOINT = ENGINE_DIR / "docker" / "entrypoint.sh"
SCRIPTS_DIR = ENGINE_DIR / "scripts"
ALL_SHELL_SCRIPTS = [
    ENTRYPOINT,
    SCRIPTS_DIR / "build-image.sh",
    SCRIPTS_DIR / "download_models.sh",
    SCRIPTS_DIR / "gen-jwt-keys.sh",
]


def test_shell_scripts_are_executable_and_valid_bash() -> None:
    for script in ALL_SHELL_SCRIPTS:
        assert script.is_file(), f"Missing script: {script}"
        assert os.access(script, os.X_OK), f"Script is not executable: {script}"
        res = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        assert res.returncode == 0, f"bash -n failed for {script}: {res.stderr}"


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


def test_gen_jwt_keys_and_mint_token_integrate_with_authenticator(tmp_path: Path) -> None:
    env = {**os.environ, "PYTHON_BIN": sys.executable}
    gen_res = subprocess.run(
        [str(SCRIPTS_DIR / "gen-jwt-keys.sh"), "--out-dir", str(tmp_path)],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    priv_path = tmp_path / "private_ed25519.pem"
    pub_path = tmp_path / "public_ed25519.pem"
    assert priv_path.is_file()
    assert pub_path.is_file()
    assert "ENGINE_JWT_PUBLIC_KEY=" in gen_res.stdout

    # Extract escaped ENGINE_JWT_PUBLIC_KEY line
    pub_escaped = ""
    for line in gen_res.stdout.splitlines():
        if line.startswith("ENGINE_JWT_PUBLIC_KEY="):
            pub_escaped = line.split("=", 1)[1].strip('"')
            break
    assert "\\n" in pub_escaped

    token_res = subprocess.run(
        [
            str(SCRIPTS_DIR / "gen-jwt-keys.sh"),
            "--mint-token",
            "--private-key",
            str(priv_path),
            "--user-id",
            "usr-42",
            "--instance-id",
            "inst-99",
            "--modalities",
            "voice,video",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    token = token_res.stdout.strip()

    settings = EngineSettings(
        backend="mock",
        instance_id="inst-99",
        user_id="usr-42",
        jwt_public_key=pub_escaped,
    )
    auth = JWTAuthenticator(settings)
    claims = auth.verify_token(token)
    assert claims.sub == "usr-42"
    assert claims.aud == "inst-99"
    assert claims.modalities == ("voice", "video")


def test_build_image_dry_run_command() -> None:
    res = subprocess.run(
        [
            str(SCRIPTS_DIR / "build-image.sh"),
            "--target",
            "voice",
            "--image",
            "ghcr.io/metamorph/engine",
            "--tag",
            "v1-voice",
            "--dry-run",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    out = res.stdout.strip()
    assert "--target voice" in out
    assert "--tag ghcr.io/metamorph/engine:v1-voice" in out
    assert str(ENGINE_DIR / "Dockerfile") in out

    full_default = subprocess.run(
        [str(SCRIPTS_DIR / "build-image.sh"), "--target", "full", "--dry-run"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "INSTALL_SAGE_ATTN=1" in full_default.stdout

    full_no_sage = subprocess.run(
        [str(SCRIPTS_DIR / "build-image.sh"), "--target", "full", "--no-sage-attn", "--dry-run"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "INSTALL_SAGE_ATTN=0" in full_no_sage.stdout


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
        "INSTALL_SAGE_ATTN=${{ inputs.install_sage_attn == false && '0' || '1' }}",
    ):
        assert required in content, f"Workflow missing expected entry: {required}"

    docker_content = dockerfile.read_text(encoding="utf-8")
    assert "ARG INSTALL_SAGE_ATTN=1" in docker_content
    assert 'NVCC_APPEND_FLAGS="--threads ${MAX_JOBS}"' in docker_content
    assert "python -m pip" not in docker_content
    assert "setup.py install" not in docker_content
    assert "uv pip install --python /app/.venv/bin/python --no-build-isolation --no-deps" in (
        docker_content
    )
    for expected in (
        "librosa>=0.11.0",
        "numpy==2.2.6",
        "pillow==12.2.0",
        "silero-vad>=5.1.2",
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
        "btbtyler09/Qwen3.6-27B-GPTQ-4bit",
        "face_detection_yunet_2023mar.onnx",
        "yolov8n.onnx",
        "imgsz=320, opset=12",
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
