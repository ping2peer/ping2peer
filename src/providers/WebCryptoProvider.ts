import { bytesToBase64Url, base64UrlToBytes, createId } from "../lib/encoding";
import type { ChatKey, CryptoProvider, DeviceProfile, FallbackChatKey } from "../types";

const identityAlgorithm: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const aesAlgorithm = { name: "AES-GCM", length: 256 };

export class WebCryptoProvider implements CryptoProvider {
  async createProfile(displayName: string, deviceName: string): Promise<DeviceProfile> {
    if (!crypto.subtle) {
      const key = randomKeyMaterial();
      return {
        peerId: createId("peer"),
        displayName,
        deviceName,
        publicIdentityKey: { kty: "oct", k: key, alg: "PING2PEER-DEV" },
        privateIdentityKey: { kty: "oct", k: key, alg: "PING2PEER-DEV" },
        createdAt: Date.now()
      };
    }

    const keyPair = await crypto.subtle.generateKey(identityAlgorithm, true, ["deriveBits"]);
    const [publicIdentityKey, privateIdentityKey] = await Promise.all([
      crypto.subtle.exportKey("jwk", keyPair.publicKey),
      crypto.subtle.exportKey("jwk", keyPair.privateKey)
    ]);

    return {
      peerId: createId("peer"),
      displayName,
      deviceName,
      publicIdentityKey,
      privateIdentityKey,
      createdAt: Date.now()
    };
  }

  async importIdentity(profile: DeviceProfile): Promise<CryptoKeyPair> {
    const [publicKey, privateKey] = await Promise.all([
      crypto.subtle.importKey("jwk", profile.publicIdentityKey, identityAlgorithm, true, []),
      crypto.subtle.importKey("jwk", profile.privateIdentityKey, identityAlgorithm, true, ["deriveBits"])
    ]);

    return { publicKey, privateKey };
  }

  async deriveChatKey(privateKeyJwk: JsonWebKey, peerPublicKeyJwk: JsonWebKey): Promise<ChatKey> {
    if (!crypto.subtle || privateKeyJwk.kty === "oct" || peerPublicKeyJwk.kty === "oct") {
      const pairMaterial = [String(privateKeyJwk.k ?? ""), String(peerPublicKeyJwk.k ?? "")].sort().join(":");
      return {
        kind: "fallback",
        keyMaterial: hashString(pairMaterial)
      };
    }

    const [privateKey, peerPublicKey] = await Promise.all([
      crypto.subtle.importKey("jwk", privateKeyJwk, identityAlgorithm, false, ["deriveBits"]),
      crypto.subtle.importKey("jwk", peerPublicKeyJwk, identityAlgorithm, false, [])
    ]);
    const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256);
    const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);

    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("ping2peer-v1"),
        info: new TextEncoder().encode("chat-message-key")
      },
      hkdfKey,
      aesAlgorithm,
      false,
      ["encrypt", "decrypt"]
    );
  }

  async encryptText(key: ChatKey, text: string): Promise<{ ciphertext: string; nonce: string }> {
    if (isFallbackKey(key)) {
      const nonce = randomKeyMaterial();
      return {
        ciphertext: bytesToBase64Url(xorBytes(new TextEncoder().encode(text), `${key.keyMaterial}:${nonce}`)),
        nonce
      };
    }

    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(nonce) }, key, new TextEncoder().encode(text));
    return {
      ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
      nonce: bytesToBase64Url(nonce)
    };
  }

  async decryptText(key: ChatKey, ciphertext: string, nonce: string): Promise<string> {
    if (isFallbackKey(key)) {
      return new TextDecoder().decode(xorBytes(base64UrlToBytes(ciphertext), `${key.keyMaterial}:${nonce}`));
    }

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64UrlToBytes(nonce)) },
      key,
      toArrayBuffer(base64UrlToBytes(ciphertext))
    );
    return new TextDecoder().decode(decrypted);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isFallbackKey(key: ChatKey): key is FallbackChatKey {
  return "kind" in key && key.kind === "fallback";
}

function randomKeyMaterial(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function xorBytes(bytes: Uint8Array, seed: string): Uint8Array {
  const output = new Uint8Array(bytes.length);
  let state = hashNumber(seed);
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = bytes[index] ^ (state & 0xff);
  }
  return output;
}

function hashString(value: string): string {
  const bytes = new Uint8Array(16);
  let state = hashNumber(value);
  for (let index = 0; index < bytes.length; index += 1) {
    state = Math.imul(state ^ index, 16777619);
    bytes[index] = state & 0xff;
  }
  return bytesToBase64Url(bytes);
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
