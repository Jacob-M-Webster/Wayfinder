# Wayfinder

**Dark Signal Fallback**: a redundant solution for autonomous vehicles during traffic light outages.

Built at **ShellHacks** for the **Waymo sponsor track**.

**[Demo Video](https://www.youtube.com/watch?v=Aa8XQlzNDpM)**

<!-- TODO: add a demo GIF or screenshot of the three.js scene player here -->

## Problem

When the power goes out, traffic lights go dark. Humans treat a dark signal as an all-way stop and read the other drivers. Autonomous vehicles have a harder time. During the [December 2025 San Francisco blackout](https://www.sfcta.org/blogs/san-francisco-board-supervisors-hold-hearing-waymo-operations-during-december-2025-blackout), dark signals left AVs stalled at intersections and waiting on remote help. Every one of those stalls means a blocked intersection and a human operator pulled in.

AVs need a way to know the signal state when they can't see the light.

## Solution

Wayfinder gives the car three layers of defense, checked in this order:

1. **Beacon.** A battery-backed beacon at the intersection relays the signal controller's phase. It keeps broadcasting after the grid goes down, so the car understands the state of the outage.
2. **Model.** If the beacon is missing or stale, a model infers the light's phase from how the surrounding vehicles are behaving (queued, accelerating, crossing).
3. **All-way stop.** If the model isn't confident, the car falls back to a safe all-way stop instead of freezing.

```
 BLE beacon (signed, 10 Hz)
        │  valid and fresh?
        ├── yes ──▶ use beacon phase
        │
        ▼  no
 Behavior model (LightGBM)
        │  confidence ≥ 0.8?
        ├── yes ──▶ use inferred phase
        │
        ▼  no
 All-way stop
```

**Results.** On Waymo Open Motion data, the model is **95% accurate when it commits** (at a 0.8 confidence threshold). It only calls "go" on a real red **2.5%** of the time.

<!-- TODO: add what fraction of the time the model commits (coverage), and say what the 2.5% is measured over (all red samples? all "go" calls?) -->

## Implementation

**Data.** [Waymo Open Motion Dataset](https://waymo.com/open/data/motion/) (~1.4 TB). We compiled the protos locally and wrote a lightweight TFRecord reader.

**Model.** We extracted per-lane behavioral features from ~2M rows across 16k scenarios and trained a LightGBM classifier with abstention. The self-driving car's own track and all signal-state data are excluded from the features to prevent label leakage. Lanes are grouped by approach (N/E/S/W), and the car's specific lane is detected so turn lanes don't blur the prediction.

**Beacon.** An M5Stack/ESP32 <!-- TODO: finish this phrase, e.g. "running custom firmware that broadcasts" --> an 18-byte packet at 10 Hz, containing the phase, a scenario step, a sequence number, and an HMAC. A Python `bleak` receiver verifies each packet and pushes it over a WebSocket.

**Dashboard.** A three.js scene player replays real Waymo scenarios with floating signal heads showing the phase, confidence ring, decision source, and the ground truth next to each prediction.

## Spoof Testing

The beacon's HMAC exists to stop a bad actor from broadcasting a fake "green light" and getting a car to proceed through a live intersection. To check that the defense holds, we built a spoofing harness instead of trusting the design on paper.

**Setup.** Two laptops stand in for "attacker" and "intersection." One laptop broadcasts scene/phase packets over the same wireless channel the real M5Stack beacon would use, and can either sign packets correctly (a legitimate simulated beacon) or send unsigned or incorrectly signed packets (a spoof attempt). The receiver runs two listeners in parallel: one trusting the physical serial connection from the real M5Stack, one listening wirelessly. Every accepted packet is tagged with its source (`m5` or `sim`), so a forged packet can never be mistaken for the real beacon downstream.

**Result.** Packets without a valid HMAC signature are rejected outright: no scene change, no dashboard update, just a logged rejection. Only packets signed with the shared secret are accepted and passed to the decision pipeline. Spoofing the trusted channel requires physical access to the M5Stack, and anyone attempting to spoof over the wireless channel without the key is locked out cryptographically, not just filtered by convention.

## Repo Layout

| Path | What it is |
| --- | --- |
| `frontend/` | Vite web app: three.js scene player / dashboard |
| `model/` | Feature extraction, LightGBM training, abstention logic |
| `hardware/` | M5Stack/ESP32 beacon firmware |
| `receiver/` | Python `bleak` receiver: verifies packets, serves them over WebSocket |
| `sample_data/` | Sample Waymo scene data (`scene.json`) used by the dashboard |
| `demo_data/` | Scenes processed and used for web app demo |
| `requirements.txt` | Python dependencies |
| `package.json` | Node dependencies |

## Getting Started

### Dashboard

```bash
cd frontend
npm install
npm run dev
```

Open the local URL Vite prints. The app auto-loads `frontend/public/scene.json`, which is copied from `sample_data/scene.json`.

### Model

```bash
pip install -r requirements.txt
python extract_features.py --data <path>/scenario/training --out feats --shards 0-49 --workers 12
python train.py --feats feats --merge-caution
python eval_report.py --feats feats --model model.txt
```

The full dataset is **not** included in this repo. To reproduce training you need to accept Waymo's license terms and download it yourself.

## Team

| Area | Contributor |
| --- | --- |
| Model | Jacob Webster |
| Dashboard (frontend) | Anthony Le, Jacob Webster |
| Beacon hardware | Megan Mendez, Zhiting Li |

## Acknowledgments

- Waymo, for the sponsor track and the Open Motion Dataset
- ShellHacks organizers

## License

[MIT](LICENSE). The Waymo Open Motion Dataset is subject to its own license terms.
