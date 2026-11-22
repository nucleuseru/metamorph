# Vendor Submodules

External engines are tracked as git submodules under `vendor/` and trimmed via `git sparse-checkout` (`--no-cone`) so only runtime/inference code is checked out.

## `vendor/JoyAI-Video-Edit`

- **Upstream**: `https://github.com/nucleuseru/JoyAI-Video-Edit`
- **Purpose**: Real-time reference + video-to-video editing (body swapping, streaming DiT + xVAE pipeline).
- **Included**:
  - `deploy/xvideo/` — Streaming models, serving, low-VRAM, config
  - `deploy/joyomni_ops/` — Custom CUDA/C++ ops (`csrc/`, `include/`, `joyomni_ops/`, `setup.py`)
  - `deploy/static/`, `deploy/rv2v_reference/`, `deploy/requirements.txt`, `deploy/run_server.sh`, `deploy/sageattention-cudagraph-stream.patch`
  - `DEPLOYMENT.md`, `README.md`, `LICENSE`
- **Excluded via sparse-checkout**:
  - `assets/`, `training/`, `deploy/joyomni_ops/tests/`

## `vendor/seed-vc`

- **Upstream**: `https://github.com/nucleuseru/seed-vc.git`
- **Purpose**: Real-time zero-shot voice cloning.
- **Included**:
  - `modules/`, `configs/` — Core model architectures (`v2/`, `campplus/`, `bigvgan/`, `hifigan/`, `astral_quantization/`, `openvoice/`) and YAML/JSON configs
  - `real-time-gui.py`, `seed_vc_wrapper.py`, `inference.py`, `inference_v2.py`, `hf_utils.py`
  - `campplus_cn_common.bin`, `requirements.txt`, `README.md`, `LICENSE`
- **Excluded via sparse-checkout**:
  - `assets/`, `examples/`, `baselines/`, `data/`
  - `train.py`, `train_v2.py`, `optimizers.py`, `eval.py`, `EVAL.md`
  - `app.py`, `app_svc.py`, `app_vc.py`, `app_vc_v2.py`
  - `conda-nix-vc-py310.yaml`, `requirements-mac.txt`, `README-JA.md`, `README-ZH.md`

## Fresh Clone Setup

When cloning the repository on a new machine, initialize submodules and re-apply sparse-checkout if needed:

```bash
git submodule update --init --recursive
```
