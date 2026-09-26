/*
  M5Stack Fire — Traffic Light Directional Beacon Display + Outage Serial Signal
  -----------------------------------------------------------------------------
  Reads 6 GPIO input pins connected to an Arduino traffic controller:
    - G36: North Red
    - G34: North Yellow
    - G26: North Green
    - G35: East Red
    - G5:  East Yellow
    - G13: East Green

  Display Logic:
    - Shows individual status for N and E: GO (Green), SLOW (Yellow), STOP (Red).
    - On-board LED bar matches dominant priority signal.
    - If all signals are off for 3 continuous seconds -> Sends USB Serial signal
      to laptop to launch simulation.
*/

#include <M5Unified.h>
#include <FastLED.h>

// On-board NeoPixel LED bar pin
#define LED_PIN     15
#define NUM_LEDS    10
CRGB leds[NUM_LEDS];

// GPIO Sense Pins from Arduino Circuit
#define PIN_N_RED   36
#define PIN_N_YEL   34
#define PIN_N_GRN   26
#define PIN_E_RED   35
#define PIN_E_YEL   5
#define PIN_E_GRN   13

enum SignalState {
  SIG_OFF = 0,
  SIG_STOP,
  SIG_SLOW,
  SIG_GO
};

struct TrafficState {
  SignalState north;
  SignalState east;

  bool operator!=(const TrafficState& other) const {
    return north != other.north || east != other.east;
  }
};

TrafficState previousState = {SIG_OFF, SIG_OFF};

// Outage timer variables
unsigned long outageStartTime = 0;
bool outageTimerActive = false;
bool outageSignalSent = false;

void setAllLeds(CRGB color) {
  fill_solid(leds, NUM_LEDS, color);
  FastLED.show();
}

uint16_t getColorForSignal(SignalState sig) {
  switch (sig) {
    case SIG_GO:   return GREEN;
    case SIG_SLOW: return YELLOW;
    case SIG_STOP: return RED;
    default:       return WHITE;
  }
}

const char* getTextForSignal(SignalState sig) {
  switch (sig) {
    case SIG_GO:   return "GO";
    case SIG_SLOW: return "SLOW";
    case SIG_STOP: return "STOP";
    default:       return "OFF";
  }
}

void renderDisplay(TrafficState state) {
  M5.Lcd.fillScreen(BLACK);

  // Power Outage Check
  if (state.north == SIG_OFF && state.east == SIG_OFF) {
    M5.Lcd.setTextSize(5);
    M5.Lcd.setTextColor(RED, BLACK);
    int16_t w = M5.Lcd.textWidth("OUTAGE");
    int16_t h = 8 * 5;
    M5.Lcd.setCursor((320 - w) / 2, (240 - h) / 2);
    M5.Lcd.print("OUTAGE");

    setAllLeds(CRGB::Black);
    return;
  }

  // Draw North Status
  M5.Lcd.setTextSize(4);
  M5.Lcd.setCursor(20, 50);
  M5.Lcd.setTextColor(WHITE, BLACK);
  M5.Lcd.print("N: ");
  M5.Lcd.setTextColor(getColorForSignal(state.north), BLACK);
  M5.Lcd.println(getTextForSignal(state.north));

  // Draw East Status
  M5.Lcd.setCursor(20, 140);
  M5.Lcd.setTextColor(WHITE, BLACK);
  M5.Lcd.print("E: ");
  M5.Lcd.setTextColor(getColorForSignal(state.east), BLACK);
  M5.Lcd.println(getTextForSignal(state.east));

  // LED bar logic priority: GO (Green) > SLOW (Yellow) > STOP (Red)
  if (state.north == SIG_GO || state.east == SIG_GO) {
    setAllLeds(CRGB::Green);
  } else if (state.north == SIG_SLOW || state.east == SIG_SLOW) {
    setAllLeds(CRGB::Yellow);
  } else {
    setAllLeds(CRGB::Red);
  }
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);

  // Initialize Serial at 115200 baud for laptop communication
  Serial.begin(115200);

  // Configure Arduino sense pins as inputs
  pinMode(PIN_N_RED, INPUT);
  pinMode(PIN_N_YEL, INPUT);
  pinMode(PIN_N_GRN, INPUT);
  pinMode(PIN_E_RED, INPUT);
  pinMode(PIN_E_YEL, INPUT);
  pinMode(PIN_E_GRN, INPUT);

  FastLED.addLeds<WS2812B, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(80);

  TrafficState initialState = {SIG_OFF, SIG_OFF};
  renderDisplay(initialState);
}

void loop() {
  M5.update();

  // Fresh state for every reading cycle
  TrafficState currentState = {SIG_OFF, SIG_OFF};

  // Read North digital states
  if (digitalRead(PIN_N_GRN))      currentState.north = SIG_GO;
  else if (digitalRead(PIN_N_YEL)) currentState.north = SIG_SLOW;
  else if (digitalRead(PIN_N_RED)) currentState.north = SIG_STOP;

  // Read East digital states
  if (digitalRead(PIN_E_GRN))      currentState.east = SIG_GO;
  else if (digitalRead(PIN_E_YEL)) currentState.east = SIG_SLOW;
  else if (digitalRead(PIN_E_RED)) currentState.east = SIG_STOP;

  // Check if an outage is occurring (all lights off)
  bool isOutage = (currentState.north == SIG_OFF && currentState.east == SIG_OFF);

  if (isOutage) {
    if (!outageTimerActive) {
      outageStartTime = millis();
      outageTimerActive = true;
      outageSignalSent = false;
    } else if (!outageSignalSent && (millis() - outageStartTime >= 3000)) {
      // 3 seconds passed in continuous outage -> Send signal to laptop
      Serial.println("OUTAGE_TRIGGER");
      outageSignalSent = true;
    }
  } else {
    // Reset timer when power/lights return
    outageTimerActive = false;
    outageSignalSent = false;
  }

  // Re-render display ONLY when the read state changes
  if (currentState != previousState) {
    renderDisplay(currentState);
    previousState = currentState;
  }

  delay(20);
}