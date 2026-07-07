# signalk-racebox-imu

A Signal K plugin to auto-discover, pair, and stream telemetry from a **RaceBox Mini** or **RaceBox Micro** over Bluetooth Low Energy (BLE). 

This plugin extracts high-frequency IMU and GNSS data directly from the proprietary RaceBox binary stream and converts it into standard Signal K paths. Streams at 25Hz with full 6-axis IMU (accelerometer + gyroscope), GPS/GNSS position, course/speed, battery voltage monitoring, and satellite tracking.

---

## Features
* **Zero Configuration Pairing:** Auto-discovers and pairs with the first available RaceBox device—no MAC addresses to find or type.
* **Full Telemetry Mapping:** Extracts Position, SOG, COG, Pitch, Roll, Satellite Count, Battery Voltage, and GPS Accuracy.
* **6-Axis IMU Streaming:** Outputs raw accelerometer (X/Y/Z) and gyroscope (X/Y/Z) data at 25Hz for high-precision navigation and motion analysis.
* **GPS Quality Metrics:** Reports number of satellites, horizontal position error, and fix status.
* **Battery Monitoring:** Real-time battery percentage and voltage tracking.
* **In-App Calibration:** Zero out Pitch & Roll offsets while boat is level—saved to config for future sessions.
* **Hardware Reset Control:** One-click Bluetooth radio reset from Signal K Admin UI to clear connection lockups.
* **App Store Native:** Integrates smoothly into the Signal K Admin UI with live connection logging and status updates.

---

## Prerequisites & System Dependencies

Because this plugin utilizes Bluetooth Low Energy (`@abandonware/noble`), the host system (e.g., Raspberry Pi) requires specific Bluetooth libraries and permissions.

### 1. Install System Packages
Run the following command on your Raspberry Pi terminal to install the necessary BLE development libraries:

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev

```

### 2. Grant Permissions to Node.js (Crucial for Raspberry Pi)

By default, Linux prevents non-root applications (like the Node.js process running Signal K) from accessing the Bluetooth controller interface. Grant the required permissions by running:

```bash
sudo setcap cap_net_raw,cap_net_admin=+eip $(eval readlink -f `which node`)

```

*Note: If you update Node.js on your system in the future, you will need to re-run this command.*

---

## Installation

### Method 1: Via Signal K App Store (Recommended for Production)

Once published, this is the seamless approach for end-users:

1. Log into your **Signal K Admin Console**.
2. Navigate to **Appstore** -> **Available**.
3. Search for `signalk-racebox-imu`.
4. Click **Install**.
5. Restart your Signal K server when prompted.

### Method 2: Manual Installation (For Development / Testing)

If you are testing this code from GitHub before it is officially on the App Store:

1. SSH into your Raspberry Pi.
2. Navigate to your Signal K data directory (usually `~/.signalk`):
```bash
cd ~/.signalk

```

3. Install the plugin directly from your GitHub repository:
```bash
npm install https://github.com/theseal666/signalk-racebox-imu.git

```

4. Restart your Signal K server:
```bash
sudo systemctl restart signalk

```

---

## Configuration

1. Go to **Plugin Config** in the Signal K side menu.
2. Select **RaceBox BLE Telemetry**.
3. Turn on the plugin.
4. **Calibrate IMU (Optional):** Place your boat level on calm water, check "CALIBRATE IMU" and click Save. The plugin will lock in Pitch & Roll offsets for your boat's installation angle.
5. **Bluetooth Reset (Emergency):** If the connection locks up, check "RESET BLUETOOTH" and click Save to force-cycle the Bluetooth radio.
6. Hit **Submit/Save**.

### Connecting & Resetting

* **Auto-Discovery:** On startup, the plugin scans for any local hardware broadcasting as "RaceBox". When found, it locks its MAC address so it reconnects to the same device automatically on restarts.
* **Manual Recalibration:** While boat is level and floating naturally, check the "CALIBRATE IMU" box and click Save. Roll and Pitch offsets are captured and applied to all future streams.
* **The Reset Switch:** If you swap to a different RaceBox unit or experience Bluetooth freezing, check the "RESET BLUETOOTH" box and click Save. The plugin will cycle the Linux BLE stack and restart scanning.

---

## Signal K Paths Emitted

The plugin outputs high-frequency telemetry to the following Signal K paths at 25Hz:

### Navigation – Position & Course
* `navigation.position` — Latitude/Longitude (degrees)
* `navigation.courseOverGroundTrue` — Heading (radians, 0 = North)
* `navigation.speedOverGround` — Speed over ground (m/s)

### Navigation – Attitude (Pitch/Roll)
* `navigation.attitude.roll` — Roll angle (radians, -π/2 to π/2)
* `navigation.attitude.pitch` — Pitch angle (radians, -π/2 to π/2)
* `navigation.rateOfTurn` — Turning rate from gyro Z (rad/s)

### Navigation – Raw IMU (6-Axis)
* `navigation.accel.x` — Accelerometer X (front/back, g)
* `navigation.accel.y` — Accelerometer Y (side/side, g)
* `navigation.accel.z` — Accelerometer Z (vertical, g)
* `navigation.gyro.x` — Gyroscope X (roll rate, rad/s)
* `navigation.gyro.y` — Gyroscope Y (pitch rate, rad/s)

### Navigation – GNSS/GPS Quality
* `navigation.gnss.satellites` — Number of satellites with lock
* `navigation.gnss.horizontalDilution` — Horizontal position error (meters)
* `navigation.gnss.positionError` — GPS accuracy estimate (meters)
* `navigation.gnss.type` — GNSS constellation in use (GPS+GLONASS+GALILEO)

### Electrical – Battery
* `electrical.batteries.racebox.capacity.stateOfCharge` — Battery charge (0 to 1, where 1 = 100%)
* `electrical.batteries.racebox.voltage` — Battery voltage (Volts)

---

## Troubleshooting

### Plugin Won't Start
- Verify Bluetooth libraries are installed: `sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev`
- Check Node.js permissions: `sudo setcap cap_net_raw,cap_net_admin=+eip $(eval readlink -f \`which node\`)`
- Verify RaceBox is powered on and broadcasting.

### No Data in Signal K
- Check the **Provider Status** in Signal K Admin UI for connection state.
- Use `hciconfig` on Raspberry Pi to confirm Bluetooth adapter is up: `hciconfig`
- Try the **RESET BLUETOOTH** button in plugin config if connection is stalled.

### Calibration Not Saving
- Ensure boat is level and stable before pressing "CALIBRATE IMU".
- Check Signal K server logs for save errors: `sudo journalctl -u signalk -f`

---

## Building & Development

To contribute or extend this plugin:

1. Clone the repository.
2. Modify `index.js` with your enhancements.
3. Test locally on a Raspberry Pi running Signal K.
4. Use the **RESET BLUETOOTH** button to clear state between tests.

The plugin uses the Nordic UART service (UUID `6e400001-b5a3-f393-e0a9-e50e24dcca9e`) for communication, which is industry-standard on many BLE devices.

---

## License

MIT License. Feel free to use, modify, and distribute.
