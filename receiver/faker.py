"""
Runs on the "fake beacon" laptop. Sends scene triggers ("SCENE_1",
"SCENE_2") over UDP, HMAC-signed so the receiver can verify the packet
came from someone holding the shared secret rather than accepting any
UDP packet at face value.

Wire format: "<scene>|<hex_hmac>"
  hex_hmac = HMAC-SHA256(KEY, scene.encode()), truncated to 16 hex chars (8 bytes)

Update RECEIVER_IP to the LAN/Wi-Fi IP address of the laptop running
receiver_packet_merged.py (find it with `ipconfig` on that machine).

HMAC_KEY must match the receiver's HMAC_KEY exactly, or every packet
will be rejected as unverified.
"""

import hmac
import hashlib
import socket
import sys

RECEIVER_IP = "192.168.1.50"  # <-- set this to the receiver laptop's IP
UDP_PORT = 9999               # must match receiver_packet_merged.py

# Shared secret — must match HMAC_KEY in receiver_packet_merged.py exactly.
# In a real deployment, load this from an env var / secrets file, not a
# literal in source.
HMAC_KEY = b"wayfinder-dev-shared-secret"

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def sign(scene: str) -> str:
    digest = hmac.new(HMAC_KEY, scene.encode("utf-8"), hashlib.sha256).digest()
    return digest[:8].hex()  # 8 bytes -> 16 hex chars


def send_scene(scene: str):
    packet = f"{scene}|{sign(scene)}"
    sock.sendto(packet.encode("utf-8"), (RECEIVER_IP, UDP_PORT))
    print(f"Sent: {packet} -> {RECEIVER_IP}:{UDP_PORT}")


if __name__ == "__main__":
    print("Fake beacon sender ready (HMAC-signed).")
    print("Press 1 + Enter to send SCENE_1, 2 + Enter to send SCENE_2, q to quit.")
    print(f"Target: {RECEIVER_IP}:{UDP_PORT}")

    while True:
        choice = input("> ").strip()
        if choice == "1":
            send_scene("SCENE_1")
        elif choice == "2":
            send_scene("SCENE_2")
        elif choice == "q":
            sys.exit(0)
        else:
            print("Enter 1, 2, or q")