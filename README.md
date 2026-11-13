# Smart House Annotation & Virtual Smartwatch Sensor System

A responsive, touch-first real-time data collection and sensor capture system built strictly to the specifications of the Product Requirements Document (PRD v1.0), the 4 hand-drawn layout sketches, and the virtual smartwatch test architecture.

---

## 🚀 Live Access

The app is built, running, and accessible at:
👉 **[http://localhost:3001](http://localhost:3001)**

- Toggle between the **Participant Annotation App** and the **Researcher Admin Console** using the top header buttons (`Annotate` vs `Console`).

### Starting the Server:
```bash
# Start the unified production server (serves backend API + frontend SPA):
npm start
```

---

## 🛠️ Admin Page & Session Management

The Admin Page allows researchers to manage each experiment session and test the system with **virtual smartwatches**:

1. **Session Lifecycle Management**:
   - **Table of All Sessions**: View Session ID, Status (`active` / `ended`), Start Time, Duration, Total Annotations, and Virtual Sensor Chunks count.
   - **Switch Active Session**: Click `Select` on any session to switch the participant flow and data stream to that session.
   - **Create New Session**: Enter a Session ID (e.g. `S002`, `PILOT_01`) to start a fresh experiment with its own frozen config snapshot.
   - **End Session**: Locks the session and finalizes all dataset exports.
   - **Delete Session**: Safely remove past test runs.

2. **Virtual Smartwatch Fleet Test Harness**:
   - Test without physical smartwatches using the built-in **Virtual Polar 360** simulator.
   - **Individual & Fleet Controls**: Start or stop virtual smartwatches for `Person_A`, `Person_B`, and `Person_C` individually or with one-click master buttons ("Start All" / "Stop All").
   - **Live Sensor Telemetry**: Displays real-time 52Hz Accelerometer (`X`, `Y`, `Z` in mG), 52Hz Gyroscope, and 1Hz Heart Rate (BPM).
   - **10-Second Chunk Ingestion**: Automatically packages samples into 10-second chunks and ingests them into the SQLite database.
   - **Wrist Tap Calibration Spike**: Click the wrist tap spike button to simulate a sharp +3.5g impact to test time synchronization and label-to-sensor alignment.

3. **PRD §8 Compliant CSV Export Center**:
   - **Combined CSV**: Direct download of `S001_all.csv` (contains all residents in one file sorted by timestamp).
   - **Individual CSVs**: Download `S001_Person_A.csv`, `S001_Person_B.csv`, `S001_Person_C.csv`.
   - Formatted with UTF-8 BOM for Microsoft Excel compatibility, with all 13 exact PRD header columns:
     `session_id, participant, annotation_id, timestamp_submitted, timestamp_started, location_id, location, activity_id, activity, interaction, other_person, edited, config_version`

4. **Test Annotation Generator**:
   - Quick one-click buttons to inject test annotations into the active session (e.g. *Living / TV / Solo*, *Living / Vacuum / Solo*, *Kitchen / Cooking / Solo*) to test database writes, live tables, and CSV exports immediately without manual clicking.

5. **Live Session Annotations Feed**:
   - Real-time table of incoming annotations with sequence numbering, timestamps, locations, activities, and collaborator information.
   - Filter by participant (`All`, `Person_A`, `Person_B`, `Person_C`).

---

## 📱 5-Screen Participant Flow

Designed to match the 4 hand-drawn sketches:
- **Header Clock**: Real-time clock updating every second (`HH:MM:SS`) synced with server NTP time.
- **Breadcrumb Banners**: Directly beneath the clock, previous choices appear as full-width interactive banners (`Living`, `Sit on couch`, `Collab`). Tapping any banner jumps back to edit that choice with intelligent re-validation.
- **2-Column Large Touch Tiles**:
  - **Screen 1 (Location)**: Kitchen, Dining, Living, Bathroom, Bedroom 1, Bedroom 2, Stairs, Toilet, Landing, Front Door, Back Door.
  - **Screen 2 (Activity)**: Filtered for the chosen room (e.g. Living displays *TV*, *Vacuum* [id 19 added], *Sit on couch*, *Window*).
  - **Screen 3 (Interaction)**: *Solo*, *Collab*, *Assisted*. Choosing **Solo** automatically skips the Person step directly to Screen 5.
  - **Screen 4 (Person)**: Excludes the active participant (e.g. displays *B* and *C* for Person_A).
  - **Screen 5 (Review & Submit)**: Summary cards with individual Edit controls, an optional **Wrist Tap Calibration** tool, and an **Accept & Submit** button that returns to Screen 1 within 1.2s.

---

## 🧪 Testing Suite

Automated verification tests:
```bash
# Run unit & database idempotency tests:
node test_app.js

# Run full end-to-end HTTP integration test:
node test_e2e.js
```
