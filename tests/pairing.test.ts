import { describe, expect, it } from "vitest";
import { ManualPairingDiscoveryProvider } from "../src/providers/ManualPairingDiscoveryProvider";
import type { PairingPayload } from "../src/types";

describe("ManualPairingDiscoveryProvider", () => {
  it("round-trips versioned pairing payloads", () => {
    const provider = new ManualPairingDiscoveryProvider();
    const payload: PairingPayload = {
      version: 1,
      role: "invite",
      sessionId: "session_1",
      peer: {
        peerId: "peer_1",
        displayName: "Alice",
        deviceName: "Phone",
        publicIdentityKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }
      },
      signal: { type: "offer", sdp: "v=0" },
      capabilities: {
        text: true,
        appEncryption: "ecdh-p256-aes-gcm",
        discovery: "manual"
      }
    };

    const encoded = provider.encodePayload(payload);
    expect(encoded.startsWith("p2p1:")).toBe(true);
    expect(provider.decodePayload(encoded)).toEqual(payload);
  });
});
