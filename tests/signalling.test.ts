import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WebSocketSignallingProvider } from "../src/providers/SignallingDiscoveryProvider";
import type { DeviceProfile } from "../src/types";
import { WS } from "jest-websocket-mock";

const mockProfile: DeviceProfile = {
  peerId: "mock-peer-1",
  displayName: "Alice",
  deviceName: "Alice's Phone",
  publicIdentityKey: { kty: "oct", k: "mock-key", alg: "PING2PEER-DEV" },
  privateIdentityKey: { kty: "oct", k: "mock-key", alg: "PING2PEER-DEV" },
  createdAt: Date.now()
};

describe("SignallingDiscoveryProvider", () => {
  let provider: WebSocketSignallingProvider;
  let server: WS;

  beforeEach(async () => {
    provider = new WebSocketSignallingProvider();
    server = new WS("ws://localhost:8080");
  });

  afterEach(() => {
    provider.disconnect();
    WS.clean();
  });

  it("connects and registers with the server", async () => {
    provider.connect("ws://localhost:8080", mockProfile);
    
    await server.connected;
    expect(provider.connectionState).toBe("connected");
    
    await expect(server).toReceiveMessage(
      JSON.stringify({
        type: "register",
        peerId: mockProfile.peerId,
        displayName: mockProfile.displayName,
        deviceName: mockProfile.deviceName
      })
    );
  });

  it("handles incoming peer discovery messages", async () => {
    provider.connect("ws://localhost:8080", mockProfile);
    await server.connected;
    
    const peersChanged = vi.fn();
    provider.onPeersChanged(peersChanged);

    const mockPeer = { peerId: "peer-2", displayName: "Bob", deviceName: "Bob's Mac" };
    
    server.send(JSON.stringify({ type: "peer-joined", peer: mockPeer }));
    expect(peersChanged).toHaveBeenCalledWith([mockPeer]);
    expect(provider.peers).toEqual([mockPeer]);

    server.send(JSON.stringify({ type: "peer-left", peerId: "peer-2" }));
    expect(peersChanged).toHaveBeenCalledWith([]);
    expect(provider.peers).toEqual([]);
  });

  it("routes connection requests", async () => {
    provider.connect("ws://localhost:8080", mockProfile);
    await server.connected;
    await server.nextMessage; // consume register
    
    provider.requestConnection("peer-2");
    await expect(server).toReceiveMessage(
      JSON.stringify({ type: "connect-request", to: "peer-2" })
    );

    const onRequest = vi.fn();
    provider.onConnectionRequest(onRequest);
    
    server.send(JSON.stringify({ 
      type: "connect-request", 
      from: { peerId: "peer-2", displayName: "Bob", deviceName: "Bob's Mac" } 
    }));
    
    expect(onRequest).toHaveBeenCalled();
    expect(onRequest.mock.calls[0][0].from.peerId).toBe("peer-2");
  });

  it("routes WebRTC signals", async () => {
    provider.connect("ws://localhost:8080", mockProfile);
    await server.connected;
    await server.nextMessage; // consume register
    
    const mockOffer = { type: "offer", sdp: "mock-sdp" } as RTCSessionDescriptionInit;
    provider.sendOffer("peer-2", mockOffer);
    
    await expect(server).toReceiveMessage(
      JSON.stringify({ type: "webrtc-offer", to: "peer-2", signal: mockOffer })
    );
    
    const onOffer = vi.fn();
    provider.onWebRtcOffer(onOffer);
    
    server.send(JSON.stringify({ 
      type: "webrtc-offer", 
      from: "peer-2",
      signal: mockOffer
    }));
    
    expect(onOffer).toHaveBeenCalledWith("peer-2", mockOffer);
  });
});
