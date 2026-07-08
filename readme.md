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
* **Experimental Wave & Slam Detection:** Advanced math (True Z rotation + leaky integration) to estimate wave height, period, and detect hull slams.
* **High-Quality Codebase:** Decoupled metadata and automated unit tests for reliability and a high Signal K Registry score.

---

## Screenshots

### Plugin Configuration
![Plugin Settings](images/settings.png)

### Live Data Stream
![Data Browser](images/data-browser.png)

### Connection Status
![Connection Status](images/status.png)

---

## Experimental: Wave & Performance Detection

This plugin performs real-time processing of the 25Hz IMU stream to derive advanced metrics:

### 1. True Vertical Acceleration (True Z)
To isolate actual vertical motion from the boat's rotation, the plugin performs a 3D rotation of the raw accelerometer data into an Earth-fixed frame using the current Pitch and Roll.
* **Path:** `navigation.accel.trueZ` (g)
* **Math:** $a_z^{earth} = -a_x \sin(P) + a_y \sin(R)\cos(P) + a_z \cos(R)\cos(P)$

### 2. Wave Height & Period
Estimating wave height from acceleration requires double-integration. This plugin uses a **Leaky Integration (High-Pass Filter)** approach to prevent drift:
* **Paths:** `environment.wind.waveHeight` (m), `environment.wind.wavePeriod` (s)
* **Logic:** The boat's Pitch cycle identifies wave start/peak/end. We integrate vertical acceleration to velocity, then displacement. Wave height is the peak-to-peak displacement within each pitch-detected half-cycle.
* **Persistence:** Metrics are reported at 25Hz and auto-reset to `0` after 20s of inactivity.

### 3. Hull Slam Detection
* **Path:** `performance.hull.slamAcceleration` (g)
* **Logic:** Monitors `True Z` for impacts exceeding the configurable threshold. Uses a 1-second peak-hold to ensure the event is captured in logs.

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
