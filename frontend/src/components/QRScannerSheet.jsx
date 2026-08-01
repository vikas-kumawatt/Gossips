import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImageUp, Loader2 } from "lucide-react";
import jsQR from "jsqr";
import ResponsiveSheet from "./ui/responsive-sheet";
import { parseProfileUrl } from "../lib/profileLink";

/**
 * Scan a Gossips profile QR with the camera.
 *
 * Two decoders: the browser's own BarcodeDetector where it exists (hardware
 * accelerated, no frame copying), and jsQR over canvas frames everywhere else —
 * Safari and Firefox have no BarcodeDetector, which is most iPhones.
 *
 * A scanned code is untrusted text, so nothing is navigated to directly. It goes
 * through `parseProfileUrl`, which only yields a username for a profile URL on
 * this origin; anything else is reported as "not a profile code" and scanning
 * continues. Without that, a printed QR could bounce people to any site it liked.
 */

// Frequent enough to feel instant, far enough apart that jsQR isn't decoding
// every frame on a phone.
const DECODE_INTERVAL_MS = 200;

const cameraErrorMessage = (error) => {
  switch (error?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera access was blocked. Allow it for this site in your browser settings, then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
    case "TrackStartError":
      return "Your camera is being used by another app. Close it and try again.";
    case "OverconstrainedError":
      return "This device's camera can't be used for scanning.";
    case "SecurityError":
      return "Scanning needs a secure (https) connection.";
    default:
      return "Couldn't start the camera.";
  }
};

const QRScannerSheet = ({ onFound, onClose }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const frameRef = useRef(null);
  const detectorRef = useRef(null);
  const lastDecodeRef = useRef(0);
  // Set the moment a code is accepted, so the loop can't fire onFound twice
  // while the sheet animates away.
  const doneRef = useRef(false);

  const [status, setStatus] = useState("starting"); // starting | scanning | error
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");

  const stopCamera = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    // Releasing every track is what actually turns the camera light off.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const handleDecoded = useCallback(
    (text) => {
      const username = parseProfileUrl(text);
      if (!username) {
        setHint("That code isn't a Gossips profile.");
        return false;
      }
      doneRef.current = true;
      stopCamera();
      onFound(username);
      return true;
    },
    [onFound, stopCamera]
  );

  /** One pass over the current frame with whichever decoder is available. */
  const scanFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return;

    if (detectorRef.current) {
      const codes = await detectorRef.current.detect(video).catch(() => []);
      for (const code of codes) {
        if (code.rawValue && handleDecoded(code.rawValue)) return;
      }
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    // attemptBoth: our own codes are light-on-dark, which is inverted as far as
    // the spec is concerned.
    const result = jsQR(frame.data, frame.width, frame.height, {
      inversionAttempts: "attemptBoth",
    });
    if (result?.data) handleDecoded(result.data);
  }, [handleDecoded]);

  const loop = useCallback(
    (timestamp) => {
      if (doneRef.current) return;
      frameRef.current = requestAnimationFrame(loop);
      if (timestamp - lastDecodeRef.current < DECODE_INTERVAL_MS) return;
      lastDecodeRef.current = timestamp;
      scanFrame();
    },
    [scanFrame]
  );

  const startCamera = useCallback(async () => {
    if (doneRef.current) return;
    setStatus("starting");
    setError("");

    // getUserMedia doesn't exist at all over plain http, so say why rather than
    // throwing an opaque error.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError("Scanning needs a secure (https) connection.");
      return;
    }

    try {
      // The rear camera on a phone; desktops just get their only one.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      // The sheet may have closed while the permission prompt was up.
      if (doneRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        // Safari rejects play() if the element isn't ready; it retries on the
        // next loop pass anyway, so a failure here isn't fatal.
        await video.play().catch(() => {});
      }

      if (!detectorRef.current && "BarcodeDetector" in window) {
        try {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats.includes("qr_code")) {
            detectorRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
          }
        } catch {
          // Fall through to jsQR.
        }
      }

      setStatus("scanning");
      lastDecodeRef.current = 0;
      frameRef.current = requestAnimationFrame(loop);
    } catch (cameraError) {
      setStatus("error");
      setError(cameraErrorMessage(cameraError));
    }
  }, [loop]);

  useEffect(() => {
    startCamera();
    return () => {
      doneRef.current = true;
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  /*
   * Hand the camera back when the tab goes away instead of holding it open in
   * the background, and pick it up again on return.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (doneRef.current) return;
      if (document.visibilityState === "hidden") {
        stopCamera();
      } else if (!streamRef.current) {
        startCamera();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [startCamera, stopCamera]);

  /** Decode a saved screenshot — the way out when the camera is unavailable. */
  const scanImageFile = async (file) => {
    if (!file) return;
    setHint("");
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(frame.data, frame.width, frame.height, {
        inversionAttempts: "attemptBoth",
      });
      if (!result?.data || !handleDecoded(result.data)) {
        setHint("No Gossips profile code found in that image.");
      }
    } catch {
      setHint("Couldn't read that image.");
    }
  };

  return (
    <ResponsiveSheet title="Scan QR code" onClose={onClose}>
      <div className="px-4 pb-5 pt-4">
        <div className="relative mx-auto aspect-square w-full max-w-[320px] overflow-hidden rounded-2xl border border-neutral-800 bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="h-full w-full object-cover"
          />
          <canvas ref={canvasRef} className="hidden" />

          {status === "scanning" && (
            // Framing guides. Purely visual — decoding uses the whole frame, so
            // a code slightly outside the box still reads.
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-3/5 w-3/5">
                {[
                  "left-0 top-0 border-l-2 border-t-2 rounded-tl-lg",
                  "right-0 top-0 border-r-2 border-t-2 rounded-tr-lg",
                  "left-0 bottom-0 border-b-2 border-l-2 rounded-bl-lg",
                  "right-0 bottom-0 border-b-2 border-r-2 rounded-br-lg",
                ].map((position) => (
                  <span
                    key={position}
                    className={`absolute h-7 w-7 border-white/80 ${position}`}
                  />
                ))}
              </div>
            </div>
          )}

          {status === "starting" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950/80">
              <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
              <p className="text-[13px] text-neutral-400">Starting the camera…</p>
            </div>
          )}

          {status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950/90 px-5 text-center">
              <Camera className="h-6 w-6 text-neutral-500" />
              <p className="text-[13px] leading-relaxed text-neutral-300">{error}</p>
              <button
                type="button"
                onClick={startCamera}
                className="rounded-xl border border-neutral-700 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-800 cursor-pointer"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-[13px] text-neutral-500">
          {hint || "Point the camera at a Gossips profile QR code."}
        </p>

        <label className="mt-4 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-neutral-800 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-900">
          <ImageUp className="h-4 w-4" />
          Scan from an image
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset so picking the same file twice still fires a change.
              event.target.value = "";
              scanImageFile(file);
            }}
          />
        </label>
      </div>
    </ResponsiveSheet>
  );
};

export default QRScannerSheet;
