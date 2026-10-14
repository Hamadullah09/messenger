'use client';

import { VOICE_NOTE_MAX_MS, type AudioDetails } from '@storeline/shared';
import { ChevronLeft, Lock, Mic, SendHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui';

const MIN_MS = 800;
const TAP_MS = 350;
const CANCEL_DX = 110;
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

/**
 * WhatsApp voice notes: hold the mic to record and release to send, slide left to cancel;
 * a quick tap locks recording on (then Send or Delete). Needs a secure (https) page.
 */
export function VoiceRecorder({
  onSend,
  onActiveChange,
}: {
  onSend: (file: File, details: AudioDetails) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [state, setState] = useState<'idle' | 'holding' | 'locked'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState<number[]>([]);
  const [dx, setDx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    samples: number[];
    startedAt: number;
    format: (typeof FORMATS)[number];
    audio: AudioContext;
    timer: number;
    cancel: boolean;
  } | null>(null);
  const press = useRef<{ at: number; x: number } | null>(null);

  useEffect(() => onActiveChange(state !== 'idle'), [state, onActiveChange]);
  useEffect(() => () => stop(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(): Promise<boolean> {
    setError(null);
    const format = pickFormat();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !format) {
      setError('Voice messages need a secure (https) address and a recent browser.');
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setError('Allow the microphone to record voice messages.');
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
    const current = {
      recorder,
      stream,
      chunks: [] as Blob[],
      samples: [] as number[],
      startedAt: Date.now(),
      format,
      audio,
      timer: 0,
      cancel: false,
    };
    recorder.ondataavailable = (e) => e.data.size > 0 && current.chunks.push(e.data);
    recorder.onstop = () => finish(current);
    current.timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buffer.length);
      current.samples.push(rms);
      const ms = Date.now() - current.startedAt;
      setElapsed(ms);
      setLevel((l) => [...l.slice(-29), rms]);
      if (ms >= VOICE_NOTE_MAX_MS) stop(false);
    }, 100);
    recorder.start(250);
    rec.current = current;
    navigator.vibrate?.(15);
    return true;
  }

  function finish(current: NonNullable<typeof rec.current>) {
    window.clearInterval(current.timer);
    current.stream.getTracks().forEach((t) => t.stop());
    void current.audio.close();
    const durationMs = Date.now() - current.startedAt;
    if (current.cancel || durationMs < MIN_MS) return;
    const blob = new Blob(current.chunks, { type: current.format.upload });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = new File([blob], `voice-${stamp}.${current.format.ext}`, {
      type: current.format.upload,
    });
    onSend(file, { voice: true, durationMs, waveform: toBars(current.samples, BARS) });
  }

  function stop(cancel: boolean) {
    const current = rec.current;
    rec.current = null;
    setState('idle');
    setElapsed(0);
    setLevel([]);
    setDx(0);
    if (!current) return;
    current.cancel = cancel;
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    else finish(current);
  }

  if (state === 'idle') {
    return (
      <div className="relative">
        {error && (
          <p
            role="alert"
            className="absolute right-0 bottom-full mb-2 w-64 rounded-lg bg-surface p-2 text-sm text-danger shadow-pop"
          >
            {error}
          </p>
        )}
        <button
          type="button"
          aria-label="Record a voice message (hold, or tap to lock)"
          title="Hold to record · tap to lock"
          className="inline-flex size-10 shrink-0 touch-none items-center justify-center rounded-full text-wa-icon hover:bg-wa-hover"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            press.current = { at: Date.now(), x: e.clientX };
            void start().then((ok) => {
              if (!ok) press.current = null;
              else if (press.current) setState('holding');
              else setState('locked');
            });
          }}
          onPointerMove={(e) => {
            if (!press.current) return;
            setDx(Math.min(0, e.clientX - press.current.x));
          }}
          onPointerUp={(e) => {
            const p = press.current;
            press.current = null;
            if (!p) return;
            const held = Date.now() - p.at;
            if (held < TAP_MS) {
              setState('locked');
              setDx(0);
            } else stop(e.clientX - p.x < -CANCEL_DX);
          }}
          onPointerCancel={() => {
            press.current = null;
            stop(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void start().then((ok) => ok && setState('locked'));
            }
          }}
        >
          <Mic className="size-6" aria-hidden />
        </button>
      </div>
    );
  }

  const cancelling = dx < -CANCEL_DX;
  return (
    <div
      className="flex min-h-10 flex-1 items-center gap-3 rounded-lg bg-wa-input px-3"
      role="group"
      aria-label="Recording a voice message"
    >
      <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-red-600" aria-hidden />
      <span className="w-12 shrink-0 font-semibold tabular-nums" aria-live="off">
        {mmss(elapsed)}
      </span>
      {state === 'holding' ? (
        <span
          className={cx(
            'flex flex-1 items-center gap-1 text-sm',
            cancelling ? 'text-danger' : 'text-wa-meta-in',
          )}
          style={{ transform: `translateX(${dx / 3}px)` }}
        >
          <ChevronLeft className="size-4" aria-hidden />
          {cancelling ? 'Release to cancel' : 'Slide to cancel'}
          <Lock className="ml-auto size-4" aria-label="Tap the mic to lock recording" />
        </span>
      ) : (
        <>
          <span className="flex h-6 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden>
            {level.map((v, i) => (
              <span
                key={i}
                className="w-[3px] rounded-full bg-wa-icon"
                style={{ height: `${Math.max(12, Math.min(100, v * 400))}%` }}
              />
            ))}
          </span>
          <button
            type="button"
            aria-label="Delete recording"
            onClick={() => stop(true)}
            className="inline-flex size-9 items-center justify-center rounded-full text-danger hover:bg-wa-hover"
          >
            <Trash2 className="size-5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Send voice message"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => stop(false)}
            className="inline-flex size-10 items-center justify-center rounded-full bg-brand text-brand-contrast"
          >
            <SendHorizontal className="size-5" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
