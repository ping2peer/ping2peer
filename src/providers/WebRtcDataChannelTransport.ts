import { createId } from "../lib/encoding";
import type {
  ChatEnvelope,
  DeviceProfile,
  PairingPayload,
  PeerTransport,
  SignallingProvider,
  TransportState
} from "../types";

type MessageHandler = (envelope: ChatEnvelope) => void;
type StateHandler = (state: TransportState) => void;

const rtcConfig: RTCConfiguration = {
  iceServers: []
};

export class WebRtcDataChannelTransport implements PeerTransport {
  private connection?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private messageHandlers = new Set<MessageHandler>();
  private stateHandlers = new Set<StateHandler>();
  private sessionId = createId("session");
  private currentState: TransportState = "idle";
  private heartbeatInterval?: number;

  get state(): TransportState {
    return this.currentState;
  }

  async createInvite(profile: DeviceProfile): Promise<PairingPayload> {
    this.reset();
    this.connection = this.createConnection();
    this.channel = this.connection.createDataChannel("ping2peer-text", { ordered: true });
    this.bindChannel(this.channel);
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    return this.createPayload("invite", profile, this.connection.localDescription!);
  }

  async acceptInvite(profile: DeviceProfile, invite: PairingPayload): Promise<PairingPayload> {
    this.reset(invite.sessionId);
    this.connection = this.createConnection();
    this.connection.ondatachannel = (event) => {
      this.channel = event.channel;
      this.bindChannel(event.channel);
    };
    await this.connection.setRemoteDescription(invite.signal);
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    return this.createPayload("answer", profile, this.connection.localDescription!);
  }

  async applyAnswer(answer: PairingPayload): Promise<void> {
    if (!this.connection) {
      throw new Error("Create an invite before applying an answer.");
    }
    await this.connection.setRemoteDescription(answer.signal);
  }

  async connectViaSignalling(
    profile: DeviceProfile,
    targetPeerId: string,
    signallingProvider: SignallingProvider
  ): Promise<JsonWebKey> {
    this.reset();
    this.connection = this.createConnection();
    this.channel = this.connection.createDataChannel("ping2peer-text", { ordered: true });
    this.bindChannel(this.channel);
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    const signalWithKey = {
      type: this.connection.localDescription!.type,
      sdp: this.connection.localDescription!.sdp,
      publicIdentityKey: profile.publicIdentityKey
    };

    signallingProvider.sendOffer(targetPeerId, signalWithKey as any);

    return new Promise((resolve, reject) => {
      const off = signallingProvider.onWebRtcAnswer((fromPeerId, signal) => {
        if (fromPeerId === targetPeerId) {
          off();
          this.connection!.setRemoteDescription(signal)
            .then(() => {
              const remoteKey = (signal as any).publicIdentityKey;
              if (!remoteKey) {
                reject(new Error("Remote peer did not send public identity key"));
              } else {
                resolve(remoteKey);
              }
            })
            .catch(reject);
        }
      });
      // Set a timeout to prevent hanging forever if peer disconnects
      setTimeout(() => {
        off();
        reject(new Error("Timeout waiting for WebRTC answer"));
      }, 15000);
    });
  }

  async acceptViaSignalling(
    profile: DeviceProfile,
    targetPeerId: string,
    offerSignal: RTCSessionDescriptionInit,
    signallingProvider: SignallingProvider
  ): Promise<JsonWebKey> {
    this.reset();
    this.connection = this.createConnection();
    this.connection.ondatachannel = (event) => {
      this.channel = event.channel;
      this.bindChannel(event.channel);
    };

    const remoteKey = (offerSignal as any).publicIdentityKey;
    if (!remoteKey) {
      throw new Error("Offer signal is missing public identity key");
    }

    await this.connection.setRemoteDescription(offerSignal);
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    const signalWithKey = {
      type: this.connection.localDescription!.type,
      sdp: this.connection.localDescription!.sdp,
      publicIdentityKey: profile.publicIdentityKey
    };

    signallingProvider.sendAnswer(targetPeerId, signalWithKey as any);

    return remoteKey;
  }

  send(envelope: ChatEnvelope): void {
    if (this.channel?.readyState !== "open") {
      throw new Error("Peer connection is not open.");
    }
    this.channel.send(JSON.stringify(envelope));
  }

  disconnect(): void {
    this.reset();
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

  private createConnection(): RTCPeerConnection {
    const connection = new RTCPeerConnection(rtcConfig);
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected") this.setState("connected");
      if (connection.connectionState === "failed" || connection.connectionState === "disconnected") this.setState("failed");
      if (connection.connectionState === "closed") this.setState("closed");
    };
    return connection;
  }

  private bindChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      this.setState("connected");
      this.send({ type: "peer-ready", peerId: "remote" });
      this.startHeartbeat();
    };
    channel.onclose = () => {
      this.stopHeartbeat();
      this.setState("closed");
    };
    channel.onerror = () => {
      this.stopHeartbeat();
      this.setState("failed");
    };
    channel.onmessage = (event) => {
      const envelope = JSON.parse(String(event.data)) as ChatEnvelope;
      if (envelope.type === "ping") {
        this.send({ type: "pong" });
        return;
      }
      if (envelope.type === "pong") {
        return;
      }
      this.messageHandlers.forEach((handler) => handler(envelope));
    };
  }

  private createPayload(role: PairingPayload["role"], profile: DeviceProfile, signal: RTCSessionDescription): PairingPayload {
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
      signal: signal.toJSON(),
      capabilities: {
        text: true,
        appEncryption: "ecdh-p256-aes-gcm",
        discovery: "manual"
      }
    };
  }

  private async waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
    if (connection.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 3000);
      connection.addEventListener("icegatheringstatechange", () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  private reset(sessionId = createId("session")): void {
    this.stopHeartbeat();
    this.channel?.close();
    this.connection?.close();
    this.channel = undefined;
    this.connection = undefined;
    this.sessionId = sessionId;
    this.currentState = "idle";
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = window.setInterval(() => {
      if (this.channel?.readyState === "open") {
        try {
          this.send({ type: "ping" });
        } catch (err) {
          console.warn("[WebRTC] Failed to send heartbeat ping:", err);
        }
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      window.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private setState(state: TransportState): void {
    this.currentState = state;
    this.stateHandlers.forEach((handler) => handler(state));
  }
}
