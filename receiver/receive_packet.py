import time
import serial
import pyautogui

# Update to match your M5Stack's COM port (check Device Manager or Arduino IDE)
COM_PORT = "COM4"
BAUD_RATE = 115200

def listen_and_trigger():
    print(f"Listening for outage signal on {COM_PORT}...")
    
    # Open serial port (blocking mode for instant response)
    ser = serial.Serial(COM_PORT, BAUD_RATE, timeout=None)
    
    while True:
        # Blocks until a full line is received from the M5Stack
        line = ser.readline().decode('utf-8', errors='ignore').strip()
        
        if line == "OUTAGE_TRIGGER":
            print("\n[!] Outage trigger received from M5Stack!")
            
            # Send '2' keypress instantly
            pyautogui.press('2')
            print("Successfully sent keyboard input '3' to active window.\n")

if __name__ == "__main__":
    listen_and_trigger()