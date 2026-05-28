import { beforeEach, describe, expect, it } from "vitest";
import { IndexedDbMessageStore } from "../src/providers/IndexedDbMessageStore";
import type { Chat, EncryptedMessage } from "../src/types";

describe("IndexedDbMessageStore", () => {
  beforeEach(async () => {
    await indexedDB.deleteDatabase("ping2peer-v1");
  });

  it("persists chats and encrypted messages by chat", async () => {
    const store = new IndexedDbMessageStore();
    const chat: Chat = {
      id: "chat_1",
      peerId: "peer_1",
      title: "Alice · Phone",
      createdAt: 1,
      updatedAt: 2
    };
    const message: EncryptedMessage = {
      id: "msg_1",
      chatId: chat.id,
      senderPeerId: "peer_me",
      sentAt: 3,
      ciphertext: "ciphertext",
      nonce: "nonce",
      deliveryState: "sent"
    };

    await store.saveChat(chat);
    await store.saveMessage(message);

    await expect(store.listChats()).resolves.toEqual([chat]);
    await expect(store.listMessages(chat.id)).resolves.toEqual([message]);
  });
});
