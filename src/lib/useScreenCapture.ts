"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenEvent } from "./types";

const FRAME_INTERVAL_MS = 1600;
const FRAME_WIDTH = 960; // downscaled before sending to the vision model / storing as thumbnail
const THUMB_WIDTH = 320; // smaller copy kept on the event itself

export interface UseScreenCaptureOptions {
  pauseMs?: number; // how long with no visual change counts as "a natural pause"
  muted?: boolean; // when true, frames are still sampled (for UI) but not sent to the vision model
  onEvent?: (event: ScreenEvent) => void;
  onPause?: () => void;
}

export function useScreenCapture(opts: UseScreenCaptureOptions = {}) {
  const { pauseMs = 3000, onEvent, onPause, muted } = opts;

  const [isSharing, setIsSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const previousFrameRef = useRef<string | null>(null);
  const lastEventSummaryRef = useRef<string | null>(null);
  const lastChangeAtRef = useRef<number>(0);
  const pauseFiredRef = useRef(false);
  const startedAtRef = useRef<number>(0);
  const mutedRef = useRef(!!muted);
  useEffect(() => {
    mutedRef.current = !!muted;
  }, [muted]);

  const captureFrame = useCallback((width: number): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const canvas = canvasRef.current || document.createElement("canvas");
    canvasRef.current = canvas;
    const scale = width / video.videoWidth;
    canvas.width = width;
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6).split(",")[1] || null;
  }, []);

  const tick = useCallback(async () => {
    const current = captureFrame(FRAME_WIDTH);
    if (!current) return;
    setFrameCount((c) => c + 1);

    if (!mutedRef.current) {
      try {
        const res = await fetch("/api/vision/frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentFrame: current,
            previousFrame: previousFrameRef.current,
            lastEventSummary: lastEventSummaryRef.current,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            changed: boolean;
            summary: string;
            field: string | null;
            from: string | null;
            to: string | null;
          };
          if (data.changed && data.summary) {
            lastChangeAtRef.current = Date.now();
            pauseFiredRef.current = false;
            lastEventSummaryRef.current = data.summary;

            const thumb = captureFrame(THUMB_WIDTH) || undefined;
            const event: ScreenEvent = {
              id: crypto.randomUUID(),
              t: Date.now() - startedAtRef.current,
              summary: data.summary,
              field: data.field || undefined,
              from: data.from || undefined,
              to: data.to || undefined,
              frameThumbnail: thumb,
            };
            onEvent?.(event);
          }
        }
      } catch {
        // transient network error sampling a frame — skip this tick
      }
    }

    previousFrameRef.current = current;

    if (!pauseFiredRef.current && Date.now() - lastChangeAtRef.current >= pauseMs) {
      pauseFiredRef.current = true;
      onPause?.();
    }
  }, [captureFrame, onEvent, onPause, pauseMs]);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsSharing(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      startedAtRef.current = Date.now();
      lastChangeAtRef.current = Date.now();
      previousFrameRef.current = null;
      lastEventSummaryRef.current = null;
      pauseFiredRef.current = false;

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        stop();
      });

      setIsSharing(true);
      intervalRef.current = setInterval(tick, FRAME_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start screen share");
    }
  }, [tick, stop]);

  useEffect(() => stop, [stop]);

  return {
    videoRef,
    isSharing,
    error,
    frameCount,
    start,
    stop,
    startedAtRef,
  };
}
