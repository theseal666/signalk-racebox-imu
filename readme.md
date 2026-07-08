# signalk-racebox-imu

<p align="center">
  <img src="images/logo.png" alt="Signal K RaceBox IMU plugin logo" width="300">
</p>

A Signal K plugin to auto-discover, connect, and stream telemetry from a **RaceBox Mini**, **RaceBox Mini S**, or **RaceBox Micro** over Bluetooth Low Energy (BLE).

This plugin parses the RaceBox binary protocol (UBX-framed, per the official *RaceBox BLE Protocol Description rev 8*) and converts it into standard Signal K paths. Streams at 25Hz with full 6-axis IMU (accelerometer + gyroscope), GPS/GNSS position, course/speed, battery monitoring, and satellite tracking.

---

## Features
* **Zero Configuration Pairing:** Auto-discovers and connects to the first device advertising as "RaceBox".
* **Full Telemetry Mapping:** Position, SOG, COG, Pitch, Roll, satellite count, battery status, and GPS accuracy.
* **6-Axis IMU Streaming:** Raw accelerometer (X/Y/Z) and gyroscope (X/Y/Z) data at 25Hz.
* **Experimental Wave & Slam Detection:** Advanced math (True Z rotation + leaky integration) to estimate wave height, period, and detect complex hull slams.
* **High-Quality Codebase:** Decoupled metadata and automated unit tests for reliability and a high Signal K Registry score.

---

## Screenshots

### Plugin Configuration
![Plugin Settings](images/data-browser.png)

### Live Data Stream
![Data Browser](images/settings.png)

### Connection Status
![Connection Status](images/status.png)

---

## Signal K Paths Emitted

The plugin publishes the following paths to the Signal K Delta stream at up to 25Hz:

### Navigation – Core Telemetry
* `navigation.position` — Latitude/Longitude (degrees)
* `navigation.speedOverGround` — Speed over ground (m/s)
* `navigation.courseOverGroundTrue` — Course over ground (radians, 0 = North)
* `navigation.attitude.roll` — Calibrated Roll angle (radians)
* `navigation.attitude.pitch` — Calibrated Pitch angle (radians)
* `navigation.rateOfTurn` — Turning rate from gyro Z (rad/s)
* `navigation.gnss.type` — Constellation in use (GPS+GLONASS+GALILEO)
* `navigation.gnss.satellites` — Number of satellites in view
* `navigation.gnss.horizontalDilution` — HDOP
* `navigation.gnss.positionError` — Horizontal accuracy estimate (meters)

### Navigation – Raw IMU (25Hz)
* `navigation.accel.x`, `.y`, `.z` — Raw accelerometer (g)
* `navigation.gyro.x`, `.y`, `.z` — Raw gyroscope (rad/s)

### Experimental: Wave & Performance Detection
*These paths are persistently reported at 25Hz when enabled in the settings.*

* `navigation.accel.trueZ` — Earth-fixed vertical acceleration (g). Isolates vertical motion from boat rotation using 3D rotation math.
* `environment.wind.waveHeight` — Estimated peak-to-peak wave height (meters). Calculated via leaky double-integration of vertical acceleration, gated by the Pitch cycle.
* `environment.wind.wavePeriod` — Estimated wave period (seconds).
* `performance.hull.slamAcceleration` — Peak impact G-Force (3D Resultant). Captures impacts from any direction (side, bow, or bottom) using a 1-second peak-hold.
* `performance.hull.slamAngularJolt` — Derivative of angular rates (rad/s²). Measures the violence of sudden orientation changes.

**Note:** Wave height/period auto-reset to `0` after 20 seconds of inactivity to ensure clean logging in tools like Expedition.

### Electrical & System
* `electrical.batteries.racebox.capacity.stateOfCharge` — Battery level (0 to 1)
* `electrical.batteries.racebox.chargingMode` — `charging` / `not charging`
* `electrical.batteries.racebox.voltage` — Input voltage (RaceBox Micro only)

---

## Prerequisites & System Dependencies

The plugin uses the standard Linux Bluetooth stack (BlueZ) via D-Bus.

### 1. Ensure BlueZ is installed and running
```bash
sudo apt-get install bluetooth bluez
sudo systemctl enable --now bluetooth
bluetoothctl power on
```

### 2. Grant D-Bus permission
Create `/etc/dbus-1/system.d/signalk-ble.conf`:
```xml
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="theseal666">
    <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```
Reload D-Bus: `sudo systemctl reload dbus`.

---

## Installation & Development

### Manual Installation
```bash
cd ~/.signalk
npm install github:theseal666/signalk-racebox-imu#feature/quality-improvements
sudo systemctl restart signalk
```

### Running Tests
```bash
npm test
```

---

## License
MIT License.
