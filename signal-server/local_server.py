"""
Self-hosted Ping2Peer signalling server.

A standalone asyncio WebSocket server that can be run on a local network.
Uses the shared signalling protocol logic with an in-memory peer registry.

Usage:
    python local_server.py                     # Default port 8080, bind 0.0.0.0
    python local_server.py --port 9090         # Custom port
    python local_server.py --host 127.0.0.1    # Bind to localhost only
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging

try:
    import websockets
    from websockets.asyncio.server import serve, ServerConnection
except ImportError:
    print("Error: 'websockets' package is required.")
    print("Install it with: pip install websockets")
    raise SystemExit(1)

from signalling import PeerInfo, PeerRegistry, Outbound

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("ping2peer-signal")

# ---------------------------------------------------------------------------
# Server state
# ---------------------------------------------------------------------------

registry = PeerRegistry()
# connection (websocket) -> connection_id
connections: dict[ServerConnection, str] = {}
# connection_id -> websocket (reverse lookup for message delivery)
conn_id_to_ws: dict[str, ServerConnection] = {}
_next_id = 0


def _generate_connection_id() -> str:
    global _next_id
    _next_id += 1
    return f"local-{_next_id}"


def _hash_ip(ip: str) -> str:
    """Hash the client IP to create a network group key."""
    if ip == "::1":
        ip = "127.0.0.1"
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


# For a self-hosted local server, all connected clients should see each
# other.  Using a fixed group avoids the problem where the Vite HTTPS
# proxy masks the real client IP (all connections appear from 127.0.0.1
# or ::1), making IP-based grouping unreliable.
FIXED_LOCAL_GROUP = "local-network"


# ---------------------------------------------------------------------------
# Message delivery
# ---------------------------------------------------------------------------

async def deliver(outbound_messages: list[Outbound]) -> None:
    """Send outbound messages to their target WebSocket connections."""
    for msg in outbound_messages:
        ws = conn_id_to_ws.get(msg.connection_id)
        if ws is not None:
            try:
                await ws.send(msg.body)
            except websockets.exceptions.ConnectionClosed:
                pass


# ---------------------------------------------------------------------------
# WebSocket handler
# ---------------------------------------------------------------------------

async def handle_client(websocket: ServerConnection) -> None:
    """Handle a single WebSocket client connection."""
    connection_id = _generate_connection_id()

    # Use a single fixed group so all clients on this local server can
    # discover each other.
    remote = websocket.remote_address
    client_ip = remote[0] if remote else "unknown"
    network_group = FIXED_LOCAL_GROUP

    connections[websocket] = connection_id
    conn_id_to_ws[connection_id] = websocket

    logger.info("Client connected: %s (ip=%s, group=%s)", connection_id, client_ip, network_group)

    try:
        async for raw_message in websocket:
            if isinstance(raw_message, bytes):
                raw_message = raw_message.decode("utf-8")

            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send(json.dumps({"type": "error", "message": "Invalid JSON"}))
                continue

            msg_type = data.get("type")

            if msg_type == "register":
                peer_info = PeerInfo(
                    peer_id=data.get("peerId", ""),
                    display_name=data.get("displayName", ""),
                    device_name=data.get("deviceName", ""),
                )
                if not peer_info.peer_id or not peer_info.display_name:
                    await websocket.send(json.dumps({"type": "error", "message": "Missing peerId or displayName"}))
                    continue

                outbound = registry.register(connection_id, peer_info, network_group)
                await deliver(outbound)
                logger.info("Registered: %s (%s)", peer_info.display_name, peer_info.peer_id)
            else:
                outbound = registry.route_message(connection_id, raw_message)
                await deliver(outbound)

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        outbound = registry.unregister(connection_id)
        await deliver(outbound)
        connections.pop(websocket, None)
        conn_id_to_ws.pop(connection_id, None)
        logger.info("Client disconnected: %s", connection_id)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main(host: str, port: int) -> None:
    logger.info("Ping2Peer signalling server starting on ws://%s:%d", host, port)

    async with serve(handle_client, host, port) as server:
        logger.info("Signalling server is ready. Press Ctrl+C to stop.")
        await asyncio.get_running_loop().create_future()  # Run forever


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ping2Peer self-hosted signalling server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080, help="Port to listen on (default: 8080)")
    args = parser.parse_args()

    try:
        asyncio.run(main(args.host, args.port))
    except KeyboardInterrupt:
        logger.info("Server stopped.")
