Markdown
# signalk-racebox-imu

A Signal K plugin to auto-discover, pair, and stream telemetry from a **RaceBox Mini** or **RaceBox Micro** over Bluetooth Low Energy (BLE). 

This plugin extracts high-frequency IMU and GNSS data directly from the proprietary RaceBox binary stream and converts it into standard Signal K paths. It also includes an adaptive spectral analysis window to track ocean wave heights and periods without requiring manual calibration.

---

## Features
* **Zero Configuration Pairing:** Auto-discovers and pairs with the first available RaceBox device—no MAC addresses to find or type.
* **Full Telemetry Mapping:** Extracts Position, SOG, COG, Pitch, Roll, and Satellite Count.
* **Adaptive Wave Profiling:** Runs numerical double-integration on the earth-axis vertical acceleration vector to calculate dynamic wave heights and periods.
* **App Store Native:** Integrates smoothly into the Signal K Admin UI with live connection logging and a one-click hardware reset switch.

---

## Prerequisites & System Dependencies

Because this plugin utilizes Bluetooth Low Energy (`@abandonware/noble`), the host system (e.g., Raspberry Pi) requires specific Bluetooth libraries and permissions.

### 1. Install System Packages
Run the following command on your Raspberry Pi terminal to install the necessary BLE development libraries:

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
2. Grant Permissions to Node.js (Crucial for Raspberry Pi)
By default, Linux prevents non-root applications (like the Node.js process running Signal K) from accessing the Bluetooth controller interface. Grant the required permissions by running:
Bash
sudo setcap cap_net_raw,cap_net_admin=+eip $(eval readlink -f `which node`)
Note: If you update Node.js on your system in the future, you will need to re-run this command.
Installation
Method 1: Via Signal K App Store (Recommended for Production)
Once published, this is the seamless approach for end-users:
Log into your Signal K Admin Console.
Navigate to Appstore -> Available.
Search for signalk-racebox-imu.
Click Install.
Restart your Signal K server when prompted.
Method 2: Manual Installation (For Development / Testing)
If you are testing this code from GitHub before it is officially on the App Store:
SSH into your Raspberry Pi.
Navigate to your Signal K data directory (usually ~/.signalk):
Bash
cd ~/.signalk
Install the plugin directly from your GitHub repository:
Bash
npm install [https://github.com/theseal666/signalk-racebox-imu.git](https://github.com/theseal666/signalk-racebox-imu.git)
Restart your Signal K server:
Bash
sudo systemctl restart signalk
Configuration
Go to Plugin Config in the Signal K side menu.
Select RaceBox BLE Telemetry Bridge.
Turn on the plugin.
Adaptive Wave Window: Set your target window length (default: 8 seconds). Shorter windows respond quickly to short chop; longer windows capture deep ocean swells accurately.
Hit Submit/Save.
Connecting & Resetting
Auto-Discovery: On boot, the plugin scans for any local hardware broadcasting as a RaceBox device. When it finds one, it locks its MAC address permanently into the configuration file so it ignores other devices in a busy marina.
The Reset Switch: If you swap to a different RaceBox unit on your boat, check the Reset & Force Scan box and click Save. The plugin will clear its memory, disconnect from the old device, and pair with the new unit immediately.
Signal K Paths Emitted
The plugin outputs data to the following deltas:
navigation.position (Latitude/Longitude)
navigation.gnss.satellites (Number of connected satellites)
navigation.courseOverGroundTrue (Radians)
navigation.speedOverGround (m/s)
navigation.attitude.roll (Radians)
navigation.attitude.pitch (Radians)
environment.wind.waveHeight (Significant crest-to-trough wave height in meters)
environment.wind.wavePeriod (Dominant period in seconds)
License
MIT License. Feel free to use, modify, and distribute.Configuration
Go to Plugin Config in the Signal K side menu.
Select RaceBox BLE Telemetry Bridge.
Turn on the plugin.
Adaptive Wave Window: Set your target window length (default: 8 seconds). Shorter windows respond quickly to short chop; longer windows capture deep ocean swells accurately.
Hit Submit/Save.
Connecting & Resetting
Auto-Discovery: On boot, the plugin scans for any local hardware broadcasting as a RaceBox device. When it finds one, it locks its MAC address permanently into the configuration file so it ignores other devices in a busy marina.
The Reset Switch: If you swap to a different RaceBox unit on your boat, check the Reset & Force Scan box and click Save. The plugin will clear its memory, disconnect from the old device, and pair with the new unit immediately.
Signal K Paths Emitted
The plugin outputs data to the following deltas:
navigation.position (Latitude/Longitude)
navigation.gnss.satellites (Number of connected satellites)
navigation.courseOverGroundTrue (Radians)
navigation.speedOverGround (m/s)
navigation.attitude.roll (Radians)
navigation.attitude.pitch (Radians)
environment.wind.waveHeight (Significant crest-to-trough wave height in meters)
environment.wind.wavePeriod (Dominant period in seconds)
License
MIT License. Feel free to use, modify, and distribute.
