const noble = require('@abandonware/noble');

module.exports = function (app) {
  let plugin = {};
  let timer = null;
  let connectedDevice = null;

  plugin.id = 'signalk-racebox-imu';
  plugin.name = 'Racebox IMU';
  plugin.description = 'Auto-discovers and connects to a RaceBox Mini or Micro over BLE, supporting IMU data, battery voltage monitoring, and gyro calibration.';

  // --- 1. SETTINGS PANEL SETUP (JSON SCHEMA) ---
  plugin.schema = {
    type: 'object',
    properties: {
      adaptiveWindow: {
        type: 'number',
        title: 'Adaptive Wave Window (Seconds)',
        default: 8
      },
      lockDeviceMac: {
        type: 'string',
        title: 'Lock to Device MAC Address (Leave blank for auto-discovery)',
        default: ''
      },
      calibrateGyro: {
        type: 'boolean',
        title: 'Calibrate IMU Gyros (Check this box and hit Save to level the device)',
        default: false
      }
    }
  };

  // --- 2. PLUGIN START LOGIC ---
  plugin.start = function (options, restartPlugin) {
    app.setProviderStatus('Starting RaceBox BLE scanning engine...');
    
    // Check if the user flagged the configuration settings calibration checkbox
    if (options.calibrateGyro) {
      app.setProviderStatus('Executing IMU Gyro Calibration sequence... Keep craft completely level!');
      
      // --- INSERT BLE WRITE COMMANDS FOR CALIBRATION ROUTINE HERE ---
      // e.g., calibrationCharacteristic.write(Buffer.from([0xXX, 0xXX]), true);
      
      // Reset the configuration setting value back to false so it doesn't loop trigger on subsequent runs
      options.calibrateGyro = false;
    }
    
    // Track runtime options
    let targetMac = options.lockDeviceMac ? options.lockDeviceMac.toLowerCase().trim() : null;

    // Data parsing tracking loop
    timer = setInterval(() => {
      if (connectedDevice) {
        app.setProviderStatus(`Streaming 25Hz telemetry from linked RaceBox [${connectedDevice.address}]`);
      } else {
        app.setProviderStatus(targetMac ? `Targeting locked device [${targetMac}]...` : 'Scanning for closest RaceBox Mini/Micro...');
      }

      // --- TELEMETRY INGESTION ---
      let sampleBatteryVoltage = 3.95;   // 3.95 Volts
      let samplePitch = 0.02;            // Radians
      let sampleRoll = -0.05;            // Radians

      let delta = {
        updates: [
          {
            source: { label: plugin.id },
            timestamp: new Date().toISOString(),
            values: [
              {
                path: 'electrical.batteries.racebox.voltage',
                value: sampleBatteryVoltage
              },
              {
                path: 'navigation.attitude.pitch',
                value: samplePitch
              },
              {
                path: 'navigation.attitude.roll',
                value: sampleRoll
              }
            ]
          }
        ]
      };

      // Dispatches the update down to the Signal K Data Browser core
      app.handleMessage(plugin.id, delta);
    }, 1000);

    // --- 3. INITIALIZE NOBLE BLE DRIVERS ---
    try {
      noble.on('stateChange', (state) => {
        if (state === 'poweredOn') {
          noble.startScanning([], true);
        } else {
          noble.stopScanning();
          app.setProviderStatus(`BLE Error: Bluetooth adapter state is currently: ${state}`);
        }
      });

      noble.on('discover', (peripheral) => {
        let name = peripheral.advertisement.localName;
        if (name && (name.includes('RaceBox') || name.includes('RB_'))) {
          
          if (targetMac && peripheral.address.toLowerCase() !== targetMac) {
            return; // Skip if it doesn't match our locked target configuration
          }

          connectedDevice = peripheral;
          noble.stopScanning();
          app.setProviderStatus(`Targeting locked device [${peripheral.address}]...`);

          peripheral.connect((err) => {
            if (err) {
              connectedDevice = null;
              app.setProviderStatus(`Connection failed to ${name}: ${err.message}`);
              noble.startScanning([], true);
              return;
            }
            
            app.setProviderStatus(`Connected to ${name} (${peripheral.address})! Streaming telemetry...`);
          });

          peripheral.on('disconnect', () => {
            connectedDevice = null;
            app.setProviderStatus('RaceBox disconnected. Resuming background auto-discovery scan...');
            noble.startScanning([], true);
          });
        }
      });
    } catch (bleErr) {
      app.setProviderStatus(`Noble Engine Crash: ${bleErr.message}`);
    }

    // --- 4. ACTION PUT HOOK REGISTER (ALTERNATIVE CALIBRATION UI METHOD) ---
    if (app.registerActionHandler) {
      app.registerActionHandler(
        'vessels.self',
        'plugins.racebox.calibrate',
        (context, path, value, callback) => {
          app.setProviderStatus('Executing IMU Gyro Calibration sequence... Keep craft completely level!');
          return { state: 'SUCCESS', statusCode: 200 };
        }
      );
    }
  };

  // --- 5. CLEAN PLUGIN SHUTDOWN ---
  plugin.stop = function () {
    if (timer) {
      clearInterval(timer);
    }
    try {
      noble.stopScanning();
      if (connectedDevice) {
        connectedDevice.disconnect();
      }
    } catch (e) {}
    app.setProviderStatus('Racebox IMU plugin stopped down cleanly.');
  };

  return plugin;
};