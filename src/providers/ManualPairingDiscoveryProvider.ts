import { base64UrlToJson, jsonToBase64Url } from "../lib/encoding";
import type { DiscoveryProvider, PairingPayload } from "../types";

const prefix = "p2p1:";

export class ManualPairingDiscoveryProvider implements DiscoveryProvider {
  encodePayload(payload: PairingPayload): string {
    return `${prefix}${jsonToBase64Url(payload)}`;
  }

  decodePayload(text: string): PairingPayload {
    const trimmed = text.trim();
    const encoded = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
    const payload = base64UrlToJson<PairingPayload>(encoded);

    if (payload.version !== 1 || !payload.peer?.peerId || !payload.signal?.type) {
      throw new Error("This pairing code is not a valid Ping2Peer v1 payload.");
    }

    return payload;
  }
}
