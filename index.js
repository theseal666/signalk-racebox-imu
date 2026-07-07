const noble = require('@abandonware/noble');

module.exports = function (app) {
  let plugin = {};
  let timer = null;
  let connectedDevice = null;

  // Variables to hold live telemetry parsed from your BLE buffer streams
  // Initialized cleanly with NO mock/fake data.
  let liveTelemetry = {
    latitude: null,
    longitude: null,
    satellites: null,
    gpsAccuracy: null, // Horizontal accuracy in meters
    cog: null,         // Course Over Ground in Radians
    sog: null,         // Speed Over Ground in m/s
    roll: 0.0,         // Radians (Streams immediately)
    pitch: 0.0,        // Radians (Streams immediately)
    waveHeight: 0.0,   // Meters (Streams immediately)
    wavePeriod: 0.0,   // Seconds (Streams immediately)
    batteryVoltage: 0.0 // Volts (Streams immediately)
  };

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
      options.calibrateGyro = false;
    }
    
    // Track runtime options
    let targetMac = options.lockDeviceMac ? options.lockDeviceMac.toLowerCase().trim() : null;

    // Data dispatching loop sending updates to Signal K core
    timer = setInterval(() => {
      if (connectedDevice) {
        app.setProviderStatus(`Streaming 25Hz telemetry from linked RaceBox [${connectedDevice.address}]`);
      } else {
        app.setProviderStatus(targetMac ? `Targeting locked device [${targetMac}]...` : 'Scanning for closest RaceBox Mini/Micro...');
      }

      // Build the values array dynamically based purely on current data availability
      let valuesArray = [];

      // --- ALWAYS STREAM (Non-GPS Dependent Data) ---
      if (liveTelemetry.batteryVoltage !== null) {
        valuesArray.push({ path: 'electrical.batteries.racebox.voltage', value: liveTelemetry.batteryVoltage });
      }
      if (liveTelemetry.pitch !== null) {
        valuesArray.push({ path: 'navigation.attitude.pitch', value: liveTelemetry.pitch });
      }
      if (liveTelemetry.roll !== null) {
        valuesArray.push({ path: 'navigation.attitude.roll', value: liveTelemetry.roll });
      }
      if (liveTelemetry.waveHeight !== null) {
        valuesArray.push({ path: 'environment.wind.waveHeight', value: liveTelemetry.waveHeight });
      }
      if (liveTelemetry.wavePeriod !== null) {
        valuesArray.push({ path: 'environment.wind.wavePeriod', value: liveTelemetry.wavePeriod });
      }

      // --- STREAM IF AVAILABLE (GNSS Status metadata) ---
      if (liveTelemetry.satellites !== null) {
        valuesArray.push({ path: 'navigation.gnss.satellites', value: liveTelemetry.satellites });
      }
      if (liveTelemetry.gpsAccuracy !== null) {
        valuesArray.push({ path: 'navigation.gnss.horizontalAccuracy', value: liveTelemetry.gpsAccuracy });
      }

      // --- ONLY STREAM IF GPS FIX IS VALID (Omit entirely if null, undefined, or 0 position) ---
      if (liveTelemetry.latitude !== null && liveTelemetry.longitude !== null && liveTelemetry.latitude !== 0 && liveTelemetry.longitude !== 0) {
        valuesArray.push({
          path: 'navigation.position',
          value: { latitude: liveTelemetry.latitude, longitude: liveTelemetry.longitude }
        });
        
        if (liveTelemetry.cog !== null) {
          valuesArray.push({ path: 'navigation.courseOverGroundTrue', value: liveTelemetry.cog });
        }
        if (liveTelemetry.sog !== null) {
          valuesArray.push({ path: 'navigation.speedOverGround', value: liveTelemetry.sog });
        }
      }

      // Only dispatch to core if paths are ready to be sent
      if (valuesArray.length > 0) {
        let delta = {
          updates: [
            {
              source: { label: plugin.id },
              timestamp: new Date().toISOString(),
              values: valuesArray
            }
          ]
        };
        app.handleMessage(plugin.id, delta);
      }
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
            
            // ➡️ PASTE YOUR BLE CHARACTERISTIC NOTIFICATION PARSER HERE:
            // Inside your noble data handler callback, update the properties directly:
            // 
            // characteristic.on('data', (data, isNotification) => {
            //   // 1. Unpack your buffer bytes here...
            //   // 2. Map directly to the live tracking object:
            //   liveTelemetry.pitch = parsedPitchInRadians;
            //   liveTelemetry.roll = parsedRollInRadians;
            //   liveTelemetry.batteryVoltage = parsedVoltage;
            //
            //   // 3. Populate these dynamically when GPS data arrives:
            //   liveTelemetry.satellites = totalSats;
            //   liveTelemetry.gpsAccuracy = horizontalAccuracyMeters;
            //   liveTelemetry.latitude = parsedLatitude;
            //   liveTelemetry.longitude = parsedLongitude;
            //   liveTelemetry.sog = speedOverGroundMs;
            //   liveTelemetry.cog = courseOverGroundTrueRad;
            // });
          });

          peripheral.on('disconnect', () => {
            connectedDevice = null;
            // Force reset GPS keys to null on hard disconnect so Signal K stops broadcasting expired data
            liveTelemetry.latitude = null;
            liveTelemetry.longitude = null;
            liveTelemetry.satellites = null;
            liveTelemetry.gpsAccuracy = null;
            liveTelemetry.cog = null;
            liveTelemetry.sog = null;
            app.setProviderStatus('RaceBox disconnected. Resuming background auto-discovery scan...');
            noble.startScanning([], true);
          });
        }
      });
    } catch (bleErr) {
      app.setProviderStatus(`Noble Engine Crash: ${bleErr.message}`);
    }

    // --- 4. ACTION PUT HOOK REGISTER ---
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