import json
import threading
import time

import serial
import pyautogui
from websockets.sync.server import serve

# Update to match your M5Stack's COM port
COM_PORT = "COM4"
BAUD_RATE = 115200
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

if __name__ == "__main__":
    threading.Thread(target=run_websocket_server, daemon=True).start()
    print(f"Connecting to {COM_PORT}...")

    # Open serial port with DTR/RTS disabled to prevent M5Stack reset/hangs
    ser = serial.Serial()
    ser.port = COM_PORT
    ser.baudrate = BAUD_RATE
    ser.timeout = None
    ser.dtr = False
    ser.rts = False
    ser.open()

    print(f"Listening for packets on {COM_PORT}...")

    try:
        while True:
            try:
                # Reads incoming line from M5Stack
                line = ser.readline().decode('utf-8', errors='ignore').strip()

                if not line:
                    continue

                print(f"Received raw packet: {line}")

                if line == "SCENE_1":
                    print("[!] Sequence Start detected -> Triggering Scene 1")
                    pyautogui.press('1')
                    broadcast_scene(line)

                elif line == "SCENE_2":
                    print("[!] Outage detected -> Triggering Scene 2")
                    pyautogui.press('2')
                    broadcast_scene(line)

            except Exception as e:
                print(f"Serial read error: {e}")
                break
    finally:
        ser.close()