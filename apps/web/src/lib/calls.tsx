'use client';

import type { CallConfigDto, CallDto, CallSignal } from '@storeline/shared';
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Avatar, cx } from '@/components/ui';
import { api, errorMessage } from './api';
import { useAuth } from './auth-store';
import { useSocket } from './realtime';

type Phase = 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

interface CallStore {
  call: CallDto | null;
  phase: Phase | null;
  /** This device started or answered the call (other devices only see it ring). */
  ownsCall: boolean;
  local: MediaStream | null;
  remote: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  remoteCameraOff: boolean;
  connectedAt: number | null;
  message: string | null;
}

const initial: CallStore = {
  call: null,
  phase: null,
  ownsCall: false,
  local: null,
  remote: null,
  muted: false,
  cameraOff: false,
  remoteCameraOff: false,
  connectedAt: null,
  message: null,
};

export const useCallStore = create<CallStore>(() => initial);

let peer: RTCPeerConnection | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let ringTimer: number | null = null;
let config: CallConfigDto | null = null;
let emitSignal: ((payload: CallSignal) => void) | null = null;

async function callConfig(): Promise<CallConfigDto> {
  config ??= await api<CallConfigDto>('/calls/config');
  return config;
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

function cleanup(message: string | null = null) {
  if (ringTimer) window.clearTimeout(ringTimer);
  ringTimer = null;
  peer?.close();
  peer = null;
  pendingIce = [];
  ringtone.stop();
  const { local } = useCallStore.getState();
  stopTracks(local);
  if (message) {
    useCallStore.setState({ ...initial, phase: 'ended', message, call: useCallStore.getState().call });
    window.setTimeout(() => {
      if (useCallStore.getState().phase === 'ended') useCallStore.setState(initial);
    }, 2500);
  } else {
    useCallStore.setState(initial);
  }
}

async function getMedia(video: boolean): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('Calls need a secure (https) address. Open SMA with https to call.');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch {
    throw new Error(
      video
        ? 'Allow the camera and microphone in your browser to make video calls.'
        : 'Allow the microphone in your browser to make calls.',
    );
  }
}

async function createPeer(callId: string): Promise<RTCPeerConnection> {
  const { iceServers } = await callConfig();
  const pc = new RTCPeerConnection({ iceServers });
  const local = useCallStore.getState().local;
  local?.getTracks().forEach((track) => pc.addTrack(track, local));
  const remote = new MediaStream();
  useCallStore.setState({ remote });
  pc.ontrack = (event) => {
    event.streams[0]?.getTracks().forEach((t) => {
      if (!remote.getTracks().includes(t)) remote.addTrack(t);
    });
    useCallStore.setState({ remote: new MediaStream(remote.getTracks()) });
  };
  pc.onicecandidate = (event) => {
    if (event.candidate)
      emitSignal?.({
        callId,
        data: {
          type: 'ice',
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        },
      });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected')
      useCallStore.setState({ phase: 'active', connectedAt: useCallStore.getState().connectedAt ?? Date.now() });
    if (pc.connectionState === 'failed') {
      void api(`/calls/${callId}/end`, { method: 'POST', body: { reason: 'failed' } }).catch(() => undefined);
      cleanup('The connection failed.');
    }
  };
  peer = pc;
  return pc;
}

async function flushIce() {
  if (!peer?.remoteDescription) return;
  for (const c of pendingIce) await peer.addIceCandidate(c).catch(() => undefined);
  pendingIce = [];
}

/** A soft repeating ring tone (generated; no sound file). */
const ringtone = (() => {
  let ctx: AudioContext | null = null;
  let timer: number | null = null;
  const beep = () => {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [f, at] of [
      [660, 0],
      [880, 0.18],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.2, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.32);
    }
  };
  return {
    start() {
      try {
        ctx ??= new AudioContext();
        void ctx.resume();
        beep();
        timer ??= window.setInterval(beep, 1800);
      } catch {
        // No sound available.
      }
    },
    stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
    },
  };
})();

export function useCallControls() {
  return { start: startCall };
}

export async function startCall(conversationId: string, media: 'audio' | 'video'): Promise<void> {
  if (useCallStore.getState().phase && useCallStore.getState().phase !== 'ended') return;
  let local: MediaStream | null = null;
  try {
    local = await getMedia(media === 'video');
    useCallStore.setState({ ...initial, local, phase: 'outgoing', ownsCall: true, cameraOff: false });
    const call = await api<CallDto>('/calls', { method: 'POST', body: { conversationId, media } });
    if (call.state === 'ended') {
      stopTracks(local);
      cleanup(call.outcome === 'busy' ? `${call.callee.displayName} is on another call.` : 'The call could not be made.');
      return;
    }
    useCallStore.setState({ call });
    const { ringSeconds } = await callConfig();
    ringTimer = window.setTimeout(() => {
      if (useCallStore.getState().phase === 'outgoing') {
        void api(`/calls/${call.id}/end`, { method: 'POST', body: { reason: 'timeout' } }).catch(() => undefined);
        cleanup('No answer.');
      }
    }, ringSeconds * 1000);
  } catch (error) {
    stopTracks(local);
    cleanup(errorMessage(error));
  }
}

async function acceptCall() {
  const { call } = useCallStore.getState();
  if (!call) return;
  ringtone.stop();
  try {
    const local = await getMedia(call.media === 'video');
    useCallStore.setState({ local, phase: 'connecting', ownsCall: true });
    await createPeer(call.id);
    await api<CallDto>(`/calls/${call.id}/accept`, { method: 'POST' });
  } catch (error) {
    void api(`/calls/${call.id}/decline`, { method: 'POST' }).catch(() => undefined);
    cleanup(errorMessage(error));
  }
}

async function declineCall() {
  const { call } = useCallStore.getState();
  if (call) void api(`/calls/${call.id}/decline`, { method: 'POST' }).catch(() => undefined);
  cleanup();
}

async function hangUp() {
  const { call } = useCallStore.getState();
  if (call) void api(`/calls/${call.id}/end`, { method: 'POST', body: { reason: 'hangup' } }).catch(() => undefined);
  cleanup();
}

function toggleMute() {
  const { local, muted } = useCallStore.getState();
  local?.getAudioTracks().forEach((t) => (t.enabled = muted));
  useCallStore.setState({ muted: !muted });
}

function toggleCamera() {
  const { local, cameraOff, call } = useCallStore.getState();
  local?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
  useCallStore.setState({ cameraOff: !cameraOff });
  if (call) emitSignal?.({ callId: call.id, data: { type: 'media', audio: true, video: cameraOff } });
}

/** Listens for calls on the live connection and shows the call screen. Mount once. */
export function CallHost() {
  const socket = useSocket();
  const myId = useAuth((s) => s.me?.user.id);
  useEffect(() => {
    if (!socket) return;
    emitSignal = (payload) => socket.emit('call.signal', payload, () => undefined);
    const onIncoming = (call: CallDto) => {
      const state = useCallStore.getState();
      if (state.phase && state.phase !== 'ended') {
        // Busy on this device: let the other devices ring; nothing to do here.
        return;
      }
      useCallStore.setState({ ...initial, call, phase: 'incoming' });
      ringtone.start();
    };
    const onUpdated = async (call: CallDto) => {
      const state = useCallStore.getState();
      if (!state.call || state.call.id !== call.id) return;
      if (call.state === 'ended') {
        const outcome = call.outcome;
        cleanup(
          state.phase === 'incoming'
            ? null
            : outcome === 'declined'
              ? 'Call declined.'
              : outcome === 'answered'
                ? 'Call ended.'
                : outcome === 'busy'
                  ? 'Busy.'
                  : 'Call ended.',
        );
        return;
      }
      if (call.state === 'active') {
        useCallStore.setState({ call });
        if (state.phase === 'incoming' && !state.ownsCall) {
          // Answered on another device.
          cleanup();
          return;
        }
        if (state.phase === 'outgoing' && call.caller.id === myId && state.ownsCall) {
          if (ringTimer) window.clearTimeout(ringTimer);
          useCallStore.setState({ phase: 'connecting' });
          const pc = await createPeer(call.id);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          emitSignal?.({ callId: call.id, data: { type: 'offer', sdp: offer.sdp ?? '' } });
        }
      }
    };
    const onSignal = async (event: { callId: string; data: CallSignal['data'] }) => {
      const state = useCallStore.getState();
      if (!state.call || state.call.id !== event.callId || !state.ownsCall) return;
      const data = event.data;
      if (data.type === 'offer') {
        const pc = peer ?? (await createPeer(event.callId));
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        emitSignal?.({ callId: event.callId, data: { type: 'answer', sdp: answer.sdp ?? '' } });
      } else if (data.type === 'answer') {
        await peer?.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await flushIce();
      } else if (data.type === 'ice') {
        const candidate = {
          candidate: data.candidate.candidate,
          sdpMid: data.candidate.sdpMid ?? null,
          sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
        };
        if (peer?.remoteDescription) await peer.addIceCandidate(candidate).catch(() => undefined);
        else pendingIce.push(candidate);
      } else if (data.type === 'media') {
        useCallStore.setState({ remoteCameraOff: !data.video });
      }
    };
    socket.on('call.incoming', onIncoming);
    socket.on('call.updated', (c) => void onUpdated(c));
    socket.on('call.signal', (e) => void onSignal(e));
    return () => {
      socket.off('call.incoming', onIncoming);
      socket.off('call.updated');
      socket.off('call.signal');
      emitSignal = null;
    };
  }, [socket, myId]);

  return <CallScreen myId={myId ?? ''} />;
}

function VideoView({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

function AudioOut({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="tabular-nums">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  );
}

function RoundButton({
  label,
  onClick,
  tone = 'neutral',
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'neutral' | 'danger' | 'success' | 'active';
  children: React.ReactNode;
}) {
  const tones = {
    neutral: 'bg-white/15 text-white hover:bg-white/25',
    active: 'bg-white text-neutral-900',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    success: 'bg-green-600 text-white hover:bg-green-700',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx('inline-flex size-16 items-center justify-center rounded-full transition-colors', tones[tone])}
    >
      {children}
    </button>
  );
}

function CallScreen({ myId }: { myId: string }) {
  const s = useCallStore();
  if (!s.phase || !s.call) {
    if (s.phase === 'ended' && s.message)
      return (
        <div role="status" className="fixed inset-x-0 top-4 z-[80] mx-auto w-max rounded-full bg-neutral-900 px-5 py-2 text-white shadow-xl">
          {s.message}
        </div>
      );
    return null;
  }
  const call = s.call;
  const peerUser = call.caller.id === myId ? call.callee : call.caller;
  const video = call.media === 'video';
  const status =
    s.phase === 'incoming'
      ? `Incoming ${video ? 'video' : 'voice'} call`
      : s.phase === 'outgoing'
        ? 'Calling…'
        : s.phase === 'connecting'
          ? 'Connecting…'
          : s.phase === 'ended'
            ? (s.message ?? 'Call ended')
            : null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${peerUser.displayName}`}
      className="fixed inset-0 z-[80] flex flex-col bg-neutral-950 text-white"
    >
      {video && s.phase === 'active' && !s.remoteCameraOff ? (
        <VideoView stream={s.remote} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <AudioOut stream={s.remote} />
      )}
      {video && s.phase === 'active' && <AudioOut stream={null} />}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        {(!video || s.phase !== 'active' || s.remoteCameraOff) && (
          <>
            <Avatar name={peerUser.displayName} size={120} />
            <p className="text-2xl font-semibold">{peerUser.displayName}</p>
            <p className="text-white/70">
              {status ?? (s.connectedAt ? <Elapsed since={s.connectedAt} /> : null)}
            </p>
          </>
        )}
        {video && s.phase === 'active' && !s.remoteCameraOff && (
          <p className="absolute top-6 rounded-full bg-black/40 px-4 py-1 text-sm">
            {peerUser.displayName} · {s.connectedAt && <Elapsed since={s.connectedAt} />}
          </p>
        )}
      </div>
      {video && s.local && s.phase !== 'incoming' && !s.cameraOff && (
        <VideoView
          stream={s.local}
          muted
          className="absolute right-4 bottom-32 z-20 h-40 w-28 rounded-2xl border-2 border-white/40 object-cover shadow-xl sm:h-48 sm:w-36"
        />
      )}
      <div className="relative z-20 flex items-center justify-center gap-5 pb-10">
        {s.phase === 'incoming' ? (
          <>
            <RoundButton label="Decline" tone="danger" onClick={() => void declineCall()}>
              <PhoneOff className="size-7" aria-hidden />
            </RoundButton>
            <RoundButton label="Accept" tone="success" onClick={() => void acceptCall()}>
              {video ? <Video className="size-7" aria-hidden /> : <Phone className="size-7" aria-hidden />}
            </RoundButton>
          </>
        ) : (
          <>
            <RoundButton label={s.muted ? 'Unmute' : 'Mute'} tone={s.muted ? 'active' : 'neutral'} onClick={toggleMute}>
              {s.muted ? <MicOff className="size-7" aria-hidden /> : <Mic className="size-7" aria-hidden />}
            </RoundButton>
            {video && (
              <RoundButton
                label={s.cameraOff ? 'Turn camera on' : 'Turn camera off'}
                tone={s.cameraOff ? 'active' : 'neutral'}
                onClick={toggleCamera}
              >
                {s.cameraOff ? <VideoOff className="size-7" aria-hidden /> : <Video className="size-7" aria-hidden />}
              </RoundButton>
            )}
            <RoundButton label="Hang up" tone="danger" onClick={() => void hangUp()}>
              <PhoneOff className="size-7" aria-hidden />
            </RoundButton>
          </>
        )}
      </div>
    </div>
  );
}
