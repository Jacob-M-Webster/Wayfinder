"""
Runs on the "fake beacon" laptop. Sends the same plain-text scene triggers
("SCENE_1", "SCENE_2") that the real M5Stack sends over serial — just over
UDP on the wireless network instead.

Update RECEIVER_IP to the LAN/Wi-Fi IP address of the laptop running
receiver_packet_wireless.py (find it with `ipconfig` on that machine).
"""

import socket
import sys
import time

RECEIVER_IP = "10.108.80.184"  # <-- set this to Laptop B's IP address
UDP_PORT = 9999               # must match receiver_packet_wireless.py

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def send_scene(scene: str):
    sock.sendto(scene.encode("utf-8"), (RECEIVER_IP, UDP_PORT))
    print(f"Sent: {scene} -> {RECEIVER_IP}:{UDP_PORT}")


if __name__ == "__main__":
    print("Fake beacon sender ready.")
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