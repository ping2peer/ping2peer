import type { Chat, ChatId, DeviceProfile, EncryptedMessage, MessageStore, PeerId, TrustedPeer } from "../types";

const dbName = "ping2peer-v1";
const dbVersion = 1;

type StoreName = "profile" | "trustedPeers" | "chats" | "messages";

export class IndexedDbMessageStore implements MessageStore {
  private dbPromise?: Promise<IDBDatabase>;

  async getProfile(): Promise<DeviceProfile | undefined> {
    return this.get<DeviceProfile>("profile", "local");
  }

  async saveProfile(profile: DeviceProfile): Promise<void> {
    await this.put("profile", profile, "local");
  }

  async listChats(): Promise<Chat[]> {
    const chats = await this.getAll<Chat>("chats");
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveChat(chat: Chat): Promise<void> {
    await this.put("chats", chat);
  }

  async getChat(chatId: ChatId): Promise<Chat | undefined> {
    return this.get<Chat>("chats", chatId);
  }

  async listMessages(chatId: ChatId): Promise<EncryptedMessage[]> {
    const messages = await this.getAllFromIndex<EncryptedMessage>("messages", "by-chat", chatId);
    return messages.sort((a, b) => b.sentAt - a.sentAt);
  }

  async saveMessage(message: EncryptedMessage): Promise<void> {
    await this.put("messages", message);
  }

  async saveTrustedPeer(peer: TrustedPeer): Promise<void> {
    await this.put("trustedPeers", peer);
  }

  async getTrustedPeer(peerId: PeerId): Promise<TrustedPeer | undefined> {
    return this.get<TrustedPeer>("trustedPeers", peerId);
  }

  async clearChatMessages(chatId: ChatId): Promise<void> {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      const index = store.index("by-chat");
      const request = index.openCursor(chatId);
      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          this.migrateOrphanedMessages(db).then(() => resolve(db)).catch(() => resolve(db));
        };
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("profile");
          db.createObjectStore("trustedPeers", { keyPath: "peerId" });
          db.createObjectStore("chats", { keyPath: "id" });
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("by-chat", "chatId", { unique: false });
        };
      });
    }
    return this.dbPromise;
  }

  private async get<T>(storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T | undefined);
    });
  }

  private async getAll<T>(storeName: StoreName): Promise<T[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T[]);
    });
  }

  private async getAllFromIndex<T>(storeName: StoreName, indexName: string, key: IDBValidKey): Promise<T[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T[]);
    });
  }

  private async put<T>(storeName: StoreName, value: T, key?: IDBValidKey): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = key
        ? db.transaction(storeName, "readwrite").objectStore(storeName).put(value, key)
        : db.transaction(storeName, "readwrite").objectStore(storeName).put(value);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private async migrateOrphanedMessages(db: IDBDatabase): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const messages = request.result as EncryptedMessage[];
        for (const msg of messages) {
          if (msg.deliveryState === "received") {
            const expectedChatId = `chat_${msg.senderPeerId}`;
            if (msg.chatId !== expectedChatId) {
              msg.chatId = expectedChatId;
              store.put(msg);
            }
          }
        }
        resolve();
      };
    });
  }
}
