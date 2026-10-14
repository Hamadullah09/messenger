'use client';

import type {
  CallConfigDto,
  CallDto,
  CallSignal,
  PublicUserDto,
  SfuTokenDto,
} from '@storeline/shared';
import type { LocalTrackPublication, Room } from 'livekit-client';
import { Mic, MicOff, Phone, PhoneOff, Users, Video, VideoOff } from 'lucide-react';
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
  /** This device started or answered/joined the call (other devices only see it ring). */
  ownsCall: boolean;
  local: MediaStream | null;
  /** Other people's audio/video, by user id. */
  remotes: Record<string, MediaStream>;
  /** Who turned their camera off, by user id. */
  cameraOffBy: Record<string, boolean>;
  muted: boolean;
  cameraOff: boolean;
  connectedAt: number | null;
  message: string | null;
}

const initial: CallStore = {
  call: null,
  phase: null,
  ownsCall: false,
  local: null,
  remotes: {},
  cameraOffBy: {},
  muted: false,
  cameraOff: false,
  connectedAt: null,
  message: null,
};

export const useCallStore = create<CallStore>(() => initial);

/** One peer connection per other person (one-to-one: one; group: up to 7). */
const peers = new Map<string, { pc: RTCPeerConnection; pendingIce: RTCIceCandidateInit[] }>();
let ringTimer: number | null = null;
/** Big group calls: the LiveKit room and what this device publishes to it. */
let room: Room | null = null;
let published: LocalTrackPublication[] = [];
let config: CallConfigDto | null = null;
let emitSignal: ((payload: CallSignal) => void) | null = null;
let myUserId = '';

async function callConfig(): Promise<CallConfigDto> {
  config ??= await api<CallConfigDto>('/calls/config');
  return config;
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

function closePeer(userId: string) {
  peers.get(userId)?.pc.close();
  peers.delete(userId);
  const { remotes, cameraOffBy } = useCallStore.getState();
  const nextRemotes = { ...remotes };
  delete nextRemotes[userId];
  const nextOff = { ...cameraOffBy };
  delete nextOff[userId];
  useCallStore.setState({ remotes: nextRemotes, cameraOffBy: nextOff });
}

function cleanup(message: string | null = null) {
  if (ringTimer) window.clearTimeout(ringTimer);
  ringTimer = null;
  for (const id of [...peers.keys()]) closePeer(id);
  room?.disconnect().catch(() => undefined);
  room = null;
  published = [];
  ringtone.stop();
  stopTracks(useCallStore.getState().local);
  if (message) {
    useCallStore.setState({
      ...initial,
      phase: 'ended',
      message,
      call: useCallStore.getState().call,
    });
    window.setTimeout(() => {
      if (useCallStore.getState().phase === 'ended') useCallStore.setState(initial);
    }, 6000);
  } else {
    useCallStore.setState(initial);
  }
}

/** Why the camera or microphone could not be used, in words the person can act on. */
class MediaError extends Error {}

async function getMedia(video: boolean): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new MediaError('Calls need a secure (https) address. Open SMA with https to call.');
  const audio = { echoCancellation: true, noiseSuppression: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
      throw new MediaError(
        video
          ? 'The camera or microphone is blocked. Allow them for this site in the browser (the lock icon next to the address), then try again.'
          : 'The microphone is blocked. Allow it for this site in the browser (the lock icon next to the address), then try again.',
      );
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      // No camera on this device: a video call can still go ahead with voice only.
      if (video) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio, video: false });
        } catch {
          // fall through to the message below
        }
      }
      throw new MediaError(
        'No microphone was found on this device. Connect one (or use a phone) to call.',
      );
    }
    if (name === 'NotReadableError' || name === 'AbortError')
      throw new MediaError(
        'The microphone or camera is being used by another app. Close it and try again.',
      );
    throw new MediaError(
      'The microphone or camera could not be started. Check the browser permissions and try again.',
    );
  }
}

/** The person-facing reason a call failed. */
function callError(error: unknown): string {
  return error instanceof MediaError ? error.message : errorMessage(error);
}

function send(callId: string, to: string, data: CallSignal['data']) {
  emitSignal?.({ callId, to, data });
}

async function peerFor(callId: string, userId: string): Promise<RTCPeerConnection> {
  const existing = peers.get(userId);
  if (existing) return existing.pc;
  const { iceServers } = await callConfig();
  const pc = new RTCPeerConnection({ iceServers });
  const local = useCallStore.getState().local;
  local?.getTracks().forEach((track) => pc.addTrack(track, local));
  pc.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    useCallStore.setState({ remotes: { ...useCallStore.getState().remotes, [userId]: stream } });
  };
  pc.onicecandidate = (event) => {
    if (event.candidate)
      send(callId, userId, {
        type: 'ice',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
  };
  pc.onconnectionstatechange = () => {
    const state = useCallStore.getState();
    if (pc.connectionState === 'connected')
      useCallStore.setState({ phase: 'active', connectedAt: state.connectedAt ?? Date.now() });
    if (pc.connectionState === 'failed') {
      if (state.call?.group) {
        closePeer(userId);
      } else if (state.call) {
        void api(`/calls/${state.call.id}/end`, {
          method: 'POST',
          body: { reason: 'failed' },
        }).catch(() => undefined);
        cleanup('The connection failed.');
      }
    }
  };
  peers.set(userId, { pc, pendingIce: [] });
  return pc;
}

async function offerTo(callId: string, userId: string) {
  const pc = await peerFor(callId, userId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send(callId, userId, { type: 'offer', sdp: offer.sdp ?? '' });
}

async function flushIce(userId: string) {
  const p = peers.get(userId);
  if (!p?.pc.remoteDescription) return;
  for (const c of p.pendingIce) await p.pc.addIceCandidate(c).catch(() => undefined);
  p.pendingIce = [];
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

/**
 * Big group calls: joins the LiveKit room (media through the server), publishes this device's
 * microphone/camera and shows everyone else's streams.
 */
async function connectSfu(call: CallDto) {
  const { url, token } = await api<SfuTokenDto>(`/calls/${call.id}/sfu-token`, { method: 'POST' });
  const lk = await import('livekit-client');
  const r = new lk.Room({ adaptiveStream: true, dynacast: true });
  room = r;
  const refresh = () => {
    if (room !== r) return;
    const remotes: Record<string, MediaStream> = {};
    const cameraOffBy: Record<string, boolean> = {};
    for (const p of r.remoteParticipants.values()) {
      const tracks: MediaStreamTrack[] = [];
      let videoOn = false;
      for (const pub of p.trackPublications.values()) {
        if (pub.track && !pub.isMuted) tracks.push(pub.track.mediaStreamTrack);
        if (pub.kind === lk.Track.Kind.Video && pub.track && !pub.isMuted) videoOn = true;
      }
      if (tracks.length) remotes[p.identity] = new MediaStream(tracks);
      cameraOffBy[p.identity] = !videoOn;
    }
    const state = useCallStore.getState();
    useCallStore.setState({
      remotes,
      cameraOffBy,
      phase: 'active',
      connectedAt: state.connectedAt ?? Date.now(),
    });
  };
  r.on(lk.RoomEvent.TrackSubscribed, refresh)
    .on(lk.RoomEvent.TrackUnsubscribed, refresh)
    .on(lk.RoomEvent.TrackMuted, refresh)
    .on(lk.RoomEvent.TrackUnmuted, refresh)
    .on(lk.RoomEvent.ParticipantDisconnected, refresh)
    .on(lk.RoomEvent.Disconnected, () => {
      if (room === r && useCallStore.getState().phase !== 'ended') {
        void api(`/calls/${call.id}/end`, { method: 'POST', body: { reason: 'failed' } }).catch(
          () => undefined,
        );
        cleanup('The call was disconnected.');
      }
    });
  await r.connect(url, token);
  const local = useCallStore.getState().local;
  published = [];
  for (const track of local?.getTracks() ?? [])
    published.push(await r.localParticipant.publishTrack(track));
  refresh();
}

/** Starts a call in a chat (one-to-one) or a group (others join). */
export async function startCall(conversationId: string, media: 'audio' | 'video'): Promise<void> {
  if (useCallStore.getState().phase && useCallStore.getState().phase !== 'ended') return;
  let local: MediaStream | null = null;
  try {
    local = await getMedia(media === 'video');
    useCallStore.setState({ ...initial, local, phase: 'outgoing', ownsCall: true });
    const call = await api<CallDto>('/calls', { method: 'POST', body: { conversationId, media } });
    if (call.state === 'ended') {
      stopTracks(local);
      cleanup(
        call.outcome === 'busy'
          ? `${call.callee.displayName} is on another call.`
          : 'The call could not be made.',
      );
      return;
    }
    useCallStore.setState({ call });
    if (call.group) {
      if (call.sfu) {
        useCallStore.setState({ phase: 'connecting' });
        await connectSfu(call);
        return;
      }
      // Joined a call that was already running: connect to everyone in it.
      useCallStore.setState({ phase: call.participants.length > 1 ? 'connecting' : 'active' });
      for (const p of call.participants) if (p.id !== myUserId) await offerTo(call.id, p.id);
      return;
    }
    const { ringSeconds } = await callConfig();
    ringTimer = window.setTimeout(() => {
      if (useCallStore.getState().phase === 'outgoing') {
        void api(`/calls/${call.id}/end`, { method: 'POST', body: { reason: 'timeout' } }).catch(
          () => undefined,
        );
        cleanup('No answer.');
      }
    }, ringSeconds * 1000);
  } catch (error) {
    stopTracks(local);
    cleanup(callError(error));
  }
}

async function acceptCall() {
  const { call } = useCallStore.getState();
  if (!call) return;
  ringtone.stop();
  if (ringTimer) window.clearTimeout(ringTimer);
  try {
    const local = await getMedia(call.media === 'video');
    useCallStore.setState({ local, phase: 'connecting', ownsCall: true });
    if (call.group) {
      const joined = await api<CallDto>(`/calls/${call.id}/join`, { method: 'POST' });
      useCallStore.setState({ call: joined });
      if (joined.sfu) {
        await connectSfu(joined);
        return;
      }
      for (const p of joined.participants) if (p.id !== myUserId) await offerTo(joined.id, p.id);
      if (joined.participants.length <= 1) useCallStore.setState({ phase: 'active' });
      return;
    }
    await peerFor(call.id, call.caller.id);
    await api<CallDto>(`/calls/${call.id}/accept`, { method: 'POST' });
  } catch (error) {
    if (!call.group)
      void api(`/calls/${call.id}/decline`, { method: 'POST' }).catch(() => undefined);
    cleanup(callError(error));
  }
}

async function declineCall() {
  const { call } = useCallStore.getState();
  if (call && !call.group)
    void api(`/calls/${call.id}/decline`, { method: 'POST' }).catch(() => undefined);
  cleanup();
}

async function hangUp() {
  const { call } = useCallStore.getState();
  if (call)
    void api(`/calls/${call.id}/end`, { method: 'POST', body: { reason: 'hangup' } }).catch(
      () => undefined,
    );
  cleanup();
}

function toggleMute() {
  const { local, muted } = useCallStore.getState();
  local?.getAudioTracks().forEach((t) => (t.enabled = muted));
  // LiveKit: mute the published track so others see it as muted.
  for (const pub of published)
    if (pub.track?.mediaStreamTrack.kind === 'audio') void (muted ? pub.unmute() : pub.mute());
  useCallStore.setState({ muted: !muted });
}

function toggleCamera() {
  const { local, cameraOff, call } = useCallStore.getState();
  local?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
  for (const pub of published)
    if (pub.track?.mediaStreamTrack.kind === 'video') void (cameraOff ? pub.unmute() : pub.mute());
  useCallStore.setState({ cameraOff: !cameraOff });
  if (call)
    for (const id of peers.keys())
      send(call.id, id, { type: 'media', audio: true, video: cameraOff });
}

/** Listens for calls on the live connection and shows the call screen. Mount once. */
export function CallHost() {
  const socket = useSocket();
  const myId = useAuth((s) => s.me?.user.id);
  myUserId = myId ?? '';
  useEffect(() => {
    if (!socket) return;
    emitSignal = (payload) => socket.emit('call.signal', payload, () => undefined);
    const onIncoming = (call: CallDto) => {
      const state = useCallStore.getState();
      if (state.phase && state.phase !== 'ended') return; // busy on this device
      useCallStore.setState({ ...initial, call, phase: 'incoming' });
      ringtone.start();
      // Group calls keep going; stop ringing here after a while.
      void callConfig().then(({ ringSeconds }) => {
        ringTimer = window.setTimeout(() => {
          if (useCallStore.getState().phase === 'incoming') cleanup();
        }, ringSeconds * 1000);
      });
    };
    const onUpdated = async (call: CallDto) => {
      const state = useCallStore.getState();
      if (!state.call || state.call.id !== call.id) return;
      if (call.state === 'ended') {
        cleanup(
          state.phase === 'incoming'
            ? null
            : call.outcome === 'declined'
              ? 'Call declined.'
              : call.outcome === 'busy'
                ? 'Busy.'
                : 'Call ended.',
        );
        return;
      }
      useCallStore.setState({ call });
      if (call.group) {
        // People who left: drop their connection.
        const present = new Set(call.participants.map((p) => p.id));
        for (const id of [...peers.keys()]) if (!present.has(id)) closePeer(id);
        return;
      }
      if (call.state === 'active') {
        if (state.phase === 'incoming' && !state.ownsCall) {
          cleanup(); // answered on another device
          return;
        }
        if (state.phase === 'outgoing' && call.caller.id === myId && state.ownsCall) {
          if (ringTimer) window.clearTimeout(ringTimer);
          useCallStore.setState({ phase: 'connecting' });
          await offerTo(call.id, call.callee.id);
        }
      }
    };
    const onSignal = async (event: {
      callId: string;
      fromUserId: string;
      data: CallSignal['data'];
    }) => {
      const state = useCallStore.getState();
      if (!state.call || state.call.id !== event.callId || !state.ownsCall) return;
      const { data, fromUserId: from } = event;
      if (data.type === 'offer') {
        const pc = await peerFor(event.callId, from);
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await flushIce(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send(event.callId, from, { type: 'answer', sdp: answer.sdp ?? '' });
      } else if (data.type === 'answer') {
        await peers.get(from)?.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await flushIce(from);
      } else if (data.type === 'ice') {
        const candidate = {
          candidate: data.candidate.candidate,
          sdpMid: data.candidate.sdpMid ?? null,
          sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
        };
        const p = peers.get(from);
        if (p?.pc.remoteDescription) await p.pc.addIceCandidate(candidate).catch(() => undefined);
        else if (p) p.pendingIce.push(candidate);
      } else if (data.type === 'media') {
        useCallStore.setState({
          cameraOffBy: { ...useCallStore.getState().cameraOffBy, [from]: !data.video },
        });
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

function VideoView({
  stream,
  muted,
  className,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  className?: string;
}) {
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
      className={cx(
        'inline-flex size-16 items-center justify-center rounded-full transition-colors',
        tones[tone],
      )}
    >
      {children}
    </button>
  );
}

/** One person in a group call: their video, or their picture when the camera is off. */
function Tile({
  user,
  stream,
  video,
  cameraOff,
}: {
  user: PublicUserDto;
  stream: MediaStream | null;
  video: boolean;
  cameraOff: boolean;
}) {
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-neutral-800">
      {video && stream && !cameraOff ? (
        <VideoView stream={stream} className="h-full w-full object-cover" />
      ) : (
        <>
          <Avatar name={user.displayName} size={72} />
          <AudioOut stream={stream} />
        </>
      )}
      <span className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2.5 py-0.5 text-sm">
        {user.displayName}
      </span>
      {!stream && (
        <span className="absolute top-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-xs">
          Connecting…
        </span>
      )}
    </div>
  );
}

function CallScreen({ myId }: { myId: string }) {
  const s = useCallStore();
  if (!s.phase || !s.call) {
    if (s.phase === 'ended' && s.message)
      return (
        <div
          role="status"
          className="fixed inset-x-0 top-4 z-[80] mx-auto w-max max-w-[calc(100%-2rem)] rounded-2xl bg-neutral-900 px-5 py-2.5 text-center text-white shadow-xl"
        >
          {s.message}
        </div>
      );
    return null;
  }
  const call = s.call;
  const video = call.media === 'video';
  const controls =
    s.phase === 'incoming' ? (
      <>
        <RoundButton
          label={call.group ? 'Ignore' : 'Decline'}
          tone="danger"
          onClick={() => void declineCall()}
        >
          <PhoneOff className="size-7" aria-hidden />
        </RoundButton>
        <RoundButton
          label={call.group ? 'Join' : 'Accept'}
          tone="success"
          onClick={() => void acceptCall()}
        >
          {video ? (
            <Video className="size-7" aria-hidden />
          ) : (
            <Phone className="size-7" aria-hidden />
          )}
        </RoundButton>
      </>
    ) : (
      <>
        <RoundButton
          label={s.muted ? 'Unmute' : 'Mute'}
          tone={s.muted ? 'active' : 'neutral'}
          onClick={toggleMute}
        >
          {s.muted ? (
            <MicOff className="size-7" aria-hidden />
          ) : (
            <Mic className="size-7" aria-hidden />
          )}
        </RoundButton>
        {video && (
          <RoundButton
            label={s.cameraOff ? 'Turn camera on' : 'Turn camera off'}
            tone={s.cameraOff ? 'active' : 'neutral'}
            onClick={toggleCamera}
          >
            {s.cameraOff ? (
              <VideoOff className="size-7" aria-hidden />
            ) : (
              <Video className="size-7" aria-hidden />
            )}
          </RoundButton>
        )}
        <RoundButton
          label={call.group ? 'Leave' : 'Hang up'}
          tone="danger"
          onClick={() => void hangUp()}
        >
          <PhoneOff className="size-7" aria-hidden />
        </RoundButton>
      </>
    );

  if (call.group && s.phase !== 'incoming') {
    const others = call.participants.filter((p) => p.id !== myId);
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Group call: ${call.title ?? 'Group'}`}
        className="fixed inset-0 z-[80] flex flex-col bg-neutral-950 text-white"
      >
        <header className="flex items-center gap-2 px-4 py-3">
          <Users className="size-5" aria-hidden />
          <p className="flex-1 truncate font-semibold">{call.title ?? 'Group call'}</p>
          <p className="text-sm text-white/70">
            {call.participants.length} in the call{' '}
            {s.connectedAt && (
              <>
                · <Elapsed since={s.connectedAt} />
              </>
            )}
          </p>
        </header>
        <div
          className={cx(
            'grid flex-1 content-center gap-3 overflow-y-auto p-3',
            others.length <= 1
              ? 'grid-cols-1'
              : others.length <= 4
                ? 'grid-cols-2'
                : 'grid-cols-2 md:grid-cols-3',
          )}
        >
          {others.length === 0 && (
            <p className="text-center text-white/70">Waiting for others to join…</p>
          )}
          {others.map((p) => (
            <Tile
              key={p.id}
              user={p}
              stream={s.remotes[p.id] ?? null}
              video={video}
              cameraOff={!!s.cameraOffBy[p.id]}
            />
          ))}
        </div>
        {video && s.local && !s.cameraOff && (
          <VideoView
            stream={s.local}
            muted
            className="absolute right-4 bottom-32 z-20 h-36 w-24 rounded-2xl border-2 border-white/40 object-cover shadow-xl"
          />
        )}
        <div className="relative z-20 flex items-center justify-center gap-5 pb-8">{controls}</div>
      </div>
    );
  }

  const peerUser = call.group
    ? { ...call.caller, displayName: call.title ?? 'Group call' }
    : call.caller.id === myId
      ? call.callee
      : call.caller;
  const remote = s.remotes[peerUser.id] ?? Object.values(s.remotes)[0] ?? null;
  const remoteCameraOff = !!s.cameraOffBy[peerUser.id];
  const status =
    s.phase === 'incoming'
      ? call.group
        ? `${call.caller.displayName} started a ${video ? 'video' : 'voice'} call`
        : `Incoming ${video ? 'video' : 'voice'} call`
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
      {video && s.phase === 'active' && !remoteCameraOff ? (
        <VideoView stream={remote} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <AudioOut stream={remote} />
      )}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        {(!video || s.phase !== 'active' || remoteCameraOff) && (
          <>
            <Avatar name={peerUser.displayName} size={120} />
            <p className="text-2xl font-semibold">{peerUser.displayName}</p>
            <p className="text-white/70">
              {status ?? (s.connectedAt ? <Elapsed since={s.connectedAt} /> : null)}
            </p>
          </>
        )}
        {video && s.phase === 'active' && !remoteCameraOff && (
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
      <div className="relative z-20 flex items-center justify-center gap-5 pb-10">{controls}</div>
    </div>
  );
}
