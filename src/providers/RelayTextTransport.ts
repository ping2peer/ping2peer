import { createId } from "../lib/encoding";
import type { ChatEnvelope, DeviceProfile, PairingPayload, PeerTransport, TransportState } from "../types";

type MessageHandler = (envelope: ChatEnvelope) => void;
type StateHandler = (state: TransportState) => void;

export class RelayTextTransport implements PeerTransport {
  private socket?: WebSocket;
  private sessionId = createId("session");
  private messageHandlers = new Set<MessageHandler>();
  private stateHandlers = new Set<StateHandler>();
  private currentState: TransportState = "idle";

  get state(): TransportState {
    return this.currentState;
  }

  async createInvite(profile: DeviceProfile): Promise<PairingPayload> {
    this.sessionId = createId("session");
    await this.connect();
    return this.createPayload("invite", profile);
  }

  async acceptInvite(profile: DeviceProfile, invite: PairingPayload): Promise<PairingPayload> {
    this.sessionId = parseRelaySession(invite);
    await this.connect();
    return this.createPayload("answer", profile);
  }

  async applyAnswer(answer: PairingPayload): Promise<void> {
    this.sessionId = parseRelaySession(answer);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
  }

  send(envelope: ChatEnvelope): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Relay connection is not open.");
    }
    this.socket.send(JSON.stringify(envelope));
  }

  disconnect(): void {
    this.socket?.close();
    this.setState("closed");
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.currentState);
    return () => this.stateHandlers.delete(handler);
  }

  private connect(): Promise<void> {
    this.socket?.close();
    this.setState("connecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${scheme}://${window.location.host}/ping2peer-relay?session=${encodeURIComponent(this.sessionId)}`);

    return new Promise((resolve, reject) => {
      const socket = this.socket!;
      socket.onopen = () => {
        this.setState("connected");
        resolve();
      };
      socket.onerror = () => {
        this.setState("failed");
        reject(new Error("Could not connect to the local relay."));
      };
      socket.onclose = () => this.setState("closed");
      socket.onmessage = (event) => {
        const envelope = JSON.parse(String(event.data)) as ChatEnvelope;
        this.messageHandlers.forEach((handler) => handler(envelope));
      };
    });
  }

  private createPayload(role: PairingPayload["role"], profile: DeviceProfile): PairingPayload {
    return {
      version: 1,
      role,
      sessionId: this.sessionId,
      peer: {
        peerId: profile.peerId,
        displayName: profile.displayName,
        deviceName: profile.deviceName,
        publicIdentityKey: profile.publicIdentityKey
      },
      signal: { type: role === "invite" ? "offer" : "answer", sdp: `relay:${this.sessionId}` },
      capabilities: {
        text: true,
        appEncryption: "ecdh-p256-aes-gcm",
        discovery: "manual"
      }
    };
  }

  private setState(state: TransportState): void {
    this.currentState = state;
    this.stateHandlers.forEach((handler) => handler(state));
  }
}

function parseRelaySession(payload: PairingPayload): string {
  if (payload.signal.sdp?.startsWith("relay:")) {
    return payload.signal.sdp.slice("relay:".length);
  }
  return payload.sessionId;
}
