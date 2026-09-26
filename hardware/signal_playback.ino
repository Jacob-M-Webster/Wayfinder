// Traffic light playback for scenario e63026fee22804f9 (intersection 0)
// Press the button to play the scenario once.
// Codes: 0 = UNKNOWN/NONE, 1 = STOP, 2 = CAUTION, 3 = GO

// ---------------- Pins ----------------
// North-South traffic light circuit
const int NS_red    = 4;
const int NS_yellow = 3;
const int NS_green  = 2;
// East-West traffic light circuit
const int EW_red    = 7;
const int EW_yellow = 6;
const int EW_green  = 5;
// Start button (other leg to GND)
const int BUTTON_PIN = 8;

// ---------------- Scenario data ----------------
enum Code : uint8_t { UNKNOWN = 0, STOP = 1, CAUTION = 2, GO = 3 };

const unsigned long STEP_MS = 100;   // hz = 10  ->  100 ms per step

// Run-length encoded steps: {N, E, S, W, number of steps}
struct Segment { uint8_t n, e, s, w; uint16_t count; };

const Segment SCENARIO[] = {
  {STOP,    UNKNOWN, UNKNOWN, UNKNOWN, 26},  // 2.6 s
  {GO,      UNKNOWN, UNKNOWN, UNKNOWN, 48},  // 4.8 s
  {CAUTION, UNKNOWN, UNKNOWN, UNKNOWN, 41},  // 4.1 s
  {STOP,    UNKNOWN, UNKNOWN, UNKNOWN, 75},  // 7.5 s
  {UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN,  8},  // 0.8 s
};
const uint8_t NUM_SEGMENTS = sizeof(SCENARIO) / sizeof(SCENARIO[0]);

// ---------------- Behavior options ----------------
const bool INFER_CROSS_TRAFFIC = true;
const unsigned long DEBOUNCE_MS = 50;

// ---------------- State ----------------
uint8_t  segIndex = 0;
uint16_t stepInSeg = 0;
unsigned long lastStepMs = 0;
bool running = false;

// Button debounce state
bool lastReading = HIGH;
bool stableState = HIGH;
unsigned long lastChangeMs = 0;

// ---------------- Helpers ----------------
uint8_t resolveAxis(uint8_t a, uint8_t b) {
  return (a != UNKNOWN) ? a : b;
}

void setLight(int red, int yellow, int green, uint8_t code) {
  digitalWrite(red,    code == STOP || code == UNKNOWN);   // unknown = red
  digitalWrite(yellow, code == CAUTION);
  digitalWrite(green,  code == GO);
}

void allOff() {
  digitalWrite(NS_red, LOW); digitalWrite(NS_yellow, LOW); digitalWrite(NS_green, LOW);
  digitalWrite(EW_red, LOW); digitalWrite(EW_yellow, LOW); digitalWrite(EW_green, LOW);
}

void render() {
  const Segment &seg = SCENARIO[segIndex];
  uint8_t ns = resolveAxis(seg.n, seg.s);
  uint8_t ew = resolveAxis(seg.e, seg.w);

  if (INFER_CROSS_TRAFFIC) {
    // If EW has no data, set it opposite to NS
    if (ew == UNKNOWN) {
      if (ns == GO || ns == CAUTION) ew = STOP;
      else if (ns == STOP)           ew = GO;
    }
    // If NS has no data, set it opposite to EW
    if (ns == UNKNOWN) {
      if (ew == GO || ew == CAUTION) ns = STOP;
      else if (ew == STOP)           ns = GO;
    }
  }

  // Conflict monitor: never let both directions move at once
  bool nsMoving = (ns == GO || ns == CAUTION);
  bool ewMoving = (ew == GO || ew == CAUTION);
  if (nsMoving && ewMoving) {
    ns = UNKNOWN;
    ew = UNKNOWN;
  }

  setLight(NS_red, NS_yellow, NS_green, ns);
  setLight(EW_red, EW_yellow, EW_green, ew);
}

// Returns true once per press (on the press, not while held)
bool buttonPressed() {
  bool reading = digitalRead(BUTTON_PIN);
  if (reading != lastReading) {
    lastChangeMs = millis();     // input is bouncing; restart the timer
    lastReading = reading;
  }
  if (millis() - lastChangeMs > DEBOUNCE_MS && reading != stableState) {
    stableState = reading;
    if (stableState == LOW) return true;   // LOW = pressed (pull-up)
  }
  return false;
}

void startCycle() {
  segIndex = 0;
  stepInSeg = 0;
  lastStepMs = millis();
  running = true;
  Serial.println("--- Cycle started ---");
}

void advanceStep() {
  if (++stepInSeg < SCENARIO[segIndex].count) return;
  stepInSeg = 0;
  if (++segIndex < NUM_SEGMENTS) {
    Serial.print("Segment ");
    Serial.println(segIndex);
    return;
  }

  // End of scenario: stop and wait for the next press
  running = false;
  allOff();
  Serial.println("--- Cycle finished, waiting for button ---");
}

// ---------------- Main ----------------
void setup() {
  pinMode(NS_red, OUTPUT);
  pinMode(NS_yellow, OUTPUT);
  pinMode(NS_green, OUTPUT);

  pinMode(EW_red, OUTPUT);
  pinMode(EW_yellow, OUTPUT);
  pinMode(EW_green, OUTPUT);

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Serial.begin(9600);
  allOff();
  Serial.println("Ready. Press the button to start.");
}

void loop() {
  if (buttonPressed()) {
    startCycle();
  }

  if (running && millis() - lastStepMs >= STEP_MS) {
    lastStepMs += STEP_MS;
    advanceStep();
  }

  if (running) {
    render();
  }
}