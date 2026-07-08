# signalk-racebox-imu

A Signal K plugin to auto-discover, connect, and stream telemetry from a **RaceBox Mini**, **RaceBox Mini S**, or **RaceBox Micro** over Bluetooth Low Energy (BLE).

This plugin parses the RaceBox binary protocol (UBX-framed, per the official *RaceBox BLE Protocol Description rev 8*) and converts it into standard Signal K paths. Streams at 25Hz with full 6-axis IMU (accelerometer + gyroscope), GPS/GNSS position, course/speed, battery monitoring, and satellite tracking.

Bluetooth connectivity is handled by [`node-ble`](https://github.com/chrvadala/node-ble), which talks to the standard Linux BlueZ daemon over D-Bus — no native modules, no raw HCI access, and no conflicts with the system Bluetooth stack.

---

## Features
* **Zero Configuration Pairing:** Auto-discovers and connects to the first device advertising as "RaceBox" — no MAC addresses to find or type.
* **Full Telemetry Mapping:** Position, SOG, COG, Pitch, Roll, satellite count, battery status, and GPS accuracy.
* **6-Axis IMU Streaming:** Raw accelerometer (X/Y/Z) and gyroscope (X/Y/Z) data at 25Hz.
* **Validated Protocol Parser:** Field offsets verified against the reference packet in the official RaceBox protocol documentation (rev 8).
* **Fix-Aware Position Gating:** Position, SOG, and COG are only published when the receiver reports a valid 2D/3D fix, so you never get bogus coordinates during satellite acquisition.
* **In-App Calibration:** Zero out Pitch & Roll offsets while the boat is level — saved to config for future sessions.
* **Self-Healing Connection:** Automatic reconnect with backoff, plus a data-staleness watchdog that tears down and re-establishes a silent connection.
* **Bluetooth Reset Control:** One-click restart of the system Bluetooth service from the Signal K Admin UI.

---

## Prerequisites & System Dependencies

The plugin uses the standard Linux Bluetooth stack (BlueZ) via D-Bus. On Raspberry Pi OS everything needed ships by default — you just need to make sure it's enabled, and grant the Signal K user D-Bus access.

### 1. Ensure BlueZ is installed and running

```bash
sudo apt-get install bluetooth bluez
sudo systemctl enable --now bluetooth
bluetoothctl power on
```

> **Note:** If you previously disabled the Bluetooth service to accommodate a noble-based plugin (including older versions of this one), re-enable it — this plugin *requires* `bluetoothd` running.

### 2. Grant D-Bus permission to the Signal K user (one-time)

Linux restricts which users may talk to the Bluetooth daemon. Create a D-Bus policy for the user that runs Signal K (commonly `pi`, or your login user — check with `ps -o user= -p $(pgrep -f signalk-server | head -1)`):

```bash
sudo tee /etc/dbus-1/system.d/signalk-ble.conf > /dev/null <<'EOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="YOUR_SIGNALK_USER">
    <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
EOF
sudo systemctl reload dbus
```

Replace `YOUR_SIGNALK_USER` with the actual username.

> Unlike noble-based plugins, **no `setcap` on the node binary is required**, and the permissions survive Node.js upgrades.

---

## Installation

### Method 1: Via Signal K App Store (Recommended)

1. Log into your **Signal K Admin Console**.
2. Navigate to **Appstore** → **Available**.
3. Search for `signalk-racebox-imu`.
4. Click **Install**.
5. Restart your Signal K server when prompted.

### Method 2: Manual Installation (For Development / Testing)

```bash
cd ~/.signalk
npm install github:theseal666/signalk-racebox-imu
sudo systemctl restart signalk
```

---

## Configuration

1. Go to **Plugin Config** in the Signal K side menu.
2. Select **RaceBox BLE Telemetry**.
3. Turn on the plugin.
4. **Calibrate IMU (Optional):** Place your boat level on calm water, check "CALIBRATE IMU" and click Save. The plugin captures Pitch & Roll offsets for your installation angle from the next data packet.
5. **Bluetooth Reset (Emergency):** If the connection locks up, check "RESET BLUETOOTH" and click Save to restart the system Bluetooth service.

### Good to know

* **Config saves restart the plugin:** Signal K restarts a plugin whenever its configuration is saved, which briefly disconnects the RaceBox (~20s to reconnect). For calibration this means the offsets are captured from the first packet *after* reconnection — keep the boat level until the status shows "Calibration captured".
* **One central at a time:** A RaceBox accepts only one BLE connection. Close the RaceBox phone app (fully — not backgrounded) or it will steal the connection from the server.
* **Standalone recording (Mini S / Micro):** If the device is set to record at a lower rate (e.g. 1Hz), live BLE data arrives at that reduced rate too. During a memory download or erase, live data is silenced entirely.
* **No position at startup indoors:** Position/SOG/COG are gated on a valid GNSS fix. IMU and battery data flow immediately; navigation data appears once the green (fix) LED is on.

---

## Signal K Paths Emitted

At up to 25Hz:

### Navigation – Position & Course *(only with a valid 2D/3D fix)*
* `navigation.position` — Latitude/Longitude (degrees)
* `navigation.courseOverGroundTrue` — Course over ground (radians, 0 = North)
* `navigation.speedOverGround` — Speed over ground (m/s)
* `navigation.gnss.type` — GNSS constellation in use

### Navigation – Attitude (Pitch/Roll)
* `navigation.attitude.roll` — Roll angle (radians), calibration offset applied
* `navigation.attitude.pitch` — Pitch angle (radians), calibration offset applied
* `navigation.rateOfTurn` — Turning rate from gyro Z / yaw (rad/s)

### Navigation – Raw IMU (6-Axis)
* `navigation.accel.x` — Accelerometer X (front/back, g)
* `navigation.accel.y` — Accelerometer Y (right/left, g)
* `navigation.accel.z` — Accelerometer Z (up/down, g) — useful for heave/wave analysis
* `navigation.gyro.x` — Gyroscope X (roll rate, rad/s)
* `navigation.gyro.y` — Gyroscope Y (pitch rate, rad/s)
* `navigation.gyro.z` — Gyroscope Z (yaw rate, rad/s)

### Navigation – GNSS/GPS Quality
* `navigation.gnss.satellites` — Number of space vehicles used in the solution
* `navigation.gnss.horizontalDilution` — PDOP (dimensionless)
* `navigation.gnss.positionError` — Horizontal accuracy estimate (meters)

### Electrical – Power (model-dependent)
The plugin detects the device model from its advertised name and publishes the correct interpretation:

**RaceBox Mini / Mini S** (battery-powered):
* `electrical.batteries.racebox.capacity.stateOfCharge` — Battery level (0 to 1)
* `electrical.batteries.racebox.chargingMode` — `charging` / `not charging`

**RaceBox Micro** (externally powered, no battery):
* `electrical.batteries.racebox.voltage` — Input voltage (Volts, 0.1V resolution)

---

## Troubleshooting

### Plugin Won't Start / "Bluetooth adapter init timed out"
- Confirm the Bluetooth service is running: `systemctl status bluetooth`
- Confirm the adapter is powered: `bluetoothctl show` (look for `Powered: yes`)
- Confirm the D-Bus policy (Prerequisites step 2) exists and names the correct user, then `sudo systemctl reload dbus` and restart Signal K.

### Scanning Never Finds the RaceBox
- Verify the device is advertising: its blue LED should be **flashing**. A **solid** blue LED means something else is already connected to it (often the RaceBox phone app) — a connected RaceBox stops advertising.
- Check it's visible to the OS: `bluetoothctl scan on` should list `RaceBox Mini/Micro <serial>`.

### Connected But No Data
- Check **Provider Status** in the plugin config page and the server log: `sudo journalctl -u signalk -f | grep RaceBox`
- The plugin's watchdog automatically reconnects if data stalls for 15 seconds — persistent stall/reconnect cycles usually indicate another client fighting for the device.
- Try the **RESET BLUETOOTH** button in plugin config.

### Calibration Not Saving
- Ensure the boat is level and stable, and that data is actively streaming, before checking "CALIBRATE IMU" — the offsets are captured from the next live packet.
- Check the server log for save errors.

---

## Development

1. Clone the repository, modify `index.js`, test on a Pi running Signal K (`npm install <path-or-git-url>` in `~/.signalk`).
2. The RaceBox protocol: UBX-framed packets (`0xB5 0x62`) over the Nordic UART service (`6e400001-b5a3-f393-e0a9-e50e24dcca9e`), TX characteristic notifications, Fletcher-8 checksum. The 80-byte `0xFF 0x01` data message layout is implemented in `parseRaceBoxData()` and matches the official *RaceBox BLE Protocol Description rev 8*.
3. Packets may be split or merged across BLE notifications — the reassembly buffer in `processIncomingBytes()` handles this.

---

## License

MIT License. Feel free to use, modify, and distribute.
