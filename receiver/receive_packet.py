import hmac
import hashlib
import json
import socket
import threading
import time

import serial
import pyautogui
from websockets.sync.server import serve

# --- Serial (real M5Stack beacon) settings ---
COM_PORT = "COM4"
BAUD_RATE = 115200

# --- UDP (fake / simulated beacon, e.g. Laptop A/B) settings ---
UDP_HOST = "0.0.0.0"   # listen on all interfaces
UDP_PORT = 9999        # must match the sender

# Shared secret — must match HMAC_KEY in fake_beacon_sender.py exactly.
# Only packets signed with this key are treated as a legitimate simulated
# beacon; anything else is rejected outright (not even tagged "sim").
HMAC_KEY = b"wayfinder-dev-shared-secret"


def verify_udp_packet(raw: str):
    """Parses '<scene>|<hex_hmac>' and verifies the HMAC.
    Returns the scene string if valid, or None if the packet is
    malformed or fails verification (i.e. a spoofed/unsigned packet)."""
    parts = raw.split("|")
    if len(parts) != 2:
        return None

    scene, received_hex = parts
    try:
        received_mac = bytes.fromhex(received_hex)
    except ValueError:
        return None

    expected_mac = hmac.new(HMAC_KEY, scene.encode("utf-8"), hashlib.sha256).digest()[:8]

    if not hmac.compare_digest(received_mac, expected_mac):
        return None  # signature doesn't match — reject, don't trust content

    return scene

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


def broadcast_scene(scene, source):
    message = json.dumps({"type": "scene", "scene": scene, "source": source})
    with websocket_clients_lock:
        clients = tuple(websocket_clients)

    for client in clients:
        try:
            client.send(message)
        except Exception:
            with websocket_clients_lock:
                websocket_clients.discard(client)


def handle_line(line: str, source: str):
    """source is 'm5' (real hardware, serial) or 'sim' (fake beacon, UDP).
    Same trigger logic either way, just tagged so you can tell them apart
    in the console and in the websocket payload the dashboard receives."""
    print(f"[{source}] Received raw packet: {line}")

    if line == "SCENE_1":
        print(f"[{source}] [!] Sequence Start detected -> Triggering Scene 1")
        pyautogui.press('1')
        broadcast_scene(line, source)

    elif line == "SCENE_2":
        print(f"[{source}] [!] Outage detected -> Triggering Scene 2")
        pyautogui.press('2')
        broadcast_scene(line, source)


def run_serial_listener():
    """Real M5Stack beacon, over USB serial."""
    print(f"Connecting to {COM_PORT}...")
    try:
        ser = serial.Serial()
        ser.port = COM_PORT
        ser.baudrate = BAUD_RATE
        ser.timeout = None
        ser.dtr = False
        ser.rts = False
        ser.open()
    except Exception as e:
        print(f"[m5] Could not open {COM_PORT}: {e}")
        print("[m5] Serial listener disabled — continuing with UDP (sim) only.")
        return

    print(f"[m5] Listening for packets on {COM_PORT}...")
    try:
        while True:
            try:
                line = ser.readline().decode('utf-8', errors='ignore').strip()
                if not line:
                    continue
                handle_line(line, source="m5")
            except Exception as e:
                print(f"[m5] Serial read error: {e}")
                break
    finally:
        ser.close()


def run_udp_listener():
    """Fake / simulated beacon, over Wi-Fi UDP (e.g. fake_beacon_sender.py)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((UDP_HOST, UDP_PORT))

    print(f"[sim] Listening for wireless (UDP) packets on {UDP_HOST}:{UDP_PORT}...")

    try:
        while True:
            try:
                data, addr = sock.recvfrom(1024)
                raw = data.decode('utf-8', errors='ignore').strip()
                if not raw:
                    continue

                scene = verify_udp_packet(raw)
                if scene is None:
                    print(f"[sim] REJECTED unverified/spoofed packet from {addr}: {raw!r}")
                    continue  # do NOT press keys or broadcast — untrusted

                handle_line(scene, source="sim")
            except Exception as e:
                print(f"[sim] UDP read error: {e}")
                break
    finally:
        sock.close()


if __name__ == "__main__":
    threading.Thread(target=run_websocket_server, daemon=True).start()

    # Run both listeners concurrently. If the M5 isn't plugged in, the
    # serial thread logs a warning and exits quietly — UDP keeps working.
    serial_thread = threading.Thread(target=run_serial_listener, daemon=True)
    udp_thread = threading.Thread(target=run_udp_listener, daemon=True)

    serial_thread.start()
    udp_thread.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Shutting down.")