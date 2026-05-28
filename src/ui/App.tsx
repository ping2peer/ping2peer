import { Check, Clipboard, CornerUpLeft, Link, MessageCircle, Shield, Smartphone, Radio, Settings, X, User, ChevronLeft, LogOut, RotateCcw, MoreVertical } from "lucide-react";
import { IoSend } from "react-icons/io5";
import { IoCheckmark, IoAlertCircle, IoTimeOutline } from "react-icons/io5";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, TouchEvent as ReactTouchEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { createId } from "../lib/encoding";
import { IndexedDbMessageStore } from "../providers/IndexedDbMessageStore";
import { ManualPairingDiscoveryProvider } from "../providers/ManualPairingDiscoveryProvider";
import { RelayTextTransport } from "../providers/RelayTextTransport";
import { WebCryptoProvider } from "../providers/WebCryptoProvider";
import { WebRtcDataChannelTransport } from "../providers/WebRtcDataChannelTransport";
import { WebSocketSignallingProvider } from "../providers/SignallingDiscoveryProvider";
import type {
  Chat,
  ChatEnvelope,
  DeviceProfile,
  EncryptedMessage,
  PairingPayload,
  PlainMessage,
  TrustedPeer,
  TransportState,
  ChatKey,
  PeerTransport,
  DiscoveredPeer,
  ConnectionRequest
} from "../types";

const store = new IndexedDbMessageStore();
const cryptoProvider = new WebCryptoProvider();
const manualDiscoveryProvider = new ManualPairingDiscoveryProvider();
const signallingProvider = new WebSocketSignallingProvider();

const pendingInviteStorageKey = "ping2peer.pendingInvite";
const pairingHandoffStorageKey = "ping2peer.pairingHandoff";
const pairingChannelName = "ping2peer.pairing";
const signalServerStorageKey = "ping2peer.signalServer";
const themeStorageKey = "ping2peer.theme";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

type PairingKind = "invite" | "answer";
type PairingHandoff =
  | { type: "pairing"; id: string; kind: PairingKind; code: string; }
  | { type: "ack"; id: string; };

type Screen = "nearby" | "chats" | "create" | "join" | "chat" | "settings" | "profile";

type ActiveSession = {
  chat: Chat;
  peer: TrustedPeer;
  key: ChatKey;
  transport: PeerTransport;
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function App() {
  const [profile, setProfile] = useState<DeviceProfile>();
  const [displayName, setDisplayName] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [screen, setScreen] = useState<Screen>("nearby");
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<PlainMessage[]>([]);
  
  // Multi-session state
  const [activeSessions, setActiveSessions] = useState<Record<string, ActiveSession>>({});
  const [sessionStates, setSessionStates] = useState<Record<string, TransportState>>({});
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  const activeSessionsRef = useRef(activeSessions);
  activeSessionsRef.current = activeSessions;

  const activeSession = activeChatId ? activeSessions[activeChatId] : undefined;
  const activeChat = useMemo(() => chats.find(c => c.id === activeChatId), [chats, activeChatId]);
  const connectionState = activeChatId ? sessionStates[activeChatId] ?? "idle" : "idle";

  const [inviteCode, setInviteCode] = useState("");
  const [answerCode, setAnswerCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinAnswerCode, setJoinAnswerCode] = useState("");
  const [messageText, setMessageText] = useState("");
  const [notice, setNotice] = useState("");
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem(themeStorageKey) === "dark");
  const [autoConnect, setAutoConnect] = useState(() => localStorage.getItem("ping2peer.autoConnect") !== "false");
  const [replyingTo, setReplyingTo] = useState<PlainMessage | null>(null);
  const [pickerMessageId, setPickerMessageId] = useState<string | null>(null);
  const [openMenuChatId, setOpenMenuChatId] = useState<string | null>(null);

  // Profile editing
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editDeviceName, setEditDeviceName] = useState("");

  const DEFAULT_SIGNAL_SERVER = "wss://f1x7rgpuf3.execute-api.us-east-2.amazonaws.com/prod";

  const [customSignalServer, setCustomSignalServer] = useState(() => localStorage.getItem("ping2peer.customSignalServer") === "true");
  const [signalServerUrl, setSignalServerUrl] = useState(() => {
    let saved = localStorage.getItem(signalServerStorageKey);
    if (saved && saved.startsWith("ws://") && window.location.protocol === "https:") {
      saved = null;
    }
    return saved || DEFAULT_SIGNAL_SERVER;
  });
  const [signalState, setSignalState] = useState(signallingProvider.connectionState);
  const [nearbyPeers, setNearbyPeers] = useState<DiscoveredPeer[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ConnectionRequest[]>([]);
  const [pendingOutgoingRequest, setPendingOutgoingRequest] = useState<string | null>(null);

  const nearbyPeersRef = useRef(nearbyPeers);
  nearbyPeersRef.current = nearbyPeers;
  const pendingReqRef = useRef(pendingOutgoingRequest);
  pendingReqRef.current = pendingOutgoingRequest;
  const autoConnectingRef = useRef(new Set<string>());
  const autoAcceptedRef = useRef(new Set<string>());
  const yieldedManualRef = useRef(new Set<string>());

  const inviteTransportRef = useRef<PeerTransport | null>(null);
  const tabIdRef = useRef(createId("tab"));
  const processedLinkRef = useRef("");

  // --- Auto-load messages effect ---
  useEffect(() => {
    if (activeChatId && activeSessions[activeChatId]) {
      void loadMessagesFor(activeChatId, activeSessions[activeChatId].key);
    } else {
      setMessages([]);
    }
  }, [activeChatId, activeSessions]);

  const [themeColor, setThemeColor] = useState(() => localStorage.getItem("ping2peer.themeColor") || "26547C");

  // --- Theme effect ---
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    localStorage.setItem(themeStorageKey, darkMode ? "dark" : "light");
  }, [darkMode]);

  // --- Color effect ---
  useEffect(() => {
    document.documentElement.setAttribute("data-color", themeColor);
    localStorage.setItem("ping2peer.themeColor", themeColor);
  }, [themeColor]);

  // --- Click to close dropdowns ---
  useEffect(() => {
    const handleGlobalClick = () => setOpenMenuChatId(null);
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  // --- Mobile keyboard resize fix ---
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      document.documentElement.style.height = `${vv.height}px`;
    };
    const onBlur = (e: FocusEvent) => {
      if (e.target && ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA")) {
        setTimeout(() => {
          window.scrollTo(0, 0);
          document.body.scrollTop = 0;
        }, 80);
      }
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    document.addEventListener("focusout", onBlur);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
      document.removeEventListener("focusout", onBlur);
      document.documentElement.style.height = "";
    };
  }, []);

  useEffect(() => {
    void store.getProfile().then((saved) => {
      if (saved) {
        setProfile(saved);
        setEditDisplayName(saved.displayName);
        setEditDeviceName(saved.deviceName);
      }
    });
    void refreshChats();
  }, []);

  useEffect(() => {
    if (!profile) return;
    const channel = createPairingChannel();
    channel?.addEventListener("message", handleChannelMessage);
    window.addEventListener("storage", handleStorageMessage);
    void handlePairingLink(channel);
    return () => {
      channel?.removeEventListener("message", handleChannelMessage);
      channel?.close();
      window.removeEventListener("storage", handleStorageMessage);
    };
  }, [profile]);

  useEffect(() => {
    if (!profile) return;

    signallingProvider.connect(signalServerUrl, profile);

    const offs = [
      signallingProvider.onConnectionStateChange(setSignalState),
      signallingProvider.onPeersChanged((peers) => {
        setNearbyPeers(peers);
        const isAuto = localStorage.getItem("ping2peer.autoConnect") !== "false";
        if (isAuto && profile) {
          peers.forEach(peer => {
            const peerChatId = `chat_${peer.peerId}`;
            const session = activeSessionsRef.current[peerChatId];
            const isConnectedOrConnecting = session && (session.transport.state === "connected" || session.transport.state === "connecting");
            // Skip if already connected/connecting or if an auto-connect attempt is in-flight
            if (isConnectedOrConnecting || autoConnectingRef.current.has(peer.peerId)) return;
            // Skip if we already have a manual pending request to this peer
            if (pendingReqRef.current === peer.peerId) return;
            // Deterministic tie-breaker: only the side with the "lower" peerId initiates.
            // This prevents both devices from sending requestConnection simultaneously.
            if (profile.peerId > peer.peerId) return;

            void store.getTrustedPeer(peer.peerId).then(trusted => {
              if (trusted) {
                // Re-check after async gap
                const sess = activeSessionsRef.current[peerChatId];
                if (sess && (sess.transport.state === "connected" || sess.transport.state === "connecting")) return;
                if (autoConnectingRef.current.has(peer.peerId)) return;
                if (pendingReqRef.current) return; // don't auto-connect while a manual request is pending

                autoConnectingRef.current.add(peer.peerId);
                signallingProvider.requestConnection(peer.peerId);
              }
            });
          });
        }
      }),
      signallingProvider.onConnectionRequest(async (req) => {
        const isOutgoingManual = pendingReqRef.current === req.from.peerId;
        const isOutgoingAuto = autoConnectingRef.current.has(req.from.peerId);
        
        if (isOutgoingManual || isOutgoingAuto) {
          // Glare resolution: only the lower peerId device gets to be the initiator
          if (profile!.peerId < req.from.peerId) {
            return; // We win initiator role, ignore their request
          } else {
            // We yield the initiator role to them
            autoConnectingRef.current.delete(req.from.peerId);
            if (isOutgoingManual) {
              setPendingOutgoingRequest(null);
              yieldedManualRef.current.add(req.from.peerId);
              autoAcceptedRef.current.add(req.from.peerId);
              signallingProvider.acceptConnection(req.from.peerId);
              return;
            }
          }
        }

        const isAuto = localStorage.getItem("ping2peer.autoConnect") !== "false";
        const trusted = await store.getTrustedPeer(req.from.peerId);
        if (isAuto && trusted) {
          autoAcceptedRef.current.add(req.from.peerId);
          signallingProvider.acceptConnection(req.from.peerId);
        } else {
          setIncomingRequests(prev => {
            return [...prev.filter(r => r.from.peerId !== req.from.peerId), req];
          });
        }
      }),
      signallingProvider.onConnectionAccepted(async (peerId) => {
        const isManualPending = pendingReqRef.current === peerId;
        const isAutoPending = autoConnectingRef.current.has(peerId);
        if (!isManualPending && !isAutoPending) return;

        if (isManualPending) setNotice("Connection accepted, negotiating WebRTC...");
        const peer = nearbyPeersRef.current.find(p => p.peerId === peerId) || await store.getTrustedPeer(peerId);
        if (!peer) {
          autoConnectingRef.current.delete(peerId);
          if (isManualPending) setPendingOutgoingRequest(null);
          return;
        }
        try {
          const transport = createTransport();
          if (transport instanceof WebRtcDataChannelTransport) {
            const remotePublicKey = await transport.connectViaSignalling(profile, peerId, signallingProvider);
            const session = await initializeSession(peer, remotePublicKey, transport);
            attachSession(session);
            if (isManualPending) {
              setActiveChatId(session.chat.id);
              setScreen("chat");
            }
            setNotice(`Connected to ${peer.displayName}`);
          }
        } catch (err) {
          setNotice(errorMessage(err, "Failed to connect via signalling"));
        } finally {
          autoConnectingRef.current.delete(peerId);
          if (isManualPending) setPendingOutgoingRequest(null);
        }
      }),
      signallingProvider.onConnectionRejected((peerId) => {
        autoConnectingRef.current.delete(peerId);
        if (pendingReqRef.current === peerId) {
          setNotice("Connection request rejected");
          setPendingOutgoingRequest(null);
        }
      }),
      signallingProvider.onWebRtcOffer(async (peerId, signal) => {
        const peer = nearbyPeersRef.current.find(p => p.peerId === peerId) || await store.getTrustedPeer(peerId);
        if (!peer) return;
        const wasAutoAccepted = autoAcceptedRef.current.has(peerId);
        const wasYieldedManual = yieldedManualRef.current.has(peerId);
        autoAcceptedRef.current.delete(peerId);
        yieldedManualRef.current.delete(peerId);
        try {
          const transport = createTransport();
          if (transport instanceof WebRtcDataChannelTransport) {
            const remotePublicKey = await transport.acceptViaSignalling(profile, peerId, signal, signallingProvider);
            const session = await initializeSession(peer, remotePublicKey, transport);
            attachSession(session);
            // Only navigate to chat for manual accepts; auto-accept silently establishes
            if (!wasAutoAccepted || wasYieldedManual) {
              setActiveChatId(session.chat.id);
              setScreen("chat");
            }
            setNotice(`Connected to ${peer.displayName}`);
          }
        } catch (err) {
          setNotice(errorMessage(err, "Failed to accept WebRTC offer"));
        }
      })
    ];

    return () => offs.forEach(off => off());
  }, [profile, signalServerUrl]);

  const activeTitle = useMemo(() => activeSession?.chat.title ?? activeChat?.title ?? "Ping2Peer", [activeSession, activeChat]);

  async function refreshChats() {
    setChats(await store.listChats());
  }

  function attachSession(session: ActiveSession) {
    const chatId = session.chat.id;
    const transport = session.transport;

    // Disconnect any old transport being replaced for this chatId
    const existing = activeSessionsRef.current[chatId];
    if (existing && existing.transport !== transport) {
      try { existing.transport.disconnect(); } catch { /* already closed */ }
    }

    setActiveSessions(prev => ({ ...prev, [chatId]: session }));
    setSessionStates(prev => ({ ...prev, [chatId]: session.transport.state }));
    
    transport.onStateChange((state) => {
      // Guard: only process if this transport is still the active one.
      // Prevents a stale transport's "closed" event from nuking a newer session.
      const current = activeSessionsRef.current[chatId];
      if (current && current.transport !== transport) return;

      setSessionStates(prev => ({ ...prev, [chatId]: state }));
      if (state === "failed" || state === "closed") {
        setActiveSessions(prev => {
          if (prev[chatId]?.transport !== transport) return prev; // double-check inside setter
          const next = { ...prev };
          delete next[chatId];
          return next;
        });
      }
    });
    
    transport.onMessage((envelope) => {
      void handleIncomingEnvelope(envelope, session);
    });
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    try {
      const next = await cryptoProvider.createProfile(displayName.trim(), deviceName.trim());
      await store.saveProfile(next);
      setProfile(next);
      setEditDisplayName(next.displayName);
      setEditDeviceName(next.deviceName);
    } catch {
      setNotice("Could not create encrypted profile.");
    }
  }

  async function updateProfile(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    const updated: DeviceProfile = { ...profile, displayName: editDisplayName.trim(), deviceName: editDeviceName.trim() };
    await store.saveProfile(updated);
    setProfile(updated);
    setNotice("Profile updated");
    signallingProvider.disconnect();
    signallingProvider.connect(signalServerUrl, updated);
  }

  async function createInvite() {
    if (!profile) return;
    setNotice("");
    try {
      const transport = createTransport();
      const invite = await transport.createInvite(profile);
      inviteTransportRef.current = transport;
      const encodedInvite = manualDiscoveryProvider.encodePayload(invite);
      localStorage.setItem(pendingInviteStorageKey, encodedInvite);
      setInviteCode(encodedInvite);
      setAnswerCode("");
      setActiveChatId(null);
      setNotice("Invite ready");
    } catch (error) {
      setNotice(errorMessage(error, "Could not create invite."));
    }
  }

  async function applyAnswer() {
    if (!profile || !inviteCode.trim() || !answerCode.trim()) return;
    await applyAnswerCode(answerCode);
  }

  async function applyAnswerCode(code: string) {
    if (!profile || !code.trim()) return;
    setNotice("");
    try {
      const answer = manualDiscoveryProvider.decodePayload(code);
      const pendingInviteCode = inviteCode || localStorage.getItem(pendingInviteStorageKey) || "";
      const pendingInvite = pendingInviteCode ? manualDiscoveryProvider.decodePayload(pendingInviteCode) : undefined;
      const transport = inviteTransportRef.current ?? createTransport(pendingInvite);
      if (!transport) {
        setNotice("Create an invite first");
        return;
      }
      inviteTransportRef.current = transport;
      setInviteCode(pendingInviteCode);
      setAnswerCode(code);
      await transport.applyAnswer(answer);
      const session = await initializeSession(answer.peer, answer.peer.publicIdentityKey, transport);
      attachSession(session);
      setActiveChatId(session.chat.id);
      loadMessagesFor(session.chat.id, session.key);
      setScreen("chat");
      localStorage.removeItem(pendingInviteStorageKey);
      setNotice(`Connected to ${answer.peer.displayName}`);
    } catch (error) {
      setNotice(errorMessage(error, "Could not connect."));
    }
  }

  async function joinInvite() {
    if (!profile || !joinCode.trim()) return;
    await generateAnswerFromCode(joinCode);
  }

  async function generateAnswerFromCode(code: string) {
    if (!profile || !code.trim()) return;
    setNotice("");
    try {
      const invite = manualDiscoveryProvider.decodePayload(code);
      const transport = createTransport(invite);
      const answer = await transport.acceptInvite(profile, invite);
      setJoinCode(code);
      setJoinAnswerCode(manualDiscoveryProvider.encodePayload(answer));
      const session = await initializeSession(invite.peer, invite.peer.publicIdentityKey, transport);
      attachSession(session);
      setActiveChatId(session.chat.id);
      loadMessagesFor(session.chat.id, session.key);
      setScreen("join");
      setNotice(`Answer ready for ${invite.peer.displayName}`);
    } catch (error) {
      setJoinAnswerCode("");
      setNotice(errorMessage(error, "Could not generate answer."));
    }
  }

  async function openExistingChat(chat: Chat) {
    if (!profile) return;
    if (activeSessions[chat.id]) {
      setActiveChatId(chat.id);
      loadMessagesFor(chat.id, activeSessions[chat.id].key);
      setScreen("chat");
      return;
    }
    const peer = await store.getTrustedPeer(chat.peerId);
    if (!peer) {
      setNotice("Peer identity is missing");
      return;
    }
    const key = await cryptoProvider.deriveChatKey(profile.privateIdentityKey, peer.publicIdentityKey);
    const session: ActiveSession = { chat, peer, key, transport: createTransport() };
    attachSession(session);
    setActiveChatId(chat.id);
    loadMessagesFor(chat.id, key);
    setScreen("chat");
  }

  async function loadMessagesFor(chatId: string, key: ChatKey) {
    const encryptedMessages = await store.listMessages(chatId);
    const plainMessages = await decryptMessages(key, encryptedMessages);
    setMessages(plainMessages);
  }

  async function initializeSession(peerPayload: PairingPayload["peer"] | DiscoveredPeer, remotePublicKey: JsonWebKey, transport: PeerTransport): Promise<ActiveSession> {
    const now = Date.now();
    const trustedPeer: TrustedPeer = {
      peerId: peerPayload.peerId,
      displayName: peerPayload.displayName,
      deviceName: peerPayload.deviceName,
      publicIdentityKey: remotePublicKey,
      firstTrustedAt: now,
      lastSeenAt: now
    };
    const chat: Chat = {
      id: `chat_${peerPayload.peerId}`,
      peerId: peerPayload.peerId,
      title: `${peerPayload.displayName} - ${peerPayload.deviceName}`,
      createdAt: now,
      updatedAt: now
    };
    const key = await cryptoProvider.deriveChatKey(profile!.privateIdentityKey, remotePublicKey);
    await store.saveTrustedPeer(trustedPeer);
    await store.saveChat(chat);
    await refreshChats();
    return { chat, peer: trustedPeer, key, transport };
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!profile || !activeSession || !messageText.trim()) return;
    const body = messageText.trim();
    setMessageText("");
    const encrypted = await cryptoProvider.encryptText(activeSession.key, body);
    const message: EncryptedMessage = {
      id: createId("msg"),
      chatId: activeSession.chat.id,
      senderPeerId: profile.peerId,
      sentAt: Date.now(),
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      deliveryState: connectionState === "connected" ? "sent" : "failed",
      replyToId: replyingTo?.id
    };
    await store.saveMessage(message);
    await store.saveChat({ ...activeSession.chat, updatedAt: message.sentAt });
    
    if (activeChatIdRef.current === activeSession.chat.id) {
      setMessages((current) => [{ ...message, body }, ...current]);
    }
    setReplyingTo(null);

    if (connectionState === "connected") {
      try {
        activeSession.transport.send({ type: "chat-message", message });
      } catch {
        await store.saveMessage({ ...message, deliveryState: "failed" });
        setNotice("Message could not be sent");
      }
    } else {
      setNotice("Peer is offline");
    }
    await refreshChats();
  }

  async function retryMessage(msg: PlainMessage) {
    if (!profile || !activeSession || connectionState !== "connected") return;
    try {
      const encrypted = await cryptoProvider.encryptText(activeSession.key, msg.body);
      const newMsg: EncryptedMessage = {
        ...msg,
        sentAt: Date.now(),
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        deliveryState: "sent",
      };
      activeSession.transport.send({ type: "chat-message", message: newMsg });
      await store.saveMessage(newMsg);
      if (activeChatIdRef.current === msg.chatId) {
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, deliveryState: "sent", sentAt: newMsg.sentAt } : m));
      }
    } catch {
      setNotice("Retry failed");
    }
  }

  function handleReaction(messageId: string, emoji: string) {
    if (!profile || !activeSession) return;
    setPickerMessageId(null);

    setMessages(prev => prev.map(m => {
      if (m.id !== messageId) return m;
      const reactions = { ...(m.reactions ?? {}) };
      const list = reactions[emoji] ?? [];
      if (list.includes(profile.peerId)) {
        reactions[emoji] = list.filter(id => id !== profile.peerId);
        if (reactions[emoji].length === 0) delete reactions[emoji];
      } else {
        reactions[emoji] = [...list, profile.peerId];
      }
      return { ...m, reactions };
    }));

    if (connectionState === "connected") {
      try {
        activeSession.transport.send({ type: "reaction", messageId, reaction: emoji, senderPeerId: profile.peerId });
      } catch { }
    }
  }

  async function clearHistory() {
    if (!activeSession) return;
    if (confirm("Are you sure you want to clear chat history? This cannot be undone.")) {
      await store.clearChatMessages(activeSession.chat.id);
      setMessages([]);
      setNotice("Chat history cleared");
    }
  }

  function disconnectPeer() {
    if (!activeSession || !activeChatId) return;
    if (confirm(`Disconnect from ${activeSession.peer.displayName}?`)) {
      activeSession.transport.disconnect();
      setActiveSessions(prev => {
        const next = { ...prev };
        delete next[activeChatId];
        return next;
      });
      setActiveChatId(null);
      setScreen("nearby");
      setNotice("Disconnected");
    }
  }

  async function handleIncomingEnvelope(envelope: ChatEnvelope, session: ActiveSession) {
    if (envelope.type === "reaction") {
      if (activeChatIdRef.current === session.chat.id) {
        setMessages(prev => prev.map(m => {
          if (m.id !== envelope.messageId) return m;
          const reactions = { ...(m.reactions ?? {}) };
          const list = reactions[envelope.reaction] ?? [];
          if (list.includes(envelope.senderPeerId)) {
            reactions[envelope.reaction] = list.filter(id => id !== envelope.senderPeerId);
            if (reactions[envelope.reaction].length === 0) delete reactions[envelope.reaction];
          } else {
            reactions[envelope.reaction] = [...list, envelope.senderPeerId];
          }
          return { ...m, reactions };
        }));
      }
      return;
    }
    if (envelope.type !== "chat-message") return;
    const body = await cryptoProvider.decryptText(session.key, envelope.message.ciphertext, envelope.message.nonce);
    const received: EncryptedMessage = { 
      ...envelope.message, 
      chatId: session.chat.id, // Ensure it's saved under the local chat ID
      deliveryState: "received" 
    };
    await store.saveMessage(received);
    await store.saveChat({ ...session.chat, updatedAt: received.sentAt });
    
    if (activeChatIdRef.current === session.chat.id) {
      setMessages((current) => [{ ...received, body }, ...current]);
    }
    await refreshChats();
  }

  async function decryptMessages(key: ChatKey, encryptedMessages: EncryptedMessage[]): Promise<PlainMessage[]> {
    const output: PlainMessage[] = [];
    for (const message of encryptedMessages) {
      try {
        output.push({
          ...message,
          body: await cryptoProvider.decryptText(key, message.ciphertext, message.nonce)
        });
      } catch {
        output.push({ ...message, body: "[Unable to decrypt]" });
      }
    }
    return output;
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setNotice("Copied");
  }

  async function handleChannelMessage(event: MessageEvent<PairingHandoff>) {
    const message = event.data;
    if (message.type !== "pairing") return;
    createPairingChannel()?.postMessage({ type: "ack", id: message.id } satisfies PairingHandoff);
    await handlePairingPayload(message.kind, message.code);
  }

  async function handleStorageMessage(event: StorageEvent) {
    if (event.key !== pairingHandoffStorageKey || !event.newValue) return;
    const message = JSON.parse(event.newValue) as PairingHandoff;
    if (message.type !== "pairing") return;
    localStorage.setItem(pairingHandoffStorageKey, JSON.stringify({ type: "ack", id: message.id } satisfies PairingHandoff));
    await handlePairingPayload(message.kind, message.code);
  }

  async function handlePairingLink(channel: BroadcastChannel | undefined) {
    const pairing = pairingFromUrl();
    if (!pairing) return;
    const linkKey = `${pairing.kind}:${pairing.code}`;
    if (!linkKey || linkKey === ":" || processedLinkRef.current === linkKey) return;
    processedLinkRef.current = linkKey;

    const handoff: PairingHandoff = {
      type: "pairing",
      id: `${tabIdRef.current}:${Date.now()}`,
      kind: pairing.kind,
      code: pairing.code
    };
    const handledByExistingTab = await sendPairingToExistingTab(handoff, channel);
    clearPairingUrl();
    if (handledByExistingTab) {
      setNotice("Pairing sent to the open Ping2Peer tab.");
      return;
    }
    await handlePairingPayload(pairing.kind, pairing.code);
  }

  async function handlePairingPayload(kind: PairingKind, code: string) {
    if (kind === "invite") {
      setScreen("join");
      setJoinCode(code);
      await generateAnswerFromCode(code);
      return;
    }
    setScreen("create");
    setAnswerCode(code);
    await applyAnswerCode(code);
  }

  function saveSettings(event: FormEvent) {
    event.preventDefault();
    localStorage.setItem(signalServerStorageKey, signalServerUrl);
    signallingProvider.disconnect();
    signallingProvider.connect(signalServerUrl, profile!);
    setNotice("Settings saved");
    setScreen("nearby");
  }

  // === RENDER ===

  if (!profile) {
    return (
      <main className="setup-screen">
        <section className="setup-panel">
          <div className="brand-mark"><Shield size={28} /></div>
          <h1>Ping2Peer</h1>
          {notice && <button className="notice setup-notice" type="button" onClick={() => setNotice("")}>{notice}</button>}
          <form onSubmit={saveProfile} className="stack">
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={40} />
            </label>
            <label>
              Device
              <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} required maxLength={40} />
            </label>
            <button className="primary-action" type="submit"><Check size={18} />Continue</button>
          </form>
        </section>
      </main>
    );
  }

  const navItems: { id: Screen; label: string; icon: React.ReactNode }[] = [
    { id: "nearby", label: "Network", icon: <Radio size={20} /> },
    { id: "chats", label: "Chats", icon: <MessageCircle size={20} /> },
    { id: "profile", label: "Profile", icon: <User size={20} /> },
    { id: "settings", label: "Settings", icon: <Settings size={20} /> },
  ];

  const currentNav = screen === "chat" || screen === "create" || screen === "join" ? undefined : screen;

  return (
    <main className="app-shell">
      {/* Global Connection Request Popup */}
      {incomingRequests.length > 0 && (
        <div className="global-popup-overlay">
          <div className="global-popup">
            <h3>Incoming Request</h3>
            <p><strong>{incomingRequests[0].from.displayName}</strong> wants to connect.</p>
            <div className="action-row">
              <button className="primary-action" onClick={() => {
                signallingProvider.acceptConnection(incomingRequests[0].from.peerId);
                setIncomingRequests(prev => prev.slice(1));
              }}><Check size={18} /> Accept</button>
              <button onClick={() => {
                signallingProvider.rejectConnection(incomingRequests[0].from.peerId);
                setIncomingRequests(prev => prev.slice(1));
              }} style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "none" }}><X size={18} /> Reject</button>
            </div>
          </div>
        </div>
      )}

      {/* === Desktop Left Sidebar === */}
      <aside className="sidebar">
        <div className="sidebar-brand" style={{ fontWeight: "normal" }}>Ping2Peer</div>
        <nav className="sidebar-nav">
          {navItems.map(item => (
            <button key={item.id} className={`sidebar-nav-item ${currentNav === item.id ? "active" : ""}`} onClick={() => setScreen(item.id)}>
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-profile">
          <div className="sidebar-profile-avatar">{profile.displayName.charAt(0).toUpperCase()}</div>
          <div className="sidebar-profile-info">
            <strong>{profile.displayName}</strong>
            <small>{profile.deviceName}</small>
          </div>
        </div>
      </aside>

      {/* === Main Content === */}
      <div className="main-content">
        {/* Mobile Header (Not shown on Chat screen) */}
        {screen !== "chat" && (
          <header className="app-header">
            <h2>{screen.charAt(0).toUpperCase() + screen.slice(1)}</h2>
          </header>
        )}
        {/* Chat top bar */}
        {screen === "chat" && activeChat && (
          <header className="top-bar">
            <button className="top-bar-back" onClick={() => setScreen("chats")} aria-label="Back"><ChevronLeft size={22} /></button>
            <div className="top-bar-center">
              <strong>{activeChat.title}</strong>
              <div className="status-line">
                <span className={`status-dot ${connectionState === "connected" ? "online" : "offline"}`} />
                {connectionState === "connected" ? "online" : "offline"}
              </div>
            </div>
            <div className="top-bar-actions">
              {connectionState === "connected" ? (
                <button className="disconnect-button" onClick={disconnectPeer} title="Disconnect" aria-label="Disconnect"><LogOut size={18} /></button>
              ) : (
                <button className="icon-button" onClick={() => {
                  signallingProvider.requestConnection(activeChat.peerId);
                  setPendingOutgoingRequest(activeChat.peerId);
                }} title="Connect" aria-label="Connect"><Link size={18} /></button>
              )}
            </div>
          </header>
        )}

        {notice && <button className="notice" onClick={() => setNotice("")}>{notice}</button>}

        {/* === Nearby Screen === */}
        {screen === "nearby" && (
          <section className="screen">
            <div className="action-row">
              <p style={{ gridColumn: "1 / -1", margin: 0 }}>
                <strong>{signalState === "connected" ? "Online on local network" : "Offline / Connecting..."}</strong>
              </p>
            </div>
            <div className="chat-list">
              <h3>Nearby Devices</h3>
              {(() => {
                const mergedList: { peerId: string; displayName: string; deviceName: string; isOnline: boolean }[] = [
                  ...nearbyPeers.map(p => ({
                    peerId: p.peerId,
                    displayName: p.displayName,
                    deviceName: p.deviceName,
                    isOnline: true
                  }))
                ];

                chats.forEach(chat => {
                  if (!mergedList.some(p => p.peerId === chat.peerId)) {
                    mergedList.push({
                      peerId: chat.peerId,
                      displayName: chat.title,
                      deviceName: "Not online on local network",
                      isOnline: false
                    });
                  }
                });

                if (mergedList.length === 0) return <p className="empty-state">No devices found</p>;

                return mergedList.map((peer) => {
                  const peerChatId = `chat_${peer.peerId}`;
                  const isConnected = sessionStates[peerChatId] === "connected";
                  return (
                    <div className="chat-item" key={peer.peerId}>
                      <div>
                        <span>{peer.displayName} {!peer.isOnline && <small style={{ display: "inline", color: "var(--text-tertiary)", fontWeight: "normal" }}>(Offline)</small>}</span>
                        <small>{peer.deviceName}</small>
                      </div>
                      {isConnected ? (
                        <button className="disconnect-button-inline" onClick={() => {
                          const session = activeSessions[peerChatId];
                          if (session && confirm(`Disconnect from ${peer.displayName}?`)) {
                            session.transport.disconnect();
                            setActiveSessions(prev => {
                              const next = { ...prev };
                              delete next[peerChatId];
                              return next;
                            });
                            setSessionStates(prev => {
                              const next = { ...prev };
                              delete next[peerChatId];
                              return next;
                            });
                            if (activeChatId === peerChatId) setActiveChatId(null);
                            setNotice("Disconnected");
                          }
                        }}><LogOut size={16} /> Disconnect</button>
                      ) : pendingOutgoingRequest === peer.peerId ? (
                        <small style={{ color: "var(--accent)" }}>Waiting...</small>
                      ) : (
                        <button 
                          disabled={!peer.isOnline}
                          style={!peer.isOnline ? { opacity: 0.5, cursor: "not-allowed", background: "var(--bg-secondary)", color: "var(--text-tertiary)" } : {}}
                          onClick={() => {
                            if (!peer.isOnline) {
                              setNotice("Device is offline. Connect request can only be sent when the device is online.");
                              return;
                            }
                            signallingProvider.requestConnection(peer.peerId);
                            setPendingOutgoingRequest(peer.peerId);
                          }}
                        >Connect</button>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </section>
        )}

        {/* === Chats Screen === */}
        {screen === "chats" && (
          <section className="screen">
            <div className="chat-list">
              {chats.length === 0 && <p className="empty-state">No chats yet</p>}
              {chats.map((chat) => (
                <div className="chat-item" key={chat.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative" }}>
                  <div style={{ flex: 1, cursor: "pointer" }} onClick={() => void openExistingChat(chat)}>
                    <span style={{ display: "block" }}>{chat.title}</span>
                    <small>
                      {sessionStates[chat.id] === "connected" ? <span style={{color: "var(--success)"}}>● Connected</span> : new Date(chat.updatedAt).toLocaleString()}
                    </small>
                  </div>
                  <div style={{ position: "relative" }}>
                    <button className="icon-button" onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuChatId(openMenuChatId === chat.id ? null : chat.id);
                    }} title="Menu" aria-label="Menu">
                      <MoreVertical size={18} />
                    </button>
                    {openMenuChatId === chat.id && (
                      <div className="menu-dropdown" style={{
                        position: "absolute",
                        right: 0,
                        top: "100%",
                        background: "var(--bg-surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        boxShadow: "var(--shadow-md)",
                        zIndex: 20,
                        minWidth: "150px",
                        padding: "4px 0",
                        display: "flex",
                        flexDirection: "column"
                      }}>
                        <button style={{
                          padding: "8px 12px",
                          background: "transparent",
                          border: "none",
                          textAlign: "left",
                          color: "var(--danger)",
                          cursor: "pointer",
                          fontSize: "0.85rem",
                          fontWeight: 600,
                          width: "100%"
                        }} onClick={async (e) => {
                          e.stopPropagation();
                          setOpenMenuChatId(null);
                          if (confirm(`Are you sure you want to clear chat history for ${chat.title}? This cannot be undone.`)) {
                            await store.clearChatMessages(chat.id);
                            if (activeChatId === chat.id) {
                              setMessages([]);
                            }
                            setNotice("Chat history cleared");
                          }
                        }}>
                          Delete Chat History
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* === Profile Screen === */}
        {screen === "profile" && (
          <section className="screen profile-screen">
            <div className="profile-avatar-large">{profile.displayName.charAt(0).toUpperCase()}</div>
            <form onSubmit={updateProfile} className="stack">
              <label>
                Display Name
                <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} required maxLength={40} />
              </label>
              <label>
                Device Name
                <input value={editDeviceName} onChange={(e) => setEditDeviceName(e.target.value)} required maxLength={40} />
              </label>
              <button className="primary-action" type="submit"><Check size={18} />Save Profile</button>
            </form>
          </section>
        )}

        {/* === Settings Screen === */}
        {screen === "settings" && (
          <section className="screen stack">
            <h2>Settings</h2>
            <div className="theme-color-section">
              <span className="theme-toggle-label" style={{ display: "block", marginBottom: "8px" }}>Theme Color</span>
              <div className="theme-color-row" style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                {["5B8C5A", "26547C", "96616B", "83BCA9", "3E5641", "D4B483"].map(color => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setThemeColor(color)}
                    style={{
                      width: "36px",
                      height: "36px",
                      borderRadius: "50%",
                      backgroundColor: `#${color}`,
                      border: themeColor === color ? "3px solid var(--text-primary)" : "1px solid var(--border)",
                      cursor: "pointer",
                      boxShadow: themeColor === color ? "0 0 8px rgba(0,0,0,0.2)" : "none",
                      padding: 0,
                      transition: "transform 0.1s, border-color 0.1s"
                    }}
                    title={`#${color}`}
                    aria-label={`Theme color #${color}`}
                  />
                ))}
              </div>
            </div>
            <div className="theme-toggle">
              <span className="theme-toggle-label">Dark Mode</span>
              <button type="button" className={`toggle-switch ${darkMode ? "active" : ""}`} onClick={() => setDarkMode(!darkMode)} aria-label="Toggle dark mode" />
            </div>
            <div className="theme-toggle">
              <span className="theme-toggle-label">Auto Connect (Known Devices)</span>
              <button type="button" className={`toggle-switch ${autoConnect ? "active" : ""}`} onClick={() => {
                const next = !autoConnect;
                setAutoConnect(next);
                localStorage.setItem("ping2peer.autoConnect", String(next));
              }} aria-label="Toggle auto connect" />
            </div>
             <div className="theme-toggle">
              <span className="theme-toggle-label">Custom Signal Server</span>
              <button type="button" className={`toggle-switch ${customSignalServer ? "active" : ""}`} onClick={() => {
                const next = !customSignalServer;
                setCustomSignalServer(next);
                localStorage.setItem("ping2peer.customSignalServer", String(next));
                if (!next) {
                  // Revert immediately to default
                  setSignalServerUrl(DEFAULT_SIGNAL_SERVER);
                  localStorage.setItem(signalServerStorageKey, DEFAULT_SIGNAL_SERVER);
                  if (profile) {
                    signallingProvider.disconnect();
                    signallingProvider.connect(DEFAULT_SIGNAL_SERVER, profile);
                  }
                  setNotice("Signal server reverted to default");
                }
              }} aria-label="Toggle custom signal server" />
            </div>
            {customSignalServer && (
              <form onSubmit={saveSettings} className="stack">
                <label>
                  Signal Server URL
                  <input value={signalServerUrl} onChange={(e) => setSignalServerUrl(e.target.value)} required />
                </label>
                <button className="primary-action" type="submit">Save</button>
              </form>
            )}
            <hr className="settings-divider" />
            <h3>Manual Pairing Fallback</h3>
            <div className="action-row">
              <button onClick={() => setScreen("create")}><Link size={18} />Create</button>
              <button onClick={() => setScreen("join")}><Smartphone size={18} />Join</button>
            </div>
          </section>
        )}

        {/* === Create / Join Screens === */}
        {screen === "create" && (
          <section className="screen stack">
            <button className="primary-action" onClick={() => void createInvite()}><Link size={18} />Create invite</button>
            <QrPanel value={pairingUrl("invite", inviteCode)} label="Invite QR" />
            <CodeBox value={inviteCode} onChange={setInviteCode} placeholder="Invite code" onCopy={copy} />
            <QrPanel value={pairingUrl("answer", answerCode)} label="Answer QR" />
            <CodeBox value={answerCode} onChange={setAnswerCode} placeholder="Answer code" onCopy={copy} />
            <button className="primary-action" onClick={() => void applyAnswer()} disabled={!inviteCode || !answerCode}><Check size={18} />Connect</button>
          </section>
        )}

        {screen === "join" && (
          <section className="screen stack">
            <CodeBox value={joinCode} onChange={setJoinCode} placeholder="Invite code" onCopy={copy} />
            <button className="primary-action" onClick={() => void joinInvite()} disabled={!joinCode}><Check size={18} />Generate answer</button>
            <QrPanel value={pairingUrl("answer", joinAnswerCode)} label="Answer QR" />
            <CodeBox value={joinAnswerCode} onChange={setJoinAnswerCode} placeholder="Answer code" onCopy={copy} />
            {joinAnswerCode && activeChatId && (
              <button className="primary-action" onClick={() => setScreen("chat")}><MessageCircle size={18} />Open chat</button>
            )}
          </section>
        )}

        {/* === Chat Screen === */}
        {screen === "chat" && activeChat && (
          <section className="chat-screen">
            <div className="messages">

              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  isOwn={message.senderPeerId === profile.peerId}
                  allMessages={messages}
                  onReply={() => setReplyingTo(message)}
                  onRetry={() => void retryMessage(message)}
                  onReaction={(emoji) => handleReaction(message.id, emoji)}
                  showPicker={pickerMessageId === message.id}
                  onTogglePicker={() => setPickerMessageId(pickerMessageId === message.id ? null : message.id)}
                />
              ))}
            </div>

            {replyingTo && (
              <div className="reply-preview">
                <div className="reply-preview-text">Replying to: {replyingTo.body}</div>
                <button className="reply-preview-close" onClick={() => setReplyingTo(null)}><X size={16} /></button>
              </div>
            )}

            <form className="composer" onSubmit={sendMessage}>
              <input 
                value={messageText} 
                onChange={(e) => setMessageText(e.target.value)} 
                placeholder={connectionState === "connected" ? "Message" : "Waiting for connection..."}
                disabled={connectionState !== "connected"} 
              />
              <button className="send-button" type="submit" aria-label="Send" disabled={connectionState !== "connected"}><IoSend size={20} /></button>
            </form>
          </section>
        )}
      </div>

      {/* === Mobile Bottom Tabs === */}
      {screen !== "chat" && (
        <nav className="bottom-tabs">
          {navItems.map(item => (
            <button key={item.id} className={`bottom-tab ${currentNav === item.id ? "active" : ""}`} onClick={() => setScreen(item.id)}>
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      )}
    </main>
  );
}

// === Sub-Components ===

function MessageBubble({
  message, isOwn, allMessages, onReply, onRetry, onReaction, showPicker, onTogglePicker
}: {
  message: PlainMessage;
  isOwn: boolean;
  allMessages: PlainMessage[];
  onReply: () => void;
  onRetry: () => void;
  onReaction: (emoji: string) => void;
  showPicker: boolean;
  onTogglePicker: () => void;
}) {
  const swipeRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const currentXRef = useRef(0);

  const handleTouchStart = (e: ReactTouchEvent) => {
    startXRef.current = e.touches[0].clientX;
    currentXRef.current = 0;
  };

  const handleTouchMove = (e: ReactTouchEvent) => {
    const diff = e.touches[0].clientX - startXRef.current;
    if (diff > 0 && swipeRef.current) {
      currentXRef.current = Math.min(diff, 80);
      swipeRef.current.style.transform = `translateX(${currentXRef.current}px)`;
    }
  };

  const handleTouchEnd = () => {
    if (currentXRef.current > 60) {
      onReply();
    }
    if (swipeRef.current) {
      swipeRef.current.style.transform = "translateX(0)";
    }
    currentXRef.current = 0;
  };

  const replyMsg = message.replyToId ? allMessages.find(m => m.id === message.replyToId) : null;
  const reactions = message.reactions ?? {};
  const hasReactions = Object.keys(reactions).length > 0;

  return (
    <div
      className={`message-swipe-wrapper ${isOwn ? "wrapper-own" : "wrapper-peer"}`}
      ref={swipeRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <article className={`message ${isOwn ? "message-own" : "message-peer"}`}>
        <button className="message-reply-btn" onClick={onReply} aria-label="Reply"><CornerUpLeft size={14} /></button>
        <button className="reaction-trigger" onClick={onTogglePicker} aria-label="React">😊</button>
        {showPicker && (
          <div className="reaction-picker" style={isOwn ? { right: 0, bottom: "100%" } : { left: 0, bottom: "100%" }}>
            {REACTION_EMOJIS.map(emoji => (
              <button key={emoji} type="button" onClick={() => onReaction(emoji)}>{emoji}</button>
            ))}
          </div>
        )}

        {replyMsg && (
          <div className="message-reply-quote">{replyMsg.body}</div>
        )}

        <p>{message.body}</p>

        <div className="message-footer">
          <span className="message-time">{formatTime(message.sentAt)}</span>
          {isOwn && (
            <span className={`message-status ${message.deliveryState === "failed" ? "failed" : ""}`}
              onClick={message.deliveryState === "failed" ? onRetry : undefined}
              title={message.deliveryState === "failed" ? "Tap to retry" : message.deliveryState}
            >
              {message.deliveryState === "sent" && <IoCheckmark />}
              {message.deliveryState === "received" && <IoCheckmark />}
              {message.deliveryState === "sending" && <IoTimeOutline />}
              {message.deliveryState === "failed" && <IoAlertCircle />}
            </span>
          )}
        </div>

        {hasReactions && (
          <div className="message-reactions">
            {Object.entries(reactions).map(([emoji, peerIds]) => (
              <span className="reaction-badge" key={emoji}>
                {emoji} <span className="reaction-count">{peerIds.length}</span>
              </span>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}

function QrPanel({ value, label }: { value: string; label: string }) {
  if (!value) return null;
  return (
    <section className="qr-panel" aria-label={label}>
      <QRCodeSVG value={value} size={228} level="M" includeMargin />
      <span>{label}</span>
    </section>
  );
}

function CodeBox({
  value, onChange, placeholder, onCopy
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onCopy: (value: string) => void;
}) {
  return (
    <label className="code-box">
      <span>{placeholder}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <button type="button" onClick={() => void onCopy(value)} disabled={!value}>
        <Clipboard size={18} />
        Copy
      </button>
    </label>
  );
}

// === Utilities ===

function defaultDeviceName(): string {
  const platform = navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.userAgent.includes("Android") ? "Android" : "Web";
  return `${platform} device`;
}

function createTransport(payload?: PairingPayload): PeerTransport {
  if (payload?.signal.sdp?.startsWith("relay:") || !window.isSecureContext || typeof RTCPeerConnection === "undefined") {
    return new RelayTextTransport();
  }
  return new WebRtcDataChannelTransport();
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function pairingUrl(kind: PairingKind, code: string): string {
  if (!code) return "";
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.hash = `${kind}=${encodeURIComponent(code)}`;
  return url.toString();
}

function clearPairingUrl(): void {
  window.history.replaceState({}, "", window.location.pathname);
}

function pairingFromUrl(): { kind: PairingKind; code: string } | undefined {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const invite = hash.get("invite") ?? url.searchParams.get("invite");
  if (invite) return { kind: "invite", code: invite };
  const answer = hash.get("answer") ?? url.searchParams.get("answer");
  if (answer) return { kind: "answer", code: answer };
  return undefined;
}

function createPairingChannel(): BroadcastChannel | undefined {
  if (!("BroadcastChannel" in window)) return undefined;
  return new BroadcastChannel(pairingChannelName);
}

function sendPairingToExistingTab(handoff: PairingHandoff, channel: BroadcastChannel | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const timeout = window.setTimeout(() => {
      if (!resolved) { resolved = true; resolve(false); }
    }, 700);
    const finish = () => {
      if (resolved) return;
      resolved = true;
      window.clearTimeout(timeout);
      resolve(true);
    };
    const onChannelMessage = (event: MessageEvent<PairingHandoff>) => {
      if (event.data.type === "ack" && event.data.id === handoff.id) finish();
    };
    const onStorageMessage = (event: StorageEvent) => {
      if (event.key !== pairingHandoffStorageKey || !event.newValue) return;
      const message = JSON.parse(event.newValue) as PairingHandoff;
      if (message.type === "ack" && message.id === handoff.id) finish();
    };
    channel?.addEventListener("message", onChannelMessage);
    window.addEventListener("storage", onStorageMessage);
    channel?.postMessage(handoff);
    localStorage.setItem(pairingHandoffStorageKey, JSON.stringify(handoff));
    window.setTimeout(() => {
      channel?.removeEventListener("message", onChannelMessage);
      window.removeEventListener("storage", onStorageMessage);
    }, 800);
  });
}
