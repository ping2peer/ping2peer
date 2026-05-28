"""
Ping2Peer signalling protocol logic.

This module contains the pure protocol logic shared by both the AWS Lambda
handler and the self-hosted local server. It has no I/O — callers are
responsible for storing peers and delivering messages.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from typing import Any


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PeerInfo:
    """A peer visible in the signalling server."""
    peer_id: str
    display_name: str
    device_name: str

    def to_dict(self) -> dict[str, str]:
        return {
            "peerId": self.peer_id,
            "displayName": self.display_name,
            "deviceName": self.device_name,
        }


@dataclass
class ConnectedPeer:
    """Internal record for a connected WebSocket client."""
    connection_id: str
    peer_info: PeerInfo
    network_group: str


# ---------------------------------------------------------------------------
# Outbound message helpers
# ---------------------------------------------------------------------------

def msg_peers(peers: list[PeerInfo]) -> str:
    """Build a 'peers' message (full peer list)."""
    return json.dumps({
        "type": "peers",
        "peers": [p.to_dict() for p in peers],
    })


def msg_peer_joined(peer: PeerInfo) -> str:
    return json.dumps({
        "type": "peer-joined",
        "peer": peer.to_dict(),
    })


def msg_peer_left(peer_id: str) -> str:
    return json.dumps({
        "type": "peer-left",
        "peerId": peer_id,
    })


def msg_connect_request(from_peer: PeerInfo) -> str:
    return json.dumps({
        "type": "connect-request",
        "from": from_peer.to_dict(),
    })


def msg_connect_accepted(from_peer_id: str) -> str:
    return json.dumps({
        "type": "connect-accepted",
        "from": from_peer_id,
    })


def msg_connect_rejected(from_peer_id: str) -> str:
    return json.dumps({
        "type": "connect-rejected",
        "from": from_peer_id,
    })


def msg_webrtc_offer(from_peer_id: str, signal: Any) -> str:
    return json.dumps({
        "type": "webrtc-offer",
        "from": from_peer_id,
        "signal": signal,
    })


def msg_webrtc_answer(from_peer_id: str, signal: Any) -> str:
    return json.dumps({
        "type": "webrtc-answer",
        "from": from_peer_id,
        "signal": signal,
    })


def msg_error(message: str) -> str:
    return json.dumps({
        "type": "error",
        "message": message,
    })


# ---------------------------------------------------------------------------
# Outbound action
# ---------------------------------------------------------------------------

@dataclass
class Outbound:
    """A message to be sent to a specific connection."""
    connection_id: str
    body: str


# ---------------------------------------------------------------------------
# PeerRegistry — in-memory implementation
# ---------------------------------------------------------------------------

class PeerRegistry:
    """
    Manages connected peers grouped by network.

    This is used directly by the local server. The Lambda handler uses
    DynamoDB for persistence but calls the same message-building helpers.
    """

    def __init__(self) -> None:
        # connection_id -> ConnectedPeer
        self._connections: dict[str, ConnectedPeer] = {}
        # peer_id -> connection_id (reverse lookup)
        self._peer_to_conn: dict[str, str] = {}

    def register(
        self,
        connection_id: str,
        peer_info: PeerInfo,
        network_group: str,
    ) -> list[Outbound]:
        """
        Register a peer. Returns outbound messages:
        - 'peers' list sent to the new peer
        - 'peer-joined' broadcast to all existing peers in the same network group
        """
        # Remove any stale connection for the same peerId
        if peer_info.peer_id in self._peer_to_conn:
            old_conn = self._peer_to_conn[peer_info.peer_id]
            if old_conn in self._connections:
                del self._connections[old_conn]
            del self._peer_to_conn[peer_info.peer_id]

        connected = ConnectedPeer(
            connection_id=connection_id,
            peer_info=peer_info,
            network_group=network_group,
        )
        self._connections[connection_id] = connected
        self._peer_to_conn[peer_info.peer_id] = connection_id

        # Build outbound messages
        outbound: list[Outbound] = []

        # Collect existing peers in the same network group (excluding the new one)
        group_peers = self._group_peers(network_group, exclude_conn=connection_id)

        # Send full peer list to the newly registered peer
        outbound.append(Outbound(
            connection_id=connection_id,
            body=msg_peers([cp.peer_info for cp in group_peers]),
        ))

        # Notify existing peers about the new arrival
        joined_msg = msg_peer_joined(peer_info)
        for cp in group_peers:
            outbound.append(Outbound(connection_id=cp.connection_id, body=joined_msg))

        return outbound

    def unregister(self, connection_id: str) -> list[Outbound]:
        """
        Remove a peer by connection_id. Returns 'peer-left' messages
        to broadcast to the remaining peers in the same network group.
        """
        connected = self._connections.pop(connection_id, None)
        if connected is None:
            return []

        self._peer_to_conn.pop(connected.peer_info.peer_id, None)

        outbound: list[Outbound] = []
        left_msg = msg_peer_left(connected.peer_info.peer_id)
        for cp in self._group_peers(connected.network_group):
            outbound.append(Outbound(connection_id=cp.connection_id, body=left_msg))

        return outbound

    def route_message(self, connection_id: str, raw: str) -> list[Outbound]:
        """
        Route a client message to the appropriate target peer.
        Handles: connect-request, connect-accepted, connect-rejected,
                 webrtc-offer, webrtc-answer.
        """
        sender = self._connections.get(connection_id)
        if sender is None:
            return [Outbound(connection_id=connection_id, body=msg_error("Not registered"))]

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return [Outbound(connection_id=connection_id, body=msg_error("Invalid JSON"))]

        msg_type = data.get("type")

        if msg_type == "register":
            # Re-registration (update display name / device name)
            peer_info = PeerInfo(
                peer_id=data.get("peerId", sender.peer_info.peer_id),
                display_name=data.get("displayName", sender.peer_info.display_name),
                device_name=data.get("deviceName", sender.peer_info.device_name),
            )
            network_group = sender.network_group
            # Unregister old, register new
            self.unregister(connection_id)
            return self.register(connection_id, peer_info, network_group)

        target_peer_id = data.get("to")
        if not target_peer_id:
            return [Outbound(connection_id=connection_id, body=msg_error("Missing 'to' field"))]

        target_conn_id = self._peer_to_conn.get(target_peer_id)
        if not target_conn_id:
            return [Outbound(connection_id=connection_id, body=msg_error("Peer not found"))]

        sender_info = sender.peer_info

        if msg_type == "connect-request":
            return [Outbound(
                connection_id=target_conn_id,
                body=msg_connect_request(sender_info),
            )]

        if msg_type == "connect-accepted":
            return [Outbound(
                connection_id=target_conn_id,
                body=msg_connect_accepted(sender_info.peer_id),
            )]

        if msg_type == "connect-rejected":
            return [Outbound(
                connection_id=target_conn_id,
                body=msg_connect_rejected(sender_info.peer_id),
            )]

        if msg_type == "webrtc-offer":
            return [Outbound(
                connection_id=target_conn_id,
                body=msg_webrtc_offer(sender_info.peer_id, data.get("signal")),
            )]

        if msg_type == "webrtc-answer":
            return [Outbound(
                connection_id=target_conn_id,
                body=msg_webrtc_answer(sender_info.peer_id, data.get("signal")),
            )]

        return [Outbound(connection_id=connection_id, body=msg_error(f"Unknown message type: {msg_type}"))]

    def get_peer_by_connection(self, connection_id: str) -> ConnectedPeer | None:
        return self._connections.get(connection_id)

    def _group_peers(
        self,
        network_group: str,
        exclude_conn: str | None = None,
    ) -> list[ConnectedPeer]:
        return [
            cp for cp in self._connections.values()
            if cp.network_group == network_group and cp.connection_id != exclude_conn
        ]
