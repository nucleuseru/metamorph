from typing import Dict, Any
import torch
from PIL import Image
from io import BytesIO
from diffusers import Flux2KleinKVPipeline, AutoencoderKL
from config import settings

pipe = None


def get_pipeline():
    global pipe
    if pipe is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

        if settings.use_tf32 and torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

        vae = AutoencoderKL.from_pretrained(settings.vae_model_id, torch_dtype=dtype)
        pipe = Flux2KleinKVPipeline.from_pretrained(
            settings.model_id, vae=vae, torch_dtype=dtype
        )
        pipe.load_lora_weights(settings.lora_model_id)

        if settings.use_channels_last and torch.cuda.is_available():
            pipe.transformer.to(memory_format=torch.channels_last)
            pipe.vae.to(memory_format=torch.channels_last)

        pipe.to(device)

        if settings.enable_torch_compile and torch.cuda.is_available():
            pipe.transformer = torch.compile(pipe.transformer, mode="reduce-overhead")

    return pipe


def run_inference(frame, session_data: Dict[str, Any]):
    try:
        from av import VideoFrame

        local_pipe = get_pipeline()
        device = "cuda" if torch.cuda.is_available() else "cpu"

        if "prompt_embeds" not in session_data:
            prompt = session_data.get("prompt", "")
            enhanced_prompt = (
                f"{prompt}, keeping the exact pose, body posture, facial expression, eye gaze, background, "
                "and lighting from the camera feed, swapping the identity of the person with the character in the reference images. "
                "High quality, realistic character swap, seamless blend."
            )

            with torch.no_grad():
                enc_out = local_pipe.encode_prompt(prompt=enhanced_prompt)
                if len(enc_out) == 3:
                    prompt_embeds, pooled_prompt_embeds, text_ids = enc_out
                else:
                    prompt_embeds, text_ids = enc_out
                    pooled_prompt_embeds = None

            session_data["prompt_embeds"] = prompt_embeds
            if pooled_prompt_embeds is not None:
                session_data["pooled_prompt_embeds"] = pooled_prompt_embeds
            session_data["text_ids"] = text_ids

            if (
                hasattr(local_pipe, "text_encoder")
                and local_pipe.text_encoder is not None
            ):
                local_pipe.text_encoder.to("cpu")

            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        prompt_embeds = session_data["prompt_embeds"]
        pooled_prompt_embeds = session_data.get("pooled_prompt_embeds")
        text_ids = session_data["text_ids"]

        pil_frame = frame.to_image().convert("RGB")

        if "uploaded_images_pil" not in session_data:
            uploaded_images = []
            for img_bytes in session_data.get("images", []):
                try:
                    uploaded_images.append(
                        Image.open(BytesIO(img_bytes)).convert("RGB")
                    )
                except Exception as e:
                    print(f"Error loading uploaded reference image: {e}")
            session_data["uploaded_images_pil"] = uploaded_images

        uploaded_images = session_data["uploaded_images_pil"]

        last_inference_pil = session_data.get("last_inference_pil")
        if last_inference_pil is not None:
            ref_images = [last_inference_pil] + uploaded_images + [pil_frame]
        else:
            ref_images = uploaded_images + [pil_frame]

        res = settings.inference_resolution
        ref_images_resized = [img.resize((res, res)) for img in ref_images]

        pipe_kwargs = {
            "prompt_embeds": prompt_embeds,
            "text_ids": text_ids,
            "image": ref_images_resized,
            "height": res,
            "width": res,
            "num_inference_steps": 4,
            "generator": torch.Generator(device=device).manual_seed(42),
            "joint_attention_kwargs": {"scale": settings.lora_scale},
        }
        if pooled_prompt_embeds is not None:
            pipe_kwargs["pooled_prompt_embeds"] = pooled_prompt_embeds

        output_images = local_pipe(**pipe_kwargs).images
        output_image = output_images[0]

        session_data["last_inference_pil"] = output_image

        output_image = output_image.resize((frame.width, frame.height))
        new_frame = VideoFrame.from_image(output_image)
        new_frame.pts = frame.pts
        new_frame.time_base = frame.time_base
        return new_frame

    except Exception as e:
        print(f"Error during FLUX inference: {e}")
        return frame
