"""
AWS Lambda handler for the Ping2Peer signalling server.

Handles API Gateway WebSocket events: $connect, $disconnect, $default.
Uses DynamoDB for peer state and the API Gateway Management API to push
messages to connected clients.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Data types & Outbound message helpers
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
class Outbound:
    """A message to be sent to a specific connection."""
    connection_id: str
    body: str

def msg_peers(peers: list[PeerInfo]) -> str:
    return json.dumps({"type": "peers", "peers": [p.to_dict() for p in peers]})

def msg_peer_joined(peer: PeerInfo) -> str:
    return json.dumps({"type": "peer-joined", "peer": peer.to_dict()})

def msg_peer_left(peer_id: str) -> str:
    return json.dumps({"type": "peer-left", "peerId": peer_id})

def msg_connect_request(from_peer: PeerInfo) -> str:
    return json.dumps({"type": "connect-request", "from": from_peer.to_dict()})

def msg_connect_accepted(from_peer_id: str) -> str:
    return json.dumps({"type": "connect-accepted", "from": from_peer_id})

def msg_connect_rejected(from_peer_id: str) -> str:
    return json.dumps({"type": "connect-rejected", "from": from_peer_id})

def msg_webrtc_offer(from_peer_id: str, signal: Any) -> str:
    return json.dumps({"type": "webrtc-offer", "from": from_peer_id, "signal": signal})

def msg_webrtc_answer(from_peer_id: str, signal: Any) -> str:
    return json.dumps({"type": "webrtc-answer", "from": from_peer_id, "signal": signal})

def msg_error(message: str) -> str:
    return json.dumps({"type": "error", "message": message})

# ---------------------------------------------------------------------------
# AWS clients
# ---------------------------------------------------------------------------

TABLE_NAME = "Ping2Peer-connections"
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)

_apigw_client: Any = None


def _get_apigw_client(event: dict) -> Any:
    """Lazily create the API Gateway Management API client."""
    global _apigw_client
    if _apigw_client is None:
        domain = event["requestContext"]["domainName"]
        stage = event["requestContext"]["stage"]
        _apigw_client = boto3.client(
            "apigatewaymanagementapi",
            endpoint_url=f"https://{domain}/{stage}",
        )
    return _apigw_client


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hash_ip(source_ip: str) -> str:
    """Hash the source IP to create a network group key."""
    return hashlib.sha256(source_ip.encode()).hexdigest()[:16]


def _post_to_connection(apigw: Any, connection_id: str, data: str) -> bool:
    """
    Send a message to a connected WebSocket client.
    Returns False if the connection is gone (GoneException).
    """
    try:
        apigw.post_to_connection(
            ConnectionId=connection_id,
            Data=data.encode("utf-8"),
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "GoneException":
            # Connection is stale — clean up
            _remove_connection(connection_id)
            return False
        raise


def _deliver(apigw: Any, outbound_messages: list[Outbound]) -> None:
    """Deliver a list of outbound messages to their target connections."""
    for msg in outbound_messages:
        _post_to_connection(apigw, msg.connection_id, msg.body)


def _remove_connection(connection_id: str) -> None:
    """Remove a connection record from DynamoDB."""
    try:
        table.delete_item(Key={"connectionId": connection_id})
    except ClientError:
        pass  # Best-effort cleanup


def _get_connection(connection_id: str) -> dict | None:
    """Retrieve a connection record from DynamoDB."""
    resp = table.get_item(Key={"connectionId": connection_id})
    return resp.get("Item")


def _get_group_peers(network_group: str, exclude_conn: str | None = None) -> list[dict]:
    """Query all connections in the same network group."""
    resp = table.query(
        IndexName="networkGroup-index",
        KeyConditionExpression=boto3.dynamodb.conditions.Key("networkGroup").eq(network_group),
    )
    items = resp.get("Items", [])
    if exclude_conn:
        items = [i for i in items if i["connectionId"] != exclude_conn]
    return items


def _item_to_peer_info(item: dict) -> PeerInfo:
    return PeerInfo(
        peer_id=item["peerId"],
        display_name=item["displayName"],
        device_name=item["deviceName"],
    )


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

def handle_connect(event: dict) -> dict:
    """Handle $connect — store connection with source IP for network grouping."""
    connection_id = event["requestContext"]["connectionId"]
    source_ip = event["requestContext"].get("identity", {}).get("sourceIp", "unknown")
    network_group = _hash_ip(source_ip)

    # Store a placeholder — full peer info comes with the 'register' message
    table.put_item(Item={
        "connectionId": connection_id,
        "networkGroup": network_group,
        "peerId": "",
        "displayName": "",
        "deviceName": "",
        "registered": False,
    })

    return {"statusCode": 200}


def handle_disconnect(event: dict) -> dict:
    """Handle $disconnect — remove peer and notify others."""
    connection_id = event["requestContext"]["connectionId"]
    apigw = _get_apigw_client(event)

    item = _get_connection(connection_id)
    if item and item.get("registered"):
        network_group = item["networkGroup"]
        peer_id = item["peerId"]

        # Notify remaining peers in the same group
        group_peers = _get_group_peers(network_group, exclude_conn=connection_id)
        left_msg = msg_peer_left(peer_id)
        for peer_item in group_peers:
            if peer_item.get("registered"):
                _post_to_connection(apigw, peer_item["connectionId"], left_msg)

    _remove_connection(connection_id)
    return {"statusCode": 200}


def handle_default(event: dict) -> dict:
    """Handle $default — process all signalling messages."""
    connection_id = event["requestContext"]["connectionId"]
    apigw = _get_apigw_client(event)
    body = event.get("body", "")

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        _post_to_connection(apigw, connection_id, msg_error("Invalid JSON"))
        return {"statusCode": 400}

    msg_type = data.get("type")

    if msg_type == "register":
        return _handle_register(apigw, connection_id, data)

    # All other message types require the sender to be registered
    item = _get_connection(connection_id)
    if not item or not item.get("registered"):
        _post_to_connection(apigw, connection_id, msg_error("Not registered. Send a 'register' message first."))
        return {"statusCode": 400}

    target_peer_id = data.get("to")
    if not target_peer_id:
        _post_to_connection(apigw, connection_id, msg_error("Missing 'to' field"))
        return {"statusCode": 400}

    # Look up the target peer's connection
    target_item = _find_peer_connection(target_peer_id, item["networkGroup"])
    if not target_item:
        _post_to_connection(apigw, connection_id, msg_error("Peer not found"))
        return {"statusCode": 404}

    target_conn_id = target_item["connectionId"]
    sender_info = _item_to_peer_info(item)

    if msg_type == "connect-request":
        _post_to_connection(apigw, target_conn_id, msg_connect_request(sender_info))
    elif msg_type == "connect-accepted":
        _post_to_connection(apigw, target_conn_id, msg_connect_accepted(sender_info.peer_id))
    elif msg_type == "connect-rejected":
        _post_to_connection(apigw, target_conn_id, msg_connect_rejected(sender_info.peer_id))
    elif msg_type == "webrtc-offer":
        _post_to_connection(apigw, target_conn_id, msg_webrtc_offer(sender_info.peer_id, data.get("signal")))
    elif msg_type == "webrtc-answer":
        _post_to_connection(apigw, target_conn_id, msg_webrtc_answer(sender_info.peer_id, data.get("signal")))
    else:
        _post_to_connection(apigw, connection_id, msg_error(f"Unknown message type: {msg_type}"))
        return {"statusCode": 400}

    return {"statusCode": 200}


def _handle_register(apigw: Any, connection_id: str, data: dict) -> dict:
    """Handle the 'register' message — update peer info and notify the group."""
    peer_id = data.get("peerId", "")
    display_name = data.get("displayName", "")
    device_name = data.get("deviceName", "")

    if not peer_id or not display_name:
        _post_to_connection(apigw, connection_id, msg_error("Missing peerId or displayName"))
        return {"statusCode": 400}

    # Get the existing connection record (created in $connect with networkGroup)
    item = _get_connection(connection_id)
    if not item:
        _post_to_connection(apigw, connection_id, msg_error("Connection not found"))
        return {"statusCode": 400}

    network_group = item["networkGroup"]

    # Update the connection record with full peer info
    table.put_item(Item={
        "connectionId": connection_id,
        "networkGroup": network_group,
        "peerId": peer_id,
        "displayName": display_name,
        "deviceName": device_name,
        "registered": True,
    })

    # Send the current peer list to the newly registered peer
    group_peers = _get_group_peers(network_group, exclude_conn=connection_id)
    registered_peers = [_item_to_peer_info(p) for p in group_peers if p.get("registered")]
    _post_to_connection(apigw, connection_id, msg_peers(registered_peers))

    # Notify existing peers about the new arrival
    new_peer_info = PeerInfo(peer_id=peer_id, display_name=display_name, device_name=device_name)
    joined_msg = msg_peer_joined(new_peer_info)
    for peer_item in group_peers:
        if peer_item.get("registered"):
            _post_to_connection(apigw, peer_item["connectionId"], joined_msg)

    return {"statusCode": 200}


def _find_peer_connection(peer_id: str, network_group: str) -> dict | None:
    """Find a connected peer by peerId within the same network group."""
    group_peers = _get_group_peers(network_group)
    for item in group_peers:
        if item.get("peerId") == peer_id and item.get("registered"):
            return item
    return None


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------

def handler(event: dict, context: Any) -> dict:
    """Main Lambda handler dispatching to route handlers."""
    route_key = event["requestContext"].get("routeKey", "$default")

    if route_key == "$connect":
        return handle_connect(event)
    elif route_key == "$disconnect":
        return handle_disconnect(event)
    else:
        return handle_default(event)
