'use client';

import type {
  CallConfigDto,
  CallDto,
  CallSignal,
  PublicUserDto,
  SfuTokenDto,
} from '@storeline/shared';
import type { LocalTrackPublication, Room } from 'livekit-client';
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Phone,
  PhoneOff,
  ScreenShareOff,
  SwitchCamera,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
  X,
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
  /** This device started or answered/joined the call (other devices only see it ring). */
  ownsCall: boolean;
  local: MediaStream | null;
  /** Other people's audio/video, by user id. */
  remotes: Record<string, MediaStream>;
  /** Who turned their camera off, by user id. */
  cameraOffBy: Record<string, boolean>;
  /** Who muted their microphone, by user id. */
  mutedBy: Record<string, boolean>;
  muted: boolean;
  cameraOff: boolean;
  /** A voice call in which someone turned their camera on. */
  videoMode: boolean;
  /** This device sends its screen instead of the camera. */
  sharing: boolean;
  /** Front or back camera; the preview is mirrored for the front one. */
  facing: 'user' | 'environment';
  /** How many cameras this device has (switch button from 2). */
  cameras: number;
  /** The connection dropped and is being restored. */
  reconnecting: boolean;
  /** The call screen is shrunk so the app can be used during the call. */
  minimized: boolean;
  /** Speaker / headphones chosen for the call ('' = the device default). */
  sinkId: string;
  /** The browser would not play sound until the person taps. */
  soundBlocked: boolean;
  connectedAt: number | null;
  /** The reason a call ended (shown briefly). */
  message: string | null;
  /** A short note during the call ("Could not switch camera"). */
  notice: string | null;
  /** Switching a voice call to video: this device asked, or the other person is asking. */
  videoAsk: 'sent' | 'received' | null;
}

const initial: CallStore = {
  call: null,
  phase: null,
  ownsCall: false,
  local: null,
  remotes: {},
  cameraOffBy: {},
  mutedBy: {},
  muted: false,
  cameraOff: false,
  videoMode: false,
  sharing: false,
  facing: 'user',
  cameras: 0,
  reconnecting: false,
  minimized: false,
  sinkId: '',
  soundBlocked: false,
  connectedAt: null,
  message: null,
  notice: null,
  videoAsk: null,
};

export const useCallStore = create<CallStore>(() => initial);

interface Peer {
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  /** Everything this person sends, gathered from all their tracks. */
  remote: MediaStream;
  /** On a clash of offers the polite side gives way (decided the same way on both sides). */
  polite: boolean;
  makingOffer: boolean;
  /** The first offer/answer is done; later changes renegotiate by themselves. */
  ready: boolean;
  /** Set while the connection is lost: give up when it fires. */
  lostTimer: number | null;
}

/** How long a dropped connection may take to come back before the call ends. */
const RECONNECT_GIVE_UP_MS = 25_000;

/** One peer connection per other person (one-to-one: one; group: up to 7). */
const peers = new Map<string, Peer>();
let ringTimer: number | null = null;
let noticeTimer: number | null = null;
/** Big group calls: the LiveKit room and what this device publishes to it. */
let room: Room | null = null;
let published: LocalTrackPublication[] = [];
let config: CallConfigDto | null = null;
let emitSignal: ((payload: CallSignal) => void) | null = null;
let myUserId = '';
/** Was the camera on before screen sharing started (turn it back on after). */
let cameraBeforeShare = false;
/** A video request nobody answered is withdrawn after this long. */
let videoAskTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let linkHandled = false;
let aliveTimer: number | null = null;

/**
 * Tells the server every 10 s that this device is still in the call, so a call left behind by a
 * closed tab or a reload ends by itself. If the server says the call is over (an "ended" event
 * was missed), the call screen closes.
 */
function keepAlive(callId: string) {
  if (aliveTimer) window.clearInterval(aliveTimer);
  const beat = () =>
    api<{ state: 'ringing' | 'active' | 'ended' }>(`/calls/${callId}/alive`, { method: 'POST' })
      .then(({ state }) => {
        const now = useCallStore.getState();
        if (state === 'ended' && now.call?.id === callId && now.phase && now.phase !== 'ended')
          cleanup('Call ended.');
      })
      .catch(() => undefined);
  void beat();
  aliveTimer = window.setInterval(beat, 10_000);
}

/** Asks whether a call is ringing for me (after a reload or a reconnect, the ring was missed). */
async function checkIncoming() {
  const state = useCallStore.getState();
  if (state.phase && state.phase !== 'ended') return;
  try {
    const { call } = await api<{ call: CallDto | null }>('/calls/incoming');
    const now = useCallStore.getState();
    if (call && (!now.phase || now.phase === 'ended')) showIncoming(call);
  } catch {
    // Not important: the next ring or notification will show it.
  }
}

async function callConfig(): Promise<CallConfigDto> {
  config ??= await api<CallConfigDto>('/calls/config');
  return config;
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

const hasVideo = (stream: MediaStream | null | undefined) =>
  !!stream?.getVideoTracks().some((t) => t.readyState === 'live');

function notice(text: string) {
  if (noticeTimer) window.clearTimeout(noticeTimer);
  useCallStore.setState({ notice: text });
  noticeTimer = window.setTimeout(() => useCallStore.setState({ notice: null }), 4000);
}

/** A short message with no call screen ("This call has ended."). */
function toast(message: string) {
  useCallStore.setState({ ...initial, phase: 'ended', message });
  window.setTimeout(() => {
    if (useCallStore.getState().phase === 'ended') useCallStore.setState(initial);
  }, 5000);
}

function closePeer(userId: string) {
  const peer = peers.get(userId);
  if (peer?.lostTimer) window.clearTimeout(peer.lostTimer);
  peer?.pc.close();
  peers.delete(userId);
  const { remotes, cameraOffBy, mutedBy } = useCallStore.getState();
  const drop = <T,>(map: Record<string, T>) => {
    const next = { ...map };
    delete next[userId];
    return next;
  };
  useCallStore.setState({
    remotes: drop(remotes),
    cameraOffBy: drop(cameraOffBy),
    mutedBy: drop(mutedBy),
    reconnecting: [...peers.values()].some((p) => p.lostTimer !== null),
  });
}

async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // Not available (e.g. the page is hidden): the screen may dim, the call goes on.
  }
}

function cleanup(message: string | null = null) {
  if (ringTimer) window.clearTimeout(ringTimer);
  ringTimer = null;
  if (videoAskTimer) window.clearTimeout(videoAskTimer);
  videoAskTimer = null;
  if (aliveTimer) window.clearInterval(aliveTimer);
  aliveTimer = null;
  for (const id of [...peers.keys()]) closePeer(id);
  room?.disconnect().catch(() => undefined);
  room = null;
  published = [];
  cameraBeforeShare = false;
  tones.stop();
  void keepAwake(false);
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

function mediaError(error: unknown, video: boolean): MediaError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new MediaError(
      video
        ? 'The camera or microphone is blocked. Allow them for this site in the browser (the lock icon next to the address), then try again.'
        : 'The microphone is blocked. Allow it for this site in the browser (the lock icon next to the address), then try again.',
    );
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return new MediaError(
      video
        ? 'No camera was found on this device.'
        : 'No microphone was found on this device. Connect one (or use a phone) to call.',
    );
  if (name === 'NotReadableError' || name === 'AbortError')
    return new MediaError(
      'The microphone or camera is being used by another app. Close it and try again.',
    );
  return new MediaError(
    'The microphone or camera could not be started. Check the browser permissions and try again.',
  );
}

const cameraConstraints = (facing: 'user' | 'environment', deviceId?: string) =>
  deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } };

async function getMedia(video: boolean): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new MediaError('Calls need a secure (https) address. Open SMA with https to call.');
  const audio = { echoCancellation: true, noiseSuppression: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: video ? cameraConstraints('user') : false,
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    // No camera on this device: a video call can still go ahead with voice only.
    if (video && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch (inner) {
        throw mediaError(inner, false);
      }
    }
    throw mediaError(error, video);
  }
}

async function cameraTrack(
  facing: 'user' | 'environment',
  deviceId?: string,
): Promise<MediaStreamTrack> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(facing, deviceId),
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new MediaError('No camera was found on this device.');
    return track;
  } catch (error) {
    throw error instanceof MediaError ? error : mediaError(error, true);
  }
}

async function countCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    useCallStore.setState({ cameras: devices.filter((d) => d.kind === 'videoinput').length });
  } catch {
    // Unknown: no switch button.
  }
}

/** The person-facing reason a call failed. */
function callError(error: unknown): string {
  return error instanceof MediaError ? error.message : errorMessage(error);
}

function send(callId: string, to: string, data: CallSignal['data']) {
  emitSignal?.({ callId, to, data });
}

/** Tells everyone in the call whether this device's microphone and camera are on. */
function announce(only?: string) {
  const { call, local, muted, cameraOff, sharing, videoAsk } = useCallStore.getState();
  if (!call) return;
  const video = sharing || (hasVideo(local) && !cameraOff && videoAsk !== 'sent');
  for (const id of only ? [only] : peers.keys())
    send(call.id, id, { type: 'media', audio: !muted, video });
}

function refreshRemote(userId: string, peer: Peer) {
  if (peers.get(userId) !== peer) return;
  useCallStore.setState({
    remotes: {
      ...useCallStore.getState().remotes,
      // A new stream object so the screen picks up added or removed tracks.
      [userId]: new MediaStream(peer.remote.getTracks()),
    },
  });
}

/** The connection to one person dropped: try to restore it, give up after a while. */
function connectionLost(callId: string, userId: string, failed: boolean) {
  const peer = peers.get(userId);
  if (!peer) return;
  useCallStore.setState({ reconnecting: true });
  const restart = () => {
    if (peers.get(userId) === peer && peer.ready && peer.pc.connectionState !== 'connected')
      peer.pc.restartIce();
  };
  // A short blip often recovers by itself; otherwise find a new network path.
  if (failed) restart();
  else window.setTimeout(restart, 2500);
  peer.lostTimer ??= window.setTimeout(() => {
    if (peers.get(userId) !== peer || peer.pc.connectionState === 'connected') return;
    const { call } = useCallStore.getState();
    if (call?.group) {
      closePeer(userId);
    } else if (call) {
      void api(`/calls/${callId}/end`, { method: 'POST', body: { reason: 'failed' } }).catch(
        () => undefined,
      );
      cleanup('The connection was lost.');
    }
  }, RECONNECT_GIVE_UP_MS);
}

async function peerFor(callId: string, userId: string): Promise<Peer> {
  const existing = peers.get(userId);
  if (existing) return existing;
  const { iceServers } = await callConfig();
  const pc = new RTCPeerConnection({ iceServers });
  const peer: Peer = {
    pc,
    pendingIce: [],
    remote: new MediaStream(),
    polite: myUserId > userId,
    makingOffer: false,
    ready: false,
    lostTimer: null,
  };
  peers.set(userId, peer);
  const local = useCallStore.getState().local;
  local?.getTracks().forEach((track) => pc.addTrack(track, local));
  pc.ontrack = ({ track }) => {
    if (!peer.remote.getTracks().includes(track)) peer.remote.addTrack(track);
    track.onended = () => {
      peer.remote.removeTrack(track);
      refreshRemote(userId, peer);
    };
    track.onunmute = () => refreshRemote(userId, peer);
    refreshRemote(userId, peer);
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
  // Later changes (video turned on, screen shared, new network path) renegotiate here.
  pc.onnegotiationneeded = async () => {
    if (!peer.ready) return; // the first offer is sent explicitly
    try {
      peer.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      send(callId, userId, { type: 'offer', sdp: offer.sdp ?? '' });
    } catch {
      // The other side's offer won; theirs carries the change.
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onconnectionstatechange = () => {
    if (peers.get(userId) !== peer) return;
    const state = useCallStore.getState();
    if (pc.connectionState === 'connected') {
      if (peer.lostTimer) window.clearTimeout(peer.lostTimer);
      peer.lostTimer = null;
      useCallStore.setState({
        phase: state.phase === 'connecting' || state.phase === 'active' ? 'active' : state.phase,
        connectedAt: state.connectedAt ?? Date.now(),
        reconnecting: [...peers.values()].some((p) => p.lostTimer !== null),
      });
      announce(userId);
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      connectionLost(callId, userId, pc.connectionState === 'failed');
    }
  };
  return peer;
}

async function offerTo(callId: string, userId: string) {
  const peer = await peerFor(callId, userId);
  peer.makingOffer = true;
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    send(callId, userId, { type: 'offer', sdp: offer.sdp ?? '' });
  } finally {
    peer.makingOffer = false;
  }
}

async function flushIce(peer: Peer) {
  if (!peer.pc.remoteDescription) return;
  for (const c of peer.pendingIce) await peer.pc.addIceCandidate(c).catch(() => undefined);
  peer.pendingIce = [];
}

/** Sends a video track (camera or screen) to everyone, or stops sending video (null). */
async function sendVideo(track: MediaStreamTrack | null) {
  const local = useCallStore.getState().local;
  for (const { pc } of peers.values()) {
    const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
    if (transceiver) {
      await transceiver.sender.replaceTrack(track).catch(() => undefined);
      if (track && (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive'))
        transceiver.direction = 'sendrecv';
    } else if (track) {
      if (local) pc.addTrack(track, local);
      else pc.addTrack(track);
    }
  }
  if (room) {
    const pub = published.find((p) => p.track?.mediaStreamTrack.kind === 'video');
    if (pub?.track && track) {
      await pub.track.replaceTrack(track);
    } else if (pub?.track) {
      await room.localParticipant.unpublishTrack(pub.track, false);
      published = published.filter((p) => p !== pub);
    } else if (track) {
      published.push(await room.localParticipant.publishTrack(track));
    }
  }
}

/** Puts a video track into this device's own stream (the old video track is stopped). */
function setLocalVideo(track: MediaStreamTrack | null) {
  const { local } = useCallStore.getState();
  local?.getVideoTracks().forEach((t) => {
    if (t !== track) t.stop();
  });
  const audio = local?.getAudioTracks() ?? [];
  useCallStore.setState({ local: new MediaStream([...audio, ...(track ? [track] : [])]) });
}

/** Ring tones (generated; no sound files): ringing for incoming calls, ringback for the caller. */
const tones = (() => {
  let ctx: AudioContext | null = null;
  let timer: number | null = null;
  const tone = (freqs: number[], at: number, length: number, volume: number) => {
    if (!ctx) return;
    const start = ctx.currentTime + at;
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
      gain.gain.setValueAtTime(volume, start + length - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + length + 0.02);
    }
  };
  const patterns = {
    ring: {
      every: 1800,
      play: () => {
        tone([660], 0, 0.3, 0.2);
        tone([880], 0.18, 0.3, 0.2);
        navigator.vibrate?.([400, 200, 400]);
      },
    },
    // The caller hears the line ringing (the familiar two-tone ringback).
    ringback: { every: 3000, play: () => tone([440, 480], 0, 1.2, 0.05) },
  };
  return {
    start(kind: keyof typeof patterns) {
      this.stop();
      try {
        ctx ??= new AudioContext();
        void ctx.resume();
        patterns[kind].play();
        timer = window.setInterval(patterns[kind].play, patterns[kind].every);
      } catch {
        // No sound available.
      }
    },
    stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      navigator.vibrate?.(0);
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
    const mutedBy: Record<string, boolean> = {};
    let anyVideo = false;
    for (const p of r.remoteParticipants.values()) {
      const tracks: MediaStreamTrack[] = [];
      let videoOn = false;
      let audioOn = false;
      for (const pub of p.trackPublications.values()) {
        if (pub.track && !pub.isMuted) tracks.push(pub.track.mediaStreamTrack);
        if (pub.kind === lk.Track.Kind.Video && pub.track && !pub.isMuted) videoOn = true;
        if (pub.kind === lk.Track.Kind.Audio && !pub.isMuted) audioOn = true;
      }
      if (tracks.length) remotes[p.identity] = new MediaStream(tracks);
      cameraOffBy[p.identity] = !videoOn;
      mutedBy[p.identity] = !audioOn;
      anyVideo ||= videoOn;
    }
    const state = useCallStore.getState();
    useCallStore.setState({
      remotes,
      cameraOffBy,
      mutedBy,
      videoMode: state.videoMode || anyVideo,
      phase: 'active',
      connectedAt: state.connectedAt ?? Date.now(),
    });
  };
  r.on(lk.RoomEvent.TrackSubscribed, refresh)
    .on(lk.RoomEvent.TrackUnsubscribed, refresh)
    .on(lk.RoomEvent.TrackMuted, refresh)
    .on(lk.RoomEvent.TrackUnmuted, refresh)
    .on(lk.RoomEvent.ParticipantDisconnected, refresh)
    .on(lk.RoomEvent.Reconnecting, () => useCallStore.setState({ reconnecting: true }))
    .on(lk.RoomEvent.Reconnected, () => useCallStore.setState({ reconnecting: false }))
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
    void countCameras();
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
    keepAlive(call.id);
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
    tones.start('ringback');
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

/** Shows a call that is ringing for this person (live, or opened from a notification). */
function showIncoming(call: CallDto, ring = true) {
  useCallStore.setState({ ...initial, call, phase: 'incoming' });
  if (ring) tones.start('ring');
  // Group calls keep going; stop ringing here after a while.
  void callConfig().then(({ ringSeconds }) => {
    ringTimer = window.setTimeout(() => {
      if (useCallStore.getState().phase === 'incoming') cleanup();
    }, ringSeconds * 1000);
  });
}

async function acceptCall() {
  const { call } = useCallStore.getState();
  if (!call) return;
  tones.stop();
  if (ringTimer) window.clearTimeout(ringTimer);
  try {
    const local = await getMedia(call.media === 'video');
    useCallStore.setState({ local, phase: 'connecting', ownsCall: true });
    void countCameras();
    if (call.group) {
      const joined = await api<CallDto>(`/calls/${call.id}/join`, { method: 'POST' });
      useCallStore.setState({ call: joined });
      keepAlive(joined.id);
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
    keepAlive(call.id);
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
  announce();
}

/** Turns the camera on in a call that has none yet (voice call → video call). */
async function startCamera() {
  try {
    const track = await cameraTrack(useCallStore.getState().facing);
    setLocalVideo(track);
    await sendVideo(track);
    useCallStore.setState({ cameraOff: false, videoMode: true });
    announce();
    void countCameras();
  } catch (error) {
    notice(callError(error));
  }
}

function sendVideoAsk(action: 'request' | 'accept' | 'decline' | 'cancel') {
  const { call } = useCallStore.getState();
  if (call) for (const id of peers.keys()) send(call.id, id, { type: 'video', action });
}

function clearVideoAsk() {
  if (videoAskTimer) window.clearTimeout(videoAskTimer);
  videoAskTimer = null;
  useCallStore.setState({ videoAsk: null });
}

/**
 * One-to-one voice call: ask the other person to switch to video (they see Switch / Decline).
 * This device shows its own camera meanwhile, but sends it only once they agree.
 */
async function requestVideo() {
  const { facing } = useCallStore.getState();
  try {
    setLocalVideo(await cameraTrack(facing));
  } catch (error) {
    notice(callError(error));
    return;
  }
  useCallStore.setState({ videoAsk: 'sent', cameraOff: false });
  sendVideoAsk('request');
  void countCameras();
  videoAskTimer = window.setTimeout(() => {
    if (useCallStore.getState().videoAsk !== 'sent') return;
    sendVideoAsk('cancel');
    cancelVideoRequest('No answer to your video request.');
  }, 30_000);
}

/** Withdraws this device's request (or ends it after a decline): the camera goes off again. */
function cancelVideoRequest(message?: string) {
  clearVideoAsk();
  setLocalVideo(null);
  if (message) notice(message);
}

/** The other person agreed: now send the camera. */
async function videoAccepted() {
  const { local } = useCallStore.getState();
  clearVideoAsk();
  const track = local?.getVideoTracks()[0] ?? null;
  if (track) await sendVideo(track);
  useCallStore.setState({ videoMode: true });
  announce();
}

/** Switch: this device turns its camera on too. */
async function acceptVideo() {
  clearVideoAsk();
  sendVideoAsk('accept');
  useCallStore.setState({ videoMode: true });
  await startCamera();
}

function declineVideo() {
  clearVideoAsk();
  sendVideoAsk('decline');
}

function toggleCamera() {
  const { local, cameraOff, sharing, call, videoMode, videoAsk } = useCallStore.getState();
  if (sharing) return;
  if (videoAsk === 'sent') {
    sendVideoAsk('cancel');
    cancelVideoRequest();
    return;
  }
  if (!hasVideo(local)) {
    // Voice call between two people: ask first, like WhatsApp. Groups just turn it on.
    if (call && !call.group && call.media === 'audio' && !videoMode && peers.size > 0)
      void requestVideo();
    else void startCamera();
    return;
  }
  local?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
  for (const pub of published)
    if (pub.track?.mediaStreamTrack.kind === 'video') void (cameraOff ? pub.unmute() : pub.mute());
  useCallStore.setState({ cameraOff: !cameraOff });
  announce();
}

/** Front ↔ back camera on phones; the next camera on computers with several. */
async function switchCamera() {
  const { local, facing, cameraOff, sharing } = useCallStore.getState();
  const current = local?.getVideoTracks()[0];
  if (!current || sharing) return;
  const settings = current.getSettings();
  const next = facing === 'user' ? 'environment' : 'user';
  let deviceId: string | undefined;
  if (!settings.facingMode) {
    // No front/back information (computer webcams): take the next camera in the list.
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'videoinput',
    );
    const i = cams.findIndex((c) => c.deviceId === settings.deviceId);
    deviceId = cams[(i + 1) % cams.length]?.deviceId;
  }
  current.stop(); // phones cannot open two cameras at once
  try {
    const track = await cameraTrack(next, deviceId);
    track.enabled = !cameraOff;
    setLocalVideo(track);
    await sendVideo(track);
    useCallStore.setState({
      facing: track.getSettings().facingMode === 'environment' ? 'environment' : 'user',
    });
  } catch {
    notice('Could not switch the camera.');
    try {
      const track = await cameraTrack(facing, settings.deviceId);
      track.enabled = !cameraOff;
      setLocalVideo(track);
      await sendVideo(track);
    } catch {
      setLocalVideo(null);
      await sendVideo(null);
      announce();
    }
  }
}

const canShareScreen = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getDisplayMedia &&
  !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

async function toggleScreenShare() {
  const state = useCallStore.getState();
  if (state.sharing) {
    await stopSharing();
    return;
  }
  let screen: MediaStream;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return; // the person cancelled the picker
  }
  const track = screen.getVideoTracks()[0];
  if (!track) return;
  cameraBeforeShare = hasVideo(state.local) && !state.cameraOff;
  // "Stop sharing" in the browser's own bar.
  track.onended = () => void stopSharing();
  setLocalVideo(track);
  await sendVideo(track);
  useCallStore.setState({ sharing: true, videoMode: true });
  announce();
}

async function stopSharing() {
  const { sharing, facing } = useCallStore.getState();
  if (!sharing) return;
  useCallStore.setState({ sharing: false });
  if (cameraBeforeShare) {
    try {
      const track = await cameraTrack(facing);
      setLocalVideo(track);
      await sendVideo(track);
      useCallStore.setState({ cameraOff: false });
      announce();
      return;
    } catch {
      notice('The camera could not be turned back on.');
    }
  }
  setLocalVideo(null);
  await sendVideo(null);
  announce();
}

/** Opened from a "X is calling" notification: /chats?call=<id>[&answer=1]. */
async function openFromLink() {
  if (linkHandled) return;
  linkHandled = true;
  const params = new URLSearchParams(window.location.search);
  const id = params.get('call');
  if (!id) return;
  const answer = params.get('answer') === '1';
  params.delete('call');
  params.delete('answer');
  const query = params.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  );
  const state = useCallStore.getState();
  if (state.phase && state.phase !== 'ended') return;
  try {
    const call = await api<CallDto>(`/calls/${id}`);
    const ringing = call.group
      ? call.state !== 'ended' && !call.participants.some((p) => p.id === myUserId)
      : call.state === 'ringing' && call.callee.id === myUserId;
    if (!ringing) {
      toast(call.state === 'ended' ? 'This call has ended.' : 'This call was answered elsewhere.');
      return;
    }
    showIncoming(call, !answer);
    if (answer) await acceptCall();
  } catch {
    toast('This call has ended.');
  }
}

/** Listens for calls on the live connection and shows the call screen. Mount once. */
export function CallHost() {
  const socket = useSocket();
  const myId = useAuth((s) => s.me?.user.id);
  myUserId = myId ?? '';
  useEffect(() => {
    if (!socket || !myId) return;
    emitSignal = (payload) => socket.emit('call.signal', payload, () => undefined);
    const onIncoming = (call: CallDto) => {
      const state = useCallStore.getState();
      if (state.phase && state.phase !== 'ended') return; // busy on this device
      showIncoming(call);
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
          tones.stop();
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
        const peer = await peerFor(event.callId, from);
        const { pc } = peer;
        // Both sides changed something at once: the polite side gives way.
        const collision = peer.makingOffer || pc.signalingState !== 'stable';
        if (collision && !peer.polite) return;
        if (collision && pc.signalingState === 'have-local-offer')
          await pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await flushIce(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        peer.ready = true;
        send(event.callId, from, { type: 'answer', sdp: answer.sdp ?? '' });
      } else if (data.type === 'answer') {
        const peer = peers.get(from);
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await flushIce(peer);
        peer.ready = true;
      } else if (data.type === 'ice') {
        const candidate = {
          candidate: data.candidate.candidate,
          sdpMid: data.candidate.sdpMid ?? null,
          sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
        };
        const peer = peers.get(from);
        if (peer?.pc.remoteDescription)
          await peer.pc.addIceCandidate(candidate).catch(() => undefined);
        else if (peer) peer.pendingIce.push(candidate);
      } else if (data.type === 'video') {
        const now = useCallStore.getState();
        if (data.action === 'request') {
          if (now.videoMode) {
            // Already a video call here: just agree.
            sendVideoAsk('accept');
            return;
          }
          // Both asked at the same time: that is a yes from both.
          if (now.videoAsk === 'sent') {
            sendVideoAsk('accept');
            await videoAccepted();
            return;
          }
          useCallStore.setState({ videoAsk: 'received', minimized: false });
          navigator.vibrate?.([200, 100, 200]);
        } else if (data.action === 'cancel' && now.videoAsk === 'received') {
          clearVideoAsk();
        } else if (data.action === 'accept' && now.videoAsk === 'sent') {
          await videoAccepted();
        } else if (data.action === 'decline' && now.videoAsk === 'sent') {
          const name = now.call
            ? now.call.caller.id === myUserId
              ? now.call.callee.displayName
              : now.call.caller.displayName
            : 'They';
          cancelVideoRequest(`${name} declined the video call.`);
        }
      } else if (data.type === 'media') {
        const now = useCallStore.getState();
        useCallStore.setState({
          cameraOffBy: { ...now.cameraOffBy, [from]: !data.video },
          mutedBy: { ...now.mutedBy, [from]: !data.audio },
          videoMode: now.videoMode || data.video,
        });
      }
    };
    // Back on the network: find a new path for connections that dropped.
    const onOnline = () => {
      for (const peer of peers.values())
        if (peer.ready && peer.pc.connectionState !== 'connected') peer.pc.restartIce();
    };
    socket.on('call.incoming', onIncoming);
    socket.on('call.updated', (c) => void onUpdated(c));
    socket.on('call.signal', (e) => void onSignal(e));
    window.addEventListener('online', onOnline);
    const opening = new URLSearchParams(window.location.search).has('call');
    void openFromLink();
    if (!opening) void checkIncoming();
    const onConnect = () => void checkIncoming();
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off('call.incoming', onIncoming);
      socket.off('call.updated');
      socket.off('call.signal');
      window.removeEventListener('online', onOnline);
      emitSignal = null;
    };
  }, [socket, myId]);

  return <CallScreen myId={myId ?? ''} />;
}

function VideoView({
  stream,
  mirror,
  className,
}: {
  stream: MediaStream | null;
  mirror?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  // Sound plays through CallAudio (one place, chosen speaker); video elements stay silent.
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cx(className, mirror && '-scale-x-100')}
    />
  );
}

type SinkElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

function AudioOut({ stream, sinkId }: { stream: MediaStream; sinkId: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        useCallStore.setState({ soundBlocked: true });
    });
  }, [stream]);
  useEffect(() => {
    const el = ref.current as SinkElement | null;
    el?.setSinkId?.(sinkId).catch(() => undefined);
  }, [sinkId]);
  return <audio ref={ref} autoPlay />;
}

/** Everyone's sound, kept playing whether the call screen is full or shrunk. */
function CallAudio() {
  const remotes = useCallStore((s) => s.remotes);
  const sinkId = useCallStore((s) => s.sinkId);
  return (
    <>
      {Object.entries(remotes).map(([id, stream]) => (
        <AudioOut key={id} stream={stream} sinkId={sinkId} />
      ))}
    </>
  );
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
  small,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'neutral' | 'danger' | 'success' | 'active';
  small?: boolean;
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
        'inline-flex shrink-0 items-center justify-center rounded-full transition-colors',
        small ? 'size-10' : 'size-14 sm:size-16',
        tones[tone],
      )}
    >
      {children}
    </button>
  );
}

/** Speaker / headphones / Bluetooth choice, where the browser allows choosing. */
function SpeakerButton() {
  const sinkId = useCallStore((s) => s.sinkId);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!('setSinkId' in HTMLMediaElement.prototype) || !navigator.mediaDevices) return;
    const load = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((d) => setOutputs(d.filter((x) => x.kind === 'audiooutput')))
        .catch(() => undefined);
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);
  // Phones and Safari decide the speaker themselves; nothing to choose.
  if (outputs.length < 2) return null;
  return (
    <div className="relative">
      <RoundButton
        label="Speaker"
        tone={open ? 'active' : 'neutral'}
        onClick={() => setOpen(!open)}
      >
        <Volume2 className="size-6" aria-hidden />
      </RoundButton>
      {open && (
        <ul className="absolute bottom-full left-1/2 mb-3 w-64 -translate-x-1/2 overflow-hidden rounded-2xl bg-neutral-800 py-1 text-sm shadow-2xl">
          {outputs.map((o, i) => {
            const id = o.deviceId === 'default' ? '' : o.deviceId;
            return (
              <li key={o.deviceId || i}>
                <button
                  type="button"
                  className={cx(
                    'block w-full px-4 py-2.5 text-left hover:bg-white/10',
                    id === sinkId && 'font-semibold text-green-400',
                  )}
                  onClick={() => {
                    useCallStore.setState({ sinkId: id });
                    setOpen(false);
                  }}
                >
                  {o.label || (o.deviceId === 'default' ? 'Default speaker' : `Speaker ${i + 1}`)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Group calls: ring people from the group who are not in the call. */
function AddPeople({ call, onClose }: { call: CallDto; onClose: () => void }) {
  const inCall = new Set(call.participants.map((p) => p.id));
  const notIn = call.members.filter((m) => !inCall.has(m.id));
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ring = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/calls/${call.id}/ring`, { method: 'POST', body: { userIds: picked } });
      notice(picked.length === 1 ? 'Ringing…' : `Ringing ${picked.length} people…`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 max-h-[75%] overflow-y-auto rounded-t-3xl bg-neutral-900 p-4 shadow-2xl">
      <div className="mb-3 flex items-center gap-2">
        <p className="flex-1 font-semibold">Add people</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-full p-1.5 hover:bg-white/10"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      {notIn.length === 0 ? (
        <p className="py-6 text-center text-white/70">Everyone in the group is in the call.</p>
      ) : (
        <ul className="space-y-1">
          {notIn.map((m) => (
            <li key={m.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/5">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={picked.includes(m.id)}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id),
                    )
                  }
                />
                <Avatar name={m.displayName} size={36} />
                <span className="flex-1 truncate">{m.displayName}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {notIn.length > 0 && (
        <button
          type="button"
          disabled={picked.length === 0 || busy}
          onClick={() => void ring()}
          className="mt-4 w-full rounded-full bg-green-600 py-3 font-semibold hover:bg-green-700 disabled:opacity-50"
        >
          {busy ? 'Ringing…' : picked.length > 1 ? `Ring ${picked.length} people` : 'Ring'}
        </button>
      )}
    </div>
  );
}

/** One person in a group call: their video, or their picture when the camera is off. */
function Tile({
  user,
  stream,
  showVideo,
  muted,
}: {
  user: PublicUserDto;
  stream: MediaStream | null;
  showVideo: boolean;
  muted: boolean;
}) {
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-neutral-800">
      {showVideo ? (
        <VideoView stream={stream} className="h-full w-full object-cover" />
      ) : (
        <Avatar name={user.displayName} size={72} />
      )}
      <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/50 px-2.5 py-0.5 text-sm">
        {muted && <MicOff className="size-3.5" aria-label="Muted" />}
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
  const [adding, setAdding] = useState(false);
  const live = s.phase === 'active' || s.phase === 'connecting';
  useEffect(() => {
    void keepAwake(live);
  }, [live]);
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
  const video = call.media === 'video' || s.videoMode;
  const cameraOn = (hasVideo(s.local) && !s.cameraOff) || s.sharing;
  const inCall = s.phase !== 'incoming' && s.phase !== 'ended';
  const peerUser = call.group
    ? { ...call.caller, displayName: call.title ?? 'Group call' }
    : call.caller.id === myId
      ? call.callee
      : call.caller;
  const remote = s.remotes[peerUser.id] ?? Object.values(s.remotes)[0] ?? null;
  const remoteVideo = hasVideo(remote) && !s.cameraOffBy[peerUser.id];
  const status =
    s.phase === 'incoming'
      ? call.group
        ? `${call.caller.displayName} started a ${call.media === 'video' ? 'video' : 'voice'} call`
        : `Incoming ${call.media === 'video' ? 'video' : 'voice'} call`
      : s.phase === 'outgoing'
        ? 'Calling…'
        : s.phase === 'connecting'
          ? 'Connecting…'
          : s.phase === 'ended'
            ? (s.message ?? 'Call ended')
            : s.reconnecting
              ? 'Reconnecting…'
              : s.videoAsk === 'sent'
                ? `Asking ${peerUser.displayName} to switch to video…`
                : null;

  const audio = inCall ? <CallAudio /> : null;
  const soundBlocked = s.soundBlocked && (
    <button
      type="button"
      onClick={() => {
        document.querySelectorAll('audio').forEach((a) => void a.play().catch(() => undefined));
        useCallStore.setState({ soundBlocked: false });
      }}
      className="fixed inset-x-0 top-4 z-[90] mx-auto w-max rounded-full bg-amber-500 px-5 py-2 font-semibold text-neutral-950 shadow-xl"
    >
      Tap to turn on the call sound
    </button>
  );
  const noticeBar = s.notice && (
    <p
      role="status"
      className="absolute inset-x-0 top-16 z-30 mx-auto w-max max-w-[calc(100%-2rem)] rounded-2xl bg-black/70 px-4 py-2 text-center text-sm"
    >
      {s.notice}
    </p>
  );

  // Shrunk: a small floating window; the app stays usable underneath.
  if (s.minimized && inCall) {
    const showRemote = video && (call.group ? false : remoteVideo);
    return (
      <>
        {audio}
        {soundBlocked}
        <div
          role="region"
          aria-label="Call in progress"
          className="fixed right-4 bottom-4 z-[80] w-72 max-w-[calc(100%-2rem)] overflow-hidden rounded-2xl bg-neutral-900 text-white shadow-2xl"
        >
          {showRemote && (
            <button
              type="button"
              className="block w-full"
              onClick={() => useCallStore.setState({ minimized: false })}
              aria-label="Back to the call"
            >
              <VideoView stream={remote} className="aspect-video w-full object-cover" />
            </button>
          )}
          <div className="flex items-center gap-2 p-3">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => useCallStore.setState({ minimized: false })}
            >
              <p className="truncate font-semibold">{peerUser.displayName}</p>
              <p className="text-xs text-white/70">
                {status ?? (s.connectedAt ? <Elapsed since={s.connectedAt} /> : null)}
              </p>
            </button>
            <RoundButton
              small
              label={s.muted ? 'Unmute' : 'Mute'}
              tone={s.muted ? 'active' : 'neutral'}
              onClick={toggleMute}
            >
              {s.muted ? (
                <MicOff className="size-5" aria-hidden />
              ) : (
                <Mic className="size-5" aria-hidden />
              )}
            </RoundButton>
            <RoundButton
              small
              label="Back to the call"
              onClick={() => useCallStore.setState({ minimized: false })}
            >
              <Maximize2 className="size-5" aria-hidden />
            </RoundButton>
            <RoundButton small label="Hang up" tone="danger" onClick={() => void hangUp()}>
              <PhoneOff className="size-5" aria-hidden />
            </RoundButton>
          </div>
        </div>
      </>
    );
  }

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
          {call.media === 'video' ? (
            <Video className="size-7" aria-hidden />
          ) : (
            <Phone className="size-7" aria-hidden />
          )}
        </RoundButton>
      </>
    ) : s.phase === 'ended' ? null : (
      <>
        <SpeakerButton />
        {cameraOn && !s.sharing && s.cameras > 1 && (
          <RoundButton label="Switch camera" onClick={() => void switchCamera()}>
            <SwitchCamera className="size-6" aria-hidden />
          </RoundButton>
        )}
        <RoundButton
          label={
            s.videoAsk === 'sent'
              ? 'Cancel the video request'
              : cameraOn
                ? 'Turn camera off'
                : video
                  ? 'Turn camera on'
                  : 'Switch to video call'
          }
          tone={(video && !cameraOn) || s.videoAsk === 'sent' ? 'active' : 'neutral'}
          onClick={toggleCamera}
        >
          {cameraOn || !video ? (
            <Video className="size-6" aria-hidden />
          ) : (
            <VideoOff className="size-6" aria-hidden />
          )}
        </RoundButton>
        <RoundButton
          label={s.muted ? 'Unmute' : 'Mute'}
          tone={s.muted ? 'active' : 'neutral'}
          onClick={toggleMute}
        >
          {s.muted ? (
            <MicOff className="size-6" aria-hidden />
          ) : (
            <Mic className="size-6" aria-hidden />
          )}
        </RoundButton>
        {canShareScreen() && s.phase === 'active' && (
          <RoundButton
            label={s.sharing ? 'Stop sharing your screen' : 'Share your screen'}
            tone={s.sharing ? 'active' : 'neutral'}
            onClick={() => void toggleScreenShare()}
          >
            {s.sharing ? (
              <ScreenShareOff className="size-6" aria-hidden />
            ) : (
              <MonitorUp className="size-6" aria-hidden />
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

  const minimizeButton = inCall && (
    <button
      type="button"
      onClick={() => {
        setAdding(false);
        useCallStore.setState({ minimized: true });
      }}
      aria-label="Shrink the call"
      title="Shrink the call (keep using the app)"
      className="rounded-full p-2 hover:bg-white/10"
    >
      <Minimize2 className="size-5" aria-hidden />
    </button>
  );
  const selfView = (video || s.videoAsk === 'sent') && s.local && cameraOn && inCall && (
    <VideoView
      stream={s.local}
      mirror={s.facing === 'user' && !s.sharing}
      className="absolute right-4 bottom-32 z-20 h-40 w-28 rounded-2xl border-2 border-white/40 bg-neutral-800 object-cover shadow-xl sm:h-48 sm:w-36"
    />
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
        {audio}
        {soundBlocked}
        <header className="flex items-center gap-2 px-4 py-3">
          {minimizeButton}
          <Users className="size-5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 truncate font-semibold">{call.title ?? 'Group call'}</p>
          <p className="text-sm text-white/70">
            {s.reconnecting ? (
              'Reconnecting…'
            ) : (
              <>
                {call.participants.length} in the call
                {s.connectedAt && (
                  <>
                    {' '}
                    · <Elapsed since={s.connectedAt} />
                  </>
                )}
              </>
            )}
          </p>
          {inCall && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              aria-label="Add people"
              title="Add people"
              className="rounded-full p-2 hover:bg-white/10"
            >
              <UserPlus className="size-5" aria-hidden />
            </button>
          )}
        </header>
        {noticeBar}
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
          {others.map((p) => {
            const stream = s.remotes[p.id] ?? null;
            return (
              <Tile
                key={p.id}
                user={p}
                stream={stream}
                showVideo={video && hasVideo(stream) && !s.cameraOffBy[p.id]}
                muted={!!s.mutedBy[p.id]}
              />
            );
          })}
        </div>
        {selfView}
        <div className="relative z-20 flex flex-wrap items-center justify-center gap-3 px-4 pb-8 sm:gap-5">
          {controls}
        </div>
        {adding && <AddPeople call={call} onClose={() => setAdding(false)} />}
      </div>
    );
  }

  const showRemoteVideo = video && s.phase === 'active' && remoteVideo;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${peerUser.displayName}`}
      className="fixed inset-0 z-[80] flex flex-col bg-neutral-950 text-white"
    >
      {audio}
      {soundBlocked}
      {showRemoteVideo && (
        <VideoView stream={remote} className="absolute inset-0 h-full w-full object-cover" />
      )}
      <div className="relative z-10 flex items-center px-3 pt-3">{minimizeButton}</div>
      {noticeBar}
      {s.videoAsk === 'received' && (
        <div
          role="alertdialog"
          aria-label="Video call request"
          className="absolute inset-x-4 top-20 z-30 mx-auto max-w-sm rounded-3xl bg-neutral-800 p-5 text-center shadow-2xl"
        >
          <Video className="mx-auto size-8 text-green-400" aria-hidden />
          <p className="mt-2 font-semibold">
            {peerUser.displayName} wants to switch to a video call
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={declineVideo}
              className="min-h-11 flex-1 rounded-full bg-white/15 px-4 font-semibold hover:bg-white/25"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => void acceptVideo()}
              className="min-h-11 flex-1 rounded-full bg-green-600 px-4 font-semibold hover:bg-green-700"
            >
              Switch
            </button>
          </div>
        </div>
      )}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        {!showRemoteVideo && (
          <>
            <Avatar name={peerUser.displayName} size={120} />
            <p className="text-2xl font-semibold">{peerUser.displayName}</p>
            <p className="text-white/70">
              {status ?? (s.connectedAt ? <Elapsed since={s.connectedAt} /> : null)}
            </p>
            {inCall && s.mutedBy[peerUser.id] && (
              <p className="flex items-center gap-1.5 text-sm text-white/70">
                <MicOff className="size-4" aria-hidden /> {peerUser.displayName} is muted
              </p>
            )}
          </>
        )}
        {showRemoteVideo && (
          <p className="absolute top-3 flex items-center gap-1.5 rounded-full bg-black/40 px-4 py-1 text-sm">
            {s.mutedBy[peerUser.id] && <MicOff className="size-3.5" aria-label="Muted" />}
            {peerUser.displayName} ·{' '}
            {status ?? (s.connectedAt && <Elapsed since={s.connectedAt} />)}
          </p>
        )}
      </div>
      {selfView}
      <div className="relative z-20 flex flex-wrap items-center justify-center gap-3 px-4 pb-10 sm:gap-5">
        {controls}
      </div>
    </div>
  );
}
