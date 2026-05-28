import { describe, expect, it } from "vitest";
import { WebCryptoProvider } from "../src/providers/WebCryptoProvider";

describe("WebCryptoProvider", () => {
  it("derives matching keys and decrypts encrypted text", async () => {
    const provider = new WebCryptoProvider();
    const alice = await provider.createProfile("Alice", "Phone");
    const bob = await provider.createProfile("Bob", "Phone");

    const aliceKey = await provider.deriveChatKey(alice.privateIdentityKey, bob.publicIdentityKey);
    const bobKey = await provider.deriveChatKey(bob.privateIdentityKey, alice.publicIdentityKey);
    const encrypted = await provider.encryptText(aliceKey, "hello peer");

    await expect(provider.decryptText(bobKey, encrypted.ciphertext, encrypted.nonce)).resolves.toBe("hello peer");
  });

  it("fails when decrypting with the wrong peer key", async () => {
    const provider = new WebCryptoProvider();
    const alice = await provider.createProfile("Alice", "Phone");
    const bob = await provider.createProfile("Bob", "Phone");
    const mallory = await provider.createProfile("Mallory", "Laptop");

    const aliceKey = await provider.deriveChatKey(alice.privateIdentityKey, bob.publicIdentityKey);
    const wrongKey = await provider.deriveChatKey(mallory.privateIdentityKey, alice.publicIdentityKey);
    const encrypted = await provider.encryptText(aliceKey, "private");

    await expect(provider.decryptText(wrongKey, encrypted.ciphertext, encrypted.nonce)).rejects.toThrow();
  });
});
