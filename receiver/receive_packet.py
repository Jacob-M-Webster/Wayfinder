import json
import socket
import threading
import time

import pyautogui
from websockets.sync.server import serve

# --- Wireless (UDP) settings, replaces the COM_PORT/serial connection ---
UDP_HOST = "0.0.0.0"     # listen on all interfaces
UDP_PORT = 9999          # pick any free port; must match the sender

WEBSOCKET_PORT = 8765
WEBSOCKET_HOST = "0.0.0.0"
websocket_clients = set()
websocket_clients_lock = threading.Lock()


def handle_websocket_client(websocket):
    with websocket_clients_lock:
        websocket_clients.add(websocket)
    try:
        for _ in websocket:
            pass
    finally:
        with websocket_clients_lock:
            websocket_clients.discard(websocket)


def run_websocket_server():
    with serve(handle_websocket_client, WEBSOCKET_HOST, WEBSOCKET_PORT) as server:
        print(f"WebSocket server listening on ws://{WEBSOCKET_HOST}:{WEBSOCKET_PORT}")
        server.serve_forever()


def broadcast_scene(scene):
    message = json.dumps({"type": "scene", "scene": scene})
    with websocket_clients_lock:
        clients = tuple(websocket_clients)

    for client in clients:
        try:
            client.send(message)
        except Exception:
            with websocket_clients_lock:
                websocket_clients.discard(client)


def handle_line(line: str):
    """Same dispatch logic you already had — now called from the UDP loop
    instead of the serial loop, so nothing downstream needs to change."""
    print(f"Received raw packet: {line}")

    if line == "SCENE_1":
        print("[!] Sequence Start detected -> Triggering Scene 1")
        pyautogui.press('1')
        broadcast_scene(line)

    elif line == "SCENE_2":
        print("[!] Outage detected -> Triggering Scene 2")
        pyautogui.press('2')
        broadcast_scene(line)


if __name__ == "__main__":
    threading.Thread(target=run_websocket_server, daemon=True).start()

    print(f"Listening for wireless (UDP) packets on {UDP_HOST}:{UDP_PORT}...")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((UDP_HOST, UDP_PORT))

    try:
        while True:
            try:
                data, addr = sock.recvfrom(1024)  # blocks until a packet arrives
                line = data.decode('utf-8', errors='ignore').strip()

                if not line:
                    continue

                handle_line(line)

            except Exception as e:
                print(f"UDP read error: {e}")
                break
    finally:
        sock.close()