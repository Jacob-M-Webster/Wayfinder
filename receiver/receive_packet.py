import subprocess
import os
import serial

# Update to match your M5Stack's COM port (e.g., 'COM3', 'COM4')
COM_PORT = "COM4"
BAUD_RATE = 115200

# Directory path to your frontend project
FRONTEND_DIR = r"C:\Users\zhiti\OneDrive - University of Florida\Wayfinder\frontend"

def listen_and_start():
    print(f"Listening for outage signal on {COM_PORT}...")
    
    # Open serial connection
    ser = serial.Serial(COM_PORT, BAUD_RATE, timeout=None)
    
    while True:
        # Blocking read: Waits directly for incoming line with zero polling delay
        line = ser.readline().decode('utf-8', errors='ignore').strip()
        
        if line == "OUTAGE_TRIGGER":
            print("\n[!] Outage trigger received! Launching Vite dev server instantly...\n")
            
            # Launch npm run dev in your frontend folder
            subprocess.Popen(
                ["npm", "run", "dev"], 
                cwd=FRONTEND_DIR, 
                shell=True
            )
            break

if __name__ == "__main__":
    listen_and_start()