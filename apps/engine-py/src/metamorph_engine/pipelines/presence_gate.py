"""Two-phase debounced face and full-body presence gate for JoyAI streaming video."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from PIL import Image

from metamorph_engine.pipelines.base import VideoGateEvent
from metamorph_engine.protocol import DetectionMode

logger = logging.getLogger("metamorph_engine.presence_gate")

FaceBox = tuple[float, float, float, float]
FaceCenter = tuple[float, float, float]


@dataclass(frozen=True, slots=True)
class PresenceGateConfig:
    """Thresholds and hysteresis counters for startup settle and mid-session presence monitoring."""

    mode: DetectionMode = "off"
    face_score_thresh: float = 0.35
    face_min_below_ratio: float = 0.20
    face_center_margin: float = 0.35
    face_move_eps: float = 0.02
    face_settle_drift: float = 0.05
    face_stable_frames: int = 24
    face_present_min_ratio: float = 0.15
    face_present_edge_margin: float = 0.0
    person_conf: float = 0.4
    detection_stride: int = 2
    absent_frames: int = 12
    return_frames: int = 24
    body_flip_frames: int = 6
    fail_open_missing_person_model: bool = True


@dataclass(frozen=True, slots=True)
class PresenceGateDecision:
    """Outcome of evaluating one video frame through the presence gate."""

    allow_frame: bool
    reset_session: bool = False
    clear_pending: bool = False
    event: VideoGateEvent | None = None


@dataclass(frozen=True, slots=True)
class PresenceGateDetectors:
    """Detector callbacks bound to JoyAI ONNX YuNet / YOLOv8n helpers."""

    check_face_gate: Callable[[Image.Image], tuple[str | None, FaceCenter | None, int]]
    check_full_body_gate: Callable[[Image.Image, FaceCenter | None], str | None]
    detect_faces: Callable[[Image.Image], tuple[list[FaceBox] | None, float, float]]
    face_present: Callable[[list[FaceBox] | None, float, float, float, float], bool]
    face_center: Callable[[list[FaceBox] | None, float, float, float, float], FaceCenter | None]
    person_present: Callable[[Image.Image], bool]


class PresenceGateController:
    """Two-phase stateful gate (`settling` -> `active` <-> `absent_hold`) with event dedup."""

    def __init__(
        self,
        config: PresenceGateConfig,
        detectors: PresenceGateDetectors,
    ) -> None:
        self._cfg = config
        self._det = detectors

        self._phase: Literal["settling", "active", "absent_hold"] = "settling"
        self._stable_count = 0
        self._cx: float | None = None
        self._cy: float | None = None
        self._csz: float | None = None
        self._settle_ax: float | None = None
        self._settle_ay: float | None = None
        self._settle_asz: float | None = None

        self._stride_tick = 0
        self._face_last = True
        self._person_last = True
        self._full_body_reason: str | None = None
        self._absent_count = 0
        self._present_count = 0
        self._body_miss_count = 0
        self._hold_reason = "no_person"
        self._hold_event_type: Literal["waiting_face", "no_person"] = "no_person"

        self._warned_missing_person_model = False
        self._last_emitted: tuple[str, str | None] | None = None

    @property
    def phase(self) -> Literal["settling", "active", "absent_hold"]:
        """Return current gate phase."""
        return self._phase

    def update_mode(self, mode: DetectionMode) -> None:
        """Reset state cleanly if detection mode changes mid-session."""
        if mode == self._cfg.mode:
            return
        self._cfg = PresenceGateConfig(
            mode=mode,
            face_score_thresh=self._cfg.face_score_thresh,
            face_min_below_ratio=self._cfg.face_min_below_ratio,
            face_center_margin=self._cfg.face_center_margin,
            face_move_eps=self._cfg.face_move_eps,
            face_settle_drift=self._cfg.face_settle_drift,
            face_stable_frames=self._cfg.face_stable_frames,
            face_present_min_ratio=self._cfg.face_present_min_ratio,
            face_present_edge_margin=self._cfg.face_present_edge_margin,
            person_conf=self._cfg.person_conf,
            detection_stride=self._cfg.detection_stride,
            absent_frames=self._cfg.absent_frames,
            return_frames=self._cfg.return_frames,
            body_flip_frames=self._cfg.body_flip_frames,
            fail_open_missing_person_model=self._cfg.fail_open_missing_person_model,
        )
        self.reset()

    def reset(self) -> None:
        """Reset gate back to startup settle phase."""
        self._phase = "settling"
        self._reset_settle()
        self._stride_tick = 0
        self._face_last = True
        self._person_last = True
        self._full_body_reason = None
        self._absent_count = 0
        self._present_count = 0
        self._body_miss_count = 0
        self._hold_reason = "no_person"
        self._hold_event_type = "no_person"
        self._last_emitted = None

    def evaluate(self, image: Image.Image) -> PresenceGateDecision:
        """Evaluate an incoming video frame and return routing/event decisions."""
        if self._cfg.mode == "off":
            return PresenceGateDecision(allow_frame=True)
        if self._phase == "settling":
            return self._eval_settling(image)
        return self._eval_monitoring(image)

    def _reset_settle(self) -> None:
        self._stable_count = 0
        self._settle_ax = None
        self._settle_ay = None
        self._settle_asz = None

    def _make_event(
        self,
        event_type: Literal["waiting_face", "no_person", "editing", "session_reset", "dropped"],
        reason: str | None,
        *,
        frame_accepted: bool,
        force_emit: bool = False,
    ) -> VideoGateEvent:
        key = (event_type, reason)
        should_emit = force_emit or (self._last_emitted != key)
        if should_emit:
            self._last_emitted = key
        return VideoGateEvent(
            event_type=event_type,
            reason=reason,
            frame_accepted=frame_accepted,
            emit=should_emit,
        )

    def _resolve_full_body_gate(self, image: Image.Image, center: FaceCenter | None) -> str | None:
        reason = self._det.check_full_body_gate(image, center)
        if reason == "full_body_unavailable" and self._cfg.fail_open_missing_person_model:
            if not self._warned_missing_person_model:
                logger.warning(
                    "Person detector ONNX missing/unavailable; failing open on full-body gate."
                )
                self._warned_missing_person_model = True
            return None
        return reason

    def _eval_settling(self, image: Image.Image) -> PresenceGateDecision:
        cfg = self._cfg
        reason, center, n_faces = self._det.check_face_gate(image)
        if reason is not None:
            self._reset_settle()
            return PresenceGateDecision(
                allow_frame=False,
                event=self._make_event("waiting_face", str(reason), frame_accepted=False),
            )

        if cfg.mode == "full":
            body_reason = self._resolve_full_body_gate(image, center)
            if body_reason is not None:
                self._reset_settle()
                return PresenceGateDecision(
                    allow_frame=False,
                    event=self._make_event("no_person", str(body_reason), frame_accepted=False),
                )

        if center is not None:
            cx, cy, csz = center
            if n_faces < 2 and abs(cx - 0.5) > cfg.face_center_margin:
                self._reset_settle()
                self._cx, self._cy, self._csz = cx, cy, csz
                return PresenceGateDecision(
                    allow_frame=False,
                    event=self._make_event("waiting_face", "off_center", frame_accepted=False),
                )

            eps = cfg.face_move_eps
            szeps = eps * 0.5
            cap = cfg.face_settle_drift
            still = (
                self._cx is not None
                and self._cy is not None
                and self._csz is not None
                and abs(cx - self._cx) <= eps
                and abs(cy - self._cy) <= eps
                and abs(csz - self._csz) <= szeps
            )
            if (
                still
                and self._settle_ax is not None
                and self._settle_ay is not None
                and self._settle_asz is not None
                and abs(cx - self._settle_ax) <= cap
                and abs(cy - self._settle_ay) <= cap
                and abs(csz - self._settle_asz) <= cap
            ):
                self._stable_count += 1
            else:
                self._stable_count = 1
                self._settle_ax, self._settle_ay, self._settle_asz = cx, cy, csz
            self._cx, self._cy, self._csz = cx, cy, csz
        else:
            # Fail-open face gate (e.g. YuNet model missing) counts directly toward settle
            self._stable_count += 1

        if self._stable_count < max(1, cfg.face_stable_frames):
            return PresenceGateDecision(
                allow_frame=False,
                event=self._make_event("waiting_face", "settling", frame_accepted=False),
            )

        self._phase = "active"
        self._stride_tick = 0
        self._face_last = True
        self._person_last = True
        self._full_body_reason = None
        self._absent_count = 0
        self._present_count = 0
        self._body_miss_count = 0
        return PresenceGateDecision(
            allow_frame=True,
            event=self._make_event("editing", "settled", frame_accepted=True, force_emit=True),
        )

    def _eval_monitoring(self, image: Image.Image) -> PresenceGateDecision:
        cfg = self._cfg
        stride = max(1, cfg.detection_stride)
        fresh = self._phase == "absent_hold" or self._stride_tick == 0
        self._stride_tick = 0 if self._phase == "absent_hold" else (self._stride_tick + 1) % stride

        if fresh:
            faces, fw, fh = self._det.detect_faces(image)
            if faces is None:
                self._face_last = True
            else:
                self._face_last = self._det.face_present(
                    faces,
                    fw,
                    fh,
                    cfg.face_present_min_ratio,
                    cfg.face_present_edge_margin,
                )

            if cfg.mode == "full":
                full_reason: str | None = None
                if self._face_last:
                    center = (
                        self._det.face_center(
                            faces,
                            fw,
                            fh,
                            cfg.face_present_min_ratio,
                            cfg.face_present_edge_margin,
                        )
                        if faces is not None
                        else (0.5, 0.5, 0.25)
                    )
                    if center is None:
                        full_reason = "no_face"
                    else:
                        full_reason = self._resolve_full_body_gate(image, center)
                self._full_body_reason = full_reason
                self._person_last = full_reason is None
            else:
                self._person_last = self._det.person_present(image)

        body_here = self._person_last
        face_here = self._face_last
        present = body_here and face_here

        if body_here:
            self._body_miss_count = 0
        else:
            self._body_miss_count += 1

        if present:
            self._absent_count = 0
            if self._phase == "absent_hold":
                self._present_count += 1
                if self._present_count >= max(1, cfg.return_frames):
                    self._phase = "settling"
                    self._present_count = 0
                    self._reset_settle()
                    return PresenceGateDecision(
                        allow_frame=False,
                        reset_session=True,
                        event=self._make_event(
                            "session_reset",
                            "subject_returned",
                            frame_accepted=False,
                            force_emit=True,
                        ),
                    )
                return PresenceGateDecision(
                    allow_frame=False,
                    event=self._make_event(
                        self._hold_event_type, self._hold_reason, frame_accepted=False
                    ),
                )
            return PresenceGateDecision(allow_frame=True)

        self._present_count = 0
        self._absent_count += 1

        if not body_here:
            if cfg.mode == "full":
                evt_type: Literal["waiting_face", "no_person"] = "no_person"
                reason_now = self._full_body_reason or "full_body_needed"
            elif self._body_miss_count < max(1, cfg.body_flip_frames):
                evt_type = "waiting_face"
                reason_now = "no_face"
            else:
                evt_type = "no_person"
                reason_now = "no_person"
        else:
            evt_type = "waiting_face"
            reason_now = "no_face"

        if self._phase == "active":
            if self._absent_count >= max(1, cfg.absent_frames):
                self._phase = "absent_hold"
                self._hold_reason = reason_now
                self._hold_event_type = evt_type
                self._stride_tick = 0
                return PresenceGateDecision(
                    allow_frame=False,
                    clear_pending=True,
                    event=self._make_event(
                        evt_type, reason_now, frame_accepted=False, force_emit=True
                    ),
                )
            if cfg.mode == "full":
                return PresenceGateDecision(
                    allow_frame=False,
                    event=VideoGateEvent(
                        event_type="dropped",
                        reason="presence_skip",
                        frame_accepted=False,
                        emit=False,
                    ),
                )
            return PresenceGateDecision(allow_frame=True)

        return PresenceGateDecision(
            allow_frame=False,
            event=self._make_event(self._hold_event_type, self._hold_reason, frame_accepted=False),
        )


def build_joyai_detectors(
    serving_mod: Any,
    *,
    face_onnx: str,
    person_onnx: str,
    config: PresenceGateConfig,
) -> PresenceGateDetectors:
    """Bind `PresenceGateDetectors` callables to `serve_joyomni_streaming` functions."""

    def _check_face(image: Image.Image) -> tuple[str | None, FaceCenter | None, int]:
        res = serving_mod._check_face_gate(
            image,
            onnx_path=face_onnx,
            score_thresh=config.face_score_thresh,
            min_below_ratio=config.face_min_below_ratio,
        )
        return res[0], res[1], int(res[2])

    def _check_body(image: Image.Image, center: FaceCenter | None) -> str | None:
        return serving_mod._check_full_body_gate(
            image,
            face_center=center,
            onnx_path=person_onnx,
            conf=config.person_conf,
        )

    detect_faces_fn = getattr(serving_mod, "_detect_gate_faces", None)
    face_present_fn = getattr(serving_mod, "_face_present_from", None)
    face_center_fn = getattr(serving_mod, "_face_center_from", None)
    person_present_fn = getattr(serving_mod, "_person_present", None)

    def _detect_faces(image: Image.Image) -> tuple[list[FaceBox] | None, float, float]:
        if detect_faces_fn is not None:
            return detect_faces_fn(
                image,
                onnx_path=face_onnx,
                score_thresh=config.face_score_thresh,
            )
        reason, _center, _nf = _check_face(image)
        if reason == "no_face":
            return [], float(image.width), float(image.height)
        return None, float(image.width), float(image.height)

    def _face_present(
        faces: list[FaceBox] | None,
        w: float,
        h: float,
        min_ratio: float,
        edge_margin: float,
    ) -> bool:
        if face_present_fn is not None:
            return bool(face_present_fn(faces, w, h, min_ratio=min_ratio, edge_margin=edge_margin))
        return faces is None or len(faces) > 0

    def _face_center(
        faces: list[FaceBox] | None,
        w: float,
        h: float,
        min_ratio: float,
        edge_margin: float,
    ) -> FaceCenter | None:
        if face_center_fn is not None:
            return face_center_fn(faces, w, h, min_ratio=min_ratio, edge_margin=edge_margin)
        if not faces or min(w, h) <= 0:
            return None
        fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        return ((fx + fw / 2.0) / w, (fy + fh / 2.0) / h, min(fw, fh) / min(w, h))

    def _person_present(image: Image.Image) -> bool:
        if person_present_fn is not None:
            return bool(person_present_fn(image, onnx_path=person_onnx, conf=config.person_conf))
        return True

    return PresenceGateDetectors(
        check_face_gate=_check_face,
        check_full_body_gate=_check_body,
        detect_faces=_detect_faces,
        face_present=_face_present,
        face_center=_face_center,
        person_present=_person_present,
    )
