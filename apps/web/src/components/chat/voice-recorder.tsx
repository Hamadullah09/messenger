'use client';

import { VOICE_NOTE_MAX_MS, type AudioDetails } from '@storeline/shared';
import {
  ChevronLeft,
  ChevronUp,
  Lock,
  Mic,
  Pause,
  Play,
  SendHorizontal,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui';

const MIN_MS = 800;
const TAP_MS = 300;
/** Slide this far left to cancel, or this far up to lock (pixels). */
const CANCEL_DX = 120;
const LOCK_DY = 70;
const BARS = 40;

/** Formats the browser supports, best first; the declared upload type drops the codec. */
const FORMATS = [
  { recorder: 'audio/webm;codecs=opus', upload: 'audio/webm', ext: 'weba' },
  { recorder: 'audio/ogg;codecs=opus', upload: 'audio/ogg', ext: 'ogg' },
  { recorder: 'audio/mp4', upload: 'audio/mp4', ext: 'm4a' },
] as const;

function pickFormat() {
  if (typeof MediaRecorder === 'undefined') return null;
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.recorder)) ?? null;
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Shrinks loudness samples to `count` bars on a 0–31 scale. */
function toBars(samples: number[], count: number): number[] {
  if (samples.length === 0) return [];
  const peak = Math.max(0.02, ...samples);
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * samples.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / count));
    const slice = samples.slice(from, to);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    return Math.min(31, Math.round((avg / peak) * 31));
  });
}

const finePointer = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;

type State = 'idle' | 'holding' | 'locked' | 'paused';

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  samples: number[];
  format: (typeof FORMATS)[number];
  audio: AudioContext;
  timer: number;
  cancel: boolean;
  /** Time recorded before the current stretch (pauses do not count). */
  before: number;
  /** When the current stretch started (null while paused). */
  since: number | null;
  durationMs: number;
}

/**
 * WhatsApp voice notes. Phones: hold the mic to record and let go to send; slide left to cancel,
 * slide up to lock. Computers: click the mic to record. Locked: pause, listen back, delete or
 * send. The mic button stays the same element throughout, so the finger never "loses" it.
 */
export function VoiceRecorder({
  onSend,
  onActiveChange,
}: {
  onSend: (file: File, details: AudioDetails) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [state, setState] = useState<State>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState<number[]>([]);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewAt, setPreviewAt] = useState(0);
  const rec = useRef<Recording | null>(null);
  const press = useRef<{ at: number; x: number; y: number; started: boolean } | null>(null);
  const previewRef = useRef<HTMLAudioElement>(null);
  const stateRef = useRef<State>('idle');
  /** The finger that just slid up to lock is still down: its release must not send. */
  const ignoreUp = useRef(false);
  stateRef.current = state;

  useEffect(() => onActiveChange(state !== 'idle'), [state, onActiveChange]);
  useEffect(() => () => stop(true), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 3500);
    return () => window.clearTimeout(t);
  }, [message]);

  const recorded = (r: Recording) => r.before + (r.since ? Date.now() - r.since : 0);

  async function start(): Promise<boolean> {
    setMessage(null);
    const format = pickFormat();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !format) {
      setMessage('Voice messages need a secure (https) address and a recent browser.');
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setMessage('Allow the microphone to record voice messages.');
      return false;
    }
    const recorder = new MediaRecorder(stream, {
      mimeType: format.recorder,
      audioBitsPerSecond: 32_000,
    });
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);
    const current: Recording = {
      recorder,
      stream,
      chunks: [],
      samples: [],
      format,
      audio,
      timer: 0,
      cancel: false,
      before: 0,
      since: Date.now(),
      durationMs: 0,
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) current.chunks.push(e.data);
      // Paused: what is recorded so far can be listened to.
      if (stateRef.current === 'paused' && rec.current === current)
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(new Blob(current.chunks, { type: current.format.upload }));
        });
    };
    recorder.onstop = () => finish(current);
    current.timer = window.setInterval(() => {
      if (!current.since) return;
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buffer.length);
      current.samples.push(rms);
      const ms = recorded(current);
      setElapsed(ms);
      setLevel((l) => [...l.slice(-39), rms]);
      if (ms >= VOICE_NOTE_MAX_MS) stop(false);
    }, 100);
    recorder.start(250);
    rec.current = current;
    navigator.vibrate?.(20);
    return true;
  }

  function finish(current: Recording) {
    window.clearInterval(current.timer);
    current.stream.getTracks().forEach((t) => t.stop());
    void current.audio.close();
    if (current.cancel || current.durationMs < MIN_MS) return;
    const blob = new Blob(current.chunks, { type: current.format.upload });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = new File([blob], `voice-${stamp}.${current.format.ext}`, {
      type: current.format.upload,
    });
    onSend(file, {
      voice: true,
      durationMs: current.durationMs,
      waveform: toBars(current.samples, BARS),
    });
  }

  function clearPreview() {
    previewRef.current?.pause();
    setPreviewPlaying(false);
    setPreviewAt(0);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  }

  /** Ends the recording: sent (cancel false) or thrown away. */
  function stop(cancel: boolean) {
    const current = rec.current;
    rec.current = null;
    press.current = null;
    setState('idle');
    setElapsed(0);
    setLevel([]);
    setDrag({ dx: 0, dy: 0 });
    clearPreview();
    if (!current) return;
    current.cancel = cancel;
    current.durationMs = recorded(current);
    current.since = null;
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    else finish(current);
  }

  function pause() {
    const current = rec.current;
    if (!current || !current.since || current.recorder.state !== 'recording') return;
    current.before = recorded(current);
    current.since = null;
    current.recorder.pause();
    setState('paused');
    stateRef.current = 'paused';
    current.recorder.requestData();
  }

  function resume() {
    const current = rec.current;
    if (!current || current.recorder.state !== 'paused') return;
    clearPreview();
    current.since = Date.now();
    current.recorder.resume();
    setState('locked');
  }

  const holding = state === 'holding';
  const cancelling = holding && drag.dx < -CANCEL_DX * 0.75;

  // One stable element for the mic / send button (pointer capture must survive re-renders).
  const mainButton = (
    <button
      type="button"
      aria-label={
        state === 'idle'
          ? 'Record a voice message'
          : state === 'holding'
            ? 'Recording: let go to send'
            : 'Send voice message'
      }
      title={
        state === 'idle' ? (finePointer() ? 'Record a voice message' : 'Hold to record') : undefined
      }
      className={cx(
        'relative z-10 inline-flex size-10 shrink-0 touch-none items-center justify-center rounded-full transition-transform select-none',
        state === 'idle' ? 'text-wa-icon hover:bg-wa-hover' : 'bg-brand text-brand-contrast',
        holding && 'scale-150 shadow-lg',
      )}
      onPointerDown={(e) => {
        if (state !== 'idle') return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = { at: Date.now(), x: e.clientX, y: e.clientY, started: false };
        press.current = p;
        void start().then((ok) => {
          if (!ok) {
            press.current = null;
            return;
          }
          p.started = true;
          // Computers: a click records hands-free.
          if (finePointer()) setState('locked');
          // Phones: still holding → hold mode; already let go → it was only a tap.
          else if (press.current === p) setState('holding');
          else {
            stop(true);
            setMessage('Hold to record, let go to send');
          }
        });
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p || stateRef.current !== 'holding') return;
        const dx = Math.min(0, e.clientX - p.x);
        const dy = Math.min(0, e.clientY - p.y);
        if (dy < -LOCK_DY) {
          press.current = null;
          ignoreUp.current = true;
          setDrag({ dx: 0, dy: 0 });
          setState('locked');
          navigator.vibrate?.(15);
          return;
        }
        if (dx < -CANCEL_DX) {
          navigator.vibrate?.([10, 40, 10]);
          stop(true);
          return;
        }
        setDrag({ dx, dy });
      }}
      onPointerUp={() => {
        const p = press.current;
        press.current = null;
        if (ignoreUp.current) {
          ignoreUp.current = false;
          return;
        }
        // The microphone is not ready yet: start() decides once it is.
        if (p && !p.started) return;
        if (stateRef.current === 'locked' || stateRef.current === 'paused') {
          if (!p) stop(false); // a tap on the send button
          return;
        }
        if (!p) return;
        if (Date.now() - p.at < TAP_MS && !finePointer()) {
          // Phones: a quick tap is not a recording (WhatsApp shows the same hint).
          stop(true);
          setMessage('Hold to record, let go to send');
          return;
        }
        if (stateRef.current === 'holding') stop(false);
      }}
      onPointerCancel={() => {
        if (stateRef.current === 'holding') stop(true);
        press.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (state === 'idle') void start().then((ok) => ok && setState('locked'));
        else if (state !== 'holding') stop(false);
      }}
    >
      {state === 'idle' || holding ? (
        <Mic className="size-6" aria-hidden />
      ) : (
        <SendHorizontal className="size-5" aria-hidden />
      )}
    </button>
  );

  return (
    <div className={cx('relative flex items-end gap-1', state !== 'idle' && 'min-w-0 flex-1')}>
      {message && (
        <p
          role="status"
          className="absolute right-0 bottom-full z-20 mb-2 w-max max-w-64 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-white shadow-pop"
        >
          {message}
        </p>
      )}
      {holding && (
        <span
          className="absolute right-0 bottom-full z-20 mb-6 flex w-10 flex-col items-center gap-1 rounded-full bg-surface py-3 text-wa-icon shadow-pop"
          style={{ transform: `translateY(${Math.max(-40, drag.dy / 2)}px)` }}
          aria-hidden
        >
          <Lock className="size-4" />
          <ChevronUp className="size-4 animate-bounce" />
        </span>
      )}
      {state !== 'idle' && (
        <div
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg bg-wa-input px-3"
          role="group"
          aria-label="Recording a voice message"
        >
          {state === 'paused' && preview ? (
            <>
              <button
                type="button"
                aria-label={previewPlaying ? 'Pause' : 'Listen to the recording'}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
                onClick={() => {
                  const el = previewRef.current;
                  if (!el) return;
                  if (el.paused) void el.play().then(() => setPreviewPlaying(true));
                  else {
                    el.pause();
                    setPreviewPlaying(false);
                  }
                }}
              >
                {previewPlaying ? (
                  <Pause className="size-5 fill-current" aria-hidden />
                ) : (
                  <Play className="size-5 fill-current" aria-hidden />
                )}
              </button>
              <audio
                ref={previewRef}
                src={preview}
                onTimeUpdate={(e) => setPreviewAt(e.currentTarget.currentTime * 1000)}
                onEnded={() => {
                  setPreviewPlaying(false);
                  setPreviewAt(0);
                }}
                className="hidden"
              />
              <Waveform
                bars={toBars(rec.current?.samples ?? [], BARS)}
                progress={elapsed > 0 ? previewAt / elapsed : 0}
              />
              <span className="w-10 shrink-0 text-right text-sm tabular-nums text-wa-meta-in">
                {mmss(previewPlaying || previewAt > 0 ? previewAt : elapsed)}
              </span>
            </>
          ) : (
            <>
              <Mic
                className={cx(
                  'size-5 shrink-0 text-red-600',
                  state !== 'paused' && 'animate-pulse',
                )}
                aria-hidden
              />
              <span className="w-11 shrink-0 font-semibold tabular-nums" aria-live="off">
                {mmss(elapsed)}
              </span>
              {holding ? (
                <span
                  className={cx(
                    'flex min-w-0 flex-1 items-center justify-center gap-1 truncate text-sm',
                    cancelling ? 'text-danger' : 'text-wa-meta-in',
                  )}
                  style={{ transform: `translateX(${drag.dx / 2}px)` }}
                >
                  <ChevronLeft className="size-4 shrink-0" aria-hidden />
                  {cancelling ? 'Let go to cancel' : 'Slide to cancel'}
                </span>
              ) : (
                <span
                  className="flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden"
                  aria-hidden
                >
                  {level.map((v, i) => (
                    <span
                      key={i}
                      className="w-[3px] shrink-0 rounded-full bg-wa-icon"
                      style={{ height: `${Math.max(12, Math.min(100, v * 400))}%` }}
                    />
                  ))}
                </span>
              )}
            </>
          )}
          {!holding && (
            <>
              <button
                type="button"
                aria-label="Delete recording"
                onClick={() => stop(true)}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-danger hover:bg-wa-hover"
              >
                <Trash2 className="size-5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={state === 'paused' ? 'Continue recording' : 'Pause recording'}
                onClick={() => (state === 'paused' ? resume() : pause())}
                className={cx(
                  'inline-flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-wa-hover',
                  state === 'paused' ? 'text-red-600' : 'text-wa-icon',
                )}
              >
                {state === 'paused' ? (
                  <Mic className="size-5" aria-hidden />
                ) : (
                  <Pause className="size-5 fill-current" aria-hidden />
                )}
              </button>
            </>
          )}
        </div>
      )}
      {mainButton}
    </div>
  );
}

function Waveform({ bars, progress }: { bars: number[]; progress: number }) {
  return (
    <span className="flex h-6 min-w-0 flex-1 items-center gap-[2px]" aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className={cx(
            'w-[3px] flex-1 rounded-full',
            i / bars.length < progress ? 'bg-brand' : 'bg-wa-icon/45',
          )}
          style={{ height: `${Math.max(14, (b / 31) * 100)}%` }}
        />
      ))}
    </span>
  );
}
