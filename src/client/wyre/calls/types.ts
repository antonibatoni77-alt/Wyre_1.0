export type CallQuality = "good" | "ok" | "poor" | "lost";

export interface CallParticipant {
  userId: string;
  state: "invited" | "joined" | "left" | "declined";
  name: string;
  username: string;
  initials: string;
  colors: [string, string];
  badge?: "dev" | "official";
  warnings: { reason: string; date: string }[];
}

/** Shape returned by the live `wyre.callState` query. */
export interface CallState {
  callId: string;
  chatId: string;
  kind: "audio" | "video";
  status: "ringing" | "active" | "ended";
  group: boolean;
  title: string;
  initials: string;
  colors: [string, string];
  badge?: "dev" | "official";
  warnings: { reason: string; date: string }[];
  initiatorId: string;
  initiatorName: string;
  isInitiator: boolean;
  myState: "invited" | "joined" | "left" | "declined";
  /** False on devices of the same account that did not accept the call. */
  joinedByThisDevice?: boolean;
  startedAt: string | null;
  participants: CallParticipant[];
  /** Peers that are joined right now and need a peer connection. */
  peers: string[];
  remoteControlCode: string;
  remoteControl: {
    sessionId: string;
    status: "pending" | "active" | "declined" | "ended";
    controllerId: string;
    targetId: string;
    isController: boolean;
    isTarget: boolean;
    controllerName: string;
    targetName: string;
  } | null;
}

export interface RemoteControlEvent {
  id: string;
  type: "pointer_move" | "pointer_down" | "pointer_up" | "key_down";
  x: number | null;
  y: number | null;
  button: number | null;
  key: string | null;
}

export interface RemotePeer {
  userId: string;
  stream: MediaStream | null;
  /** False while the peer's video sender is inactive (camera off / degraded). */
  videoActive: boolean;
  quality: CallQuality;
  connection: RTCPeerConnectionState;
  /** Round-trip time in ms, from the nominated ICE candidate pair. */
  rtt: number | null;
  /** Fraction 0..1 of inbound packets lost over the last sample window. */
  loss: number;
  reconnecting: boolean;
}

export interface CallSignal {
  id: string;
  from: string;
  type: "offer" | "answer" | "ice";
  payload: string;
}
