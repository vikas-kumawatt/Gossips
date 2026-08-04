import { useCallback, useEffect, useRef, useState } from "react";
import { downsampleWaveform } from "../lib/chatMessage";

/**
 * Record a voice note, and play it back before sending.
 *
 * Lifted out of UserConversationPage, where it was ~200 lines of MediaRecorder,
 * AnalyserNode and playback state tangled into a 4,000-line page. That is why the
 * group composer had a microphone button that recorded nothing: none of this existed
 * there, and copying it was never going to happen.
 *
 * Owns the hardware and nothing else — it hands back a `preview` object and takes no
 * view on how a clip is sent, because the two threads send differently (a DM applies a
 * disappearing-message TTL, a group doesn't).
 *
 * @param {object}   options
 * @param {number}   options.maxMs     Hard stop, so a forgotten thumb can't record forever.
 * @param {function} options.onError   Called with a human-readable string.
 */
export const useVoiceRecorder = ({ maxMs = 120_000, onError } = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  /** The trailing window the live bar strip scrolls through. */
  const [liveWaveform, setLiveWaveform] = useState([]);
  /** `{file, url, duration, waveformSnapshot}` once a clip exists. */
  const [preview, setPreview] = useState(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const maxRecordingTimerRef = useRef(null);
  const recordingCancelledRef = useRef(false);
  const isStartingRecordingRef = useRef(false);
  const recordingTimeRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const lastWaveformPaintRef = useRef(0);
  const waveformHistoryRef = useRef([]);
  /** Every sample of the current recording, for the envelope that gets sent. */
  const fullWaveformRef = useRef([]);
  const previewAudioRef = useRef(null);
  /** Object URLs this hook created, so unmount can release them. */
  const objectUrlsRef = useRef(new Set());

  const trackUrl = useCallback((url) => {
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  const releaseUrl = useCallback((url) => {
    if (!url) return;
    objectUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const stopWaveformAnalysis = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      analyserRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    stopWaveformAnalysis();
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (maxRecordingTimerRef.current) {
      clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    } else if (streamRef.current) {
      // The recorder's onstop releases the tracks, but it only fires if the
      // recorder was actually running. Otherwise the mic stays open and the
      // browser keeps showing the recording indicator.
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
    setIsRecording(false);
  }, [stopWaveformAnalysis]);

  const startRecording = useCallback(async () => {
    /*
     * Guarded synchronously, before the await.
     *
     * The button had onMouseDown *and* onTouchStart, and a touch produces both:
     * touchstart, then a synthetic mousedown. Since setIsRecording only happens
     * after getUserMedia resolves, both calls got past a state check — two mic
     * streams, two AudioContexts, two MediaRecorders and two intervals, with
     * the first of each leaked and ticking forever.
     */
    if (isStartingRecordingRef.current) return;
    if (mediaRecorderRef.current?.state === "recording") return;
    isStartingRecordingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // ── Real-time waveform via Web Audio API ──
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      analyserRef.current.smoothingTimeConstant = 0.5;
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      const freqData = new Uint8Array(analyserRef.current.frequencyBinCount);
      waveformHistoryRef.current = [];
      fullWaveformRef.current = [];

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(freqData);
        // RMS energy across voice-range frequency bins (roughly 0–3 kHz)
        const voiceBins = Math.min(freqData.length, 48);
        let sum = 0;
        for (let i = 0; i < voiceBins; i++) sum += freqData[i] * freqData[i];
        const rms = Math.sqrt(sum / voiceBins) / 255; // 0..1
        // Amplify quiet signals; add small idle jitter so bars breathe in silence
        const amp = rms < 0.02 ? 0.02 + Math.random() * 0.04 : Math.min(1, rms * 4);
        waveformHistoryRef.current = [...waveformHistoryRef.current, amp].slice(-52);
        /*
         * The whole recording, kept separately from the scrolling display window.
         *
         * `waveformHistoryRef` is `.slice(-52)` because the live bar strip is meant to
         * scroll — but that is also what was being sent as the "recorded waveform",
         * so a 30-second note shipped its final 0.9 seconds stretched across the
         * bubble. This one never drops a sample; it is averaged down to a fixed number
         * of buckets at stop, so the bubble draws the envelope of the whole clip.
         */
        fullWaveformRef.current.push(amp);

        /*
         * Throttled to ~15fps.
         *
         * This used to setState on every animation frame — sixty re-renders a
         * second of the whole page component. Combined with the message list
         * being rebuilt on each one, recording a voice note was the single most
         * expensive thing the app did. The history ref keeps every sample; only
         * the render is throttled.
         */
        const now = performance.now();
        if (now - lastWaveformPaintRef.current > 66) {
          lastWaveformPaintRef.current = now;
          setLiveWaveform([...waveformHistoryRef.current]);
        }

        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);

      // ── MediaRecorder ──
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recordingCancelledRef.current = false;

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingCancelledRef.current) {
          recordingCancelledRef.current = false;
          return;
        }
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const audioUrl = trackUrl(URL.createObjectURL(audioBlob));
        const ext = mimeType === "audio/webm" ? "webm" : "mp4";
        /*
         * Wall-clock elapsed, not the whole seconds the display counter ticked.
         *
         * The counter is a `setInterval(…, 1000)` that starts at 0, so it reads 0 for
         * anything under a second and truncates everything else — a 4.9s note was
         * recorded as "4". The clip's real length is the only number that can line the
         * playback progress up with the bar strip, so it is measured properly here and
         * the counter stays what it is: a display.
         */
        const elapsed = recordingStartedAtRef.current
          ? Math.max(0.1, (Date.now() - recordingStartedAtRef.current) / 1000)
          : recordingTimeRef.current;

        setPreview({
          file: new File([audioBlob], `voice-message.${ext}`, { type: mimeType }),
          url: audioUrl,
          duration: elapsed,
          // The whole envelope, averaged into fixed buckets — not the trailing
          // window the live strip scrolls through.
          waveformSnapshot: downsampleWaveform(fullWaveformRef.current),
        });
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimeRef.current = 0;
      recordingStartedAtRef.current = Date.now();

      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => {
          recordingTimeRef.current = prev + 1;
          return prev + 1;
        });
      }, 1000);

      // Held in a ref so stopRecording can clear it. Left dangling, a timer
      // from an earlier recording would fire mid-way through a later one and
      // cut it short.
      maxRecordingTimerRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") stopRecording();
      }, maxMs);
    } catch (error) {
      console.error("Error starting recording:", error);
      // The stream and the waveform loop both start before MediaRecorder is
      // constructed, and constructing it can throw — an unsupported mimeType on
      // Safari, for one. Without this the microphone stays open with the
      // browser indicator lit and the rAF loop keeps painting forever.
      stopWaveformAnalysis();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      onError?.("Microphone access is required for voice messages");
    } finally {
      isStartingRecordingRef.current = false;
    }
  }, [maxMs, onError, stopRecording, stopWaveformAnalysis, trackUrl]);

  const cancelRecording = useCallback(() => {
    recordingCancelledRef.current = true;
    stopWaveformAnalysis();
    stopRecording();
    setLiveWaveform([]);
    setRecordingTime(0);
  }, [stopRecording, stopWaveformAnalysis]);

  /** Stop playback and detach the element, without touching the clip itself. */
  const stopPreviewPlayback = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = "";
      previewAudioRef.current = null;
    }
    setIsPreviewPlaying(false);
  }, []);

  /** Throw the clip away. */
  const discardPreview = useCallback(() => {
    stopPreviewPlayback();
    setPreview((current) => {
      if (current?.url) releaseUrl(current.url);
      return null;
    });
    setPreviewTime(0);
    setRecordingTime(0);
  }, [releaseUrl, stopPreviewPlayback]);

  /**
   * Hand the clip to the caller and clear the composer.
   *
   * The URL is deliberately *not* revoked: the caller uses it as the optimistic
   * bubble's source while the upload is in flight, so it has to outlive this call.
   * Revoking is the caller's job once the real message arrives.
   */
  const takePreview = useCallback(() => {
    stopPreviewPlayback();
    const clip = preview;
    setPreview(null);
    setPreviewTime(0);
    setRecordingTime(0);
    if (clip?.url) objectUrlsRef.current.delete(clip.url);
    return clip;
  }, [preview, stopPreviewPlayback]);

  /*
   * Playing the preview drives the bars and the clock.
   *
   * `ontimeupdate` is the same mechanism the sent bubble uses (VoiceNoteBubble), so
   * the preview and the bubble behave identically — which is the point of a preview.
   */
  const togglePreviewPlay = useCallback(() => {
    if (!preview) return;
    if (!previewAudioRef.current) {
      const audio = new Audio(preview.url);
      audio.ontimeupdate = () => setPreviewTime(audio.currentTime || 0);
      audio.onended = () => {
        setIsPreviewPlaying(false);
        // Back to the start, so the bars reset and a second press replays rather
        // than sitting at the end doing nothing.
        setPreviewTime(0);
        audio.currentTime = 0;
      };
      previewAudioRef.current = audio;
    }
    if (isPreviewPlaying) {
      previewAudioRef.current.pause();
      setIsPreviewPlaying(false);
    } else {
      previewAudioRef.current.play().catch(console.error);
      setIsPreviewPlaying(true);
    }
  }, [preview, isPreviewPlaying]);

  /*
   * 0..1 through the preview clip.
   *
   * Divided by the recorder's own measured duration rather than the audio element's:
   * `HTMLAudioElement.duration` is `Infinity` for MediaRecorder webm until the whole
   * blob has been walked, which would make the progress zero for the entire clip.
   */
  const previewProgress =
    preview?.duration > 0 ? Math.min(1, previewTime / preview.duration) : 0;

  /*
   * Unmount releases the hardware and the URLs.
   *
   * Navigating away mid-recording used to leave the microphone open with the browser
   * indicator lit, because the teardown lived in the page's own unmount effect and
   * only covered some of these.
   */
  useEffect(
    () => () => {
      recordingCancelledRef.current = true;
      stopWaveformAnalysis();
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (maxRecordingTimerRef.current) clearTimeout(maxRecordingTimerRef.current);
      if (mediaRecorderRef.current?.state === "recording") {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Already stopped.
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current.src = "";
        previewAudioRef.current = null;
      }
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
    },
    [stopWaveformAnalysis]
  );

  return {
    isRecording,
    recordingTime,
    liveWaveform,
    preview,
    previewTime,
    previewProgress,
    isPreviewPlaying,
    startRecording,
    stopRecording,
    cancelRecording,
    togglePreviewPlay,
    discardPreview,
    takePreview,
  };
};

export default useVoiceRecorder;
