import time
import serial
import pyautogui

# Update to match your M5Stack's COM port
COM_PORT = "COM4"
BAUD_RATE = 115200

def listen_and_trigger():
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
                
            elif line == "SCENE_2":
                print("[!] Outage detected -> Triggering Scene 2")
                pyautogui.press('2')
                
        except Exception as e:
            print(f"Serial read error: {e}")
            break

if __name__ == "__main__":
    listen_and_trigger()