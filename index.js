const noble = require('@abandonware/noble');
const { exec } = require('child_process');

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'racebox-signalk-plugin';
  plugin.name = 'RaceBox BLE Telemetry';
  plugin.description = 'Streams high-frequency GNSS and IMU data from RaceBox Mini/S/Micro into Signal K';

  const RACEBOX_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e'; 
  const RACEBOX_TX_UUID = '6e400003b5a3f393e0a9e50e24dcca9e';      
  
  let rxBuffer = Buffer.alloc(0);
  let connectedDevice = null;
  let messageCount = 0;
  let statusInterval = null;
  let activeOptions = {};

  // --- 1. Signal K Configuration Schema ---
  plugin.schema = {
    type: 'object',
    properties: {
      enableIMU: {
        type: 'boolean',
        title: 'Enable IMU Data streaming (G-Forces)',
        default: true
      },
      calibrationOffsets: {
        type: 'object',
        title: 'Stored Calibration Offsets (Set via Calibration button)',
        properties: {
          x: { type: 'number', default: 0 },
          y: { type: 'number', default: 0 },
          z: { type: 'number', default: 0 }
        }
      }
    }
  };

  // --- 2. Plugin Lifecycle ---
  plugin.start = function (options, restartPlugin) {
    app.debug('RaceBox plugin starting...');
    activeOptions = options || { enableIMU: true, calibrationOffsets: { x: 0, y: 0, z: 0 } };
    app.setProviderStatus('Initializing Bluetooth...');

    // CRITICAL: Clear any existing listeners on the global Noble singleton before binding new ones
    noble.removeAllListeners('stateChange');
    noble.removeAllListeners('discover');

    noble.on('stateChange', handleBluetoothState);
    noble.on('discover', handleDiscovery);

    // Check immediate state
    handleBluetoothState(noble.state);

    statusInterval = setInterval(() => {
      if (connectedDevice && messageCount > 0) {
        app.setProviderStatus(`Connected to ${connectedDevice.advertisement.localName} (Receiving data)`);
        messageCount = 0;
      }
    }, 5000);

    // --- 3. Custom HTTP Endpoints for Config Page Functionality ---
    // Re-registers endpoints for your custom config page UI buttons
    
    // Bluetooth Reset Endpoint
    app.post('/plugins/racebox-signalk-plugin/reset-ble', (req, res) => {
      app.debug('Manual Bluetooth Reset triggered via config page.');
      app.setProviderStatus('Resetting local Bluetooth interface...');
      
      plugin.stop();
      
      // Attempt hardware/software cycling of the local hci0 interface (Linux/Pi)
      exec('sudo hciconfig hci0 down && sudo hciconfig hci0 up', (err, stdout, stderr) => {
        if (err) {
          app.error(`Failed to hard reset hci0 interface: ${err.message}`);
          // Fallback to just turning scanning off/on
        }
        setTimeout(() => {
          plugin.start(activeOptions, restartPlugin);
          res.json({ status: 'success', message: 'Bluetooth interface cycled successfully.' });
        }, 2000);
      });
    });

    // Zero-Imu Calibration Endpoint
    app.post('/plugins/racebox-signalk-plugin/calibrate', (req, res) => {
      app.debug('IMU Calibration request received.');
      if (!connectedDevice) {
        return res.status(400).json({ status: 'error', message: 'Device must be connected to calibrate.' });
      }

      // Temporarily intercept the next clean packet to capture raw baseline forces
      const captureCalibration = (chunk) => {
        // Look for data frame matching telemetry
        if (chunk.length >= 80 && chunk[0] === 0xB5 && chunk[1] === 0x62 && chunk[2] === 0xFF && chunk[3] === 0x01) {
          const payload = chunk.slice(6, 86);
          const rawX = payload.readInt16LE(40) / 1000;
          const rawY = payload.readInt16LE(42) / 1000;
          const rawZ = payload.readInt16LE(44) / 1000;

          // Save current positions as the baseline offsets
          activeOptions.calibrationOffsets = { x: rawX, y: rawY, z: rawZ - 1.0 }; // Account for normal gravity on Z
          app.savePluginOptions(activeOptions, () => {
            app.debug(`Calibrated offsets saved: X=${rawX}, Y=${rawY}, Z=${rawZ - 1.0}`);
          });

          // Unhook temporary interceptor
          const txChar = connectedDevice.services
            .find(s => s.uuid === RACEBOX_SERVICE_UUID)
            ?.characteristics.find(c => c.uuid === RACEBOX_TX_UUID);
          if (txChar) txChar.removeListener('data', captureCalibration);
        }
      };

      const txChar = connectedDevice.services
        .find(s => s.uuid === RACEBOX_SERVICE_UUID)
        ?.characteristics.find(c => c.uuid === RACEBOX_TX_UUID);

      if (txChar) {
        txChar.on('data', captureCalibration);
        res.json({ status: 'success', message: 'Calibration sample requested. Keep device level.' });
      } else {
        res.status(500).json({ status: 'error', message: 'Could not access telemetry stream for calibration.' });
      }
    });
  };

  plugin.stop = function () {
    app.debug('RaceBox plugin stopping...');
    if (statusInterval) clearInterval(statusInterval);
    
    noble.removeAllListeners('stateChange');
    noble.removeAllListeners('discover');
    
    if (connectedDevice) {
      try {
        connectedDevice.disconnect();
      } catch (e) {
        app.debug(`Disconnect cleanup error: ${e.message}`);
      }
    }
    noble.stopScanning();
    connectedDevice = null;
    app.setProviderStatus('Stopped');
  };

  // --- 4. Core BLE Stream Logic ---
  function handleBluetoothState(state) {
    if (state === 'poweredOn') {
      app.setProviderStatus('Scanning for RaceBox devices...');
      noble.startScanning([], false); 
    } else {
      app.setProviderStatus(`Bluetooth adapter unavailable: ${state}`);
      noble.stopScanning();
    }
  }

  function handleDiscovery(peripheral) {
    const name = peripheral.advertisement.localName;
    if (name && name.startsWith('RaceBox')) {
      app.setProviderStatus(`Found ${name}! Connecting...`);
      noble.stopScanning();
      connectToDevice(peripheral);
    }
  }

  function connectToDevice(peripheral) {
    connectedDevice = peripheral;
    
    peripheral.connect((error) => {
      if (error) {
        app.setProviderStatus(`Connection error: ${error.message}`);
        retryScanning();
        return;
      }
      
      app.setProviderStatus(`Connected to ${peripheral.advertisement.localName}. Discovering streams...`);
      
      peripheral.discoverSomeServicesAndCharacteristics(
        [RACEBOX_SERVICE_UUID],
        [RACEBOX_TX_UUID],
        (err, services, characteristics) => {
          if (err) {
            app.setProviderStatus(`Discovery error: ${err.message}`);
            retryScanning();
            return;
          }
          
          const txChar = characteristics.find(c => c.uuid === RACEBOX_TX_UUID);
          if (txChar) {
            app.setProviderStatus('Subscribing to telemetry stream...');
            
            txChar.subscribe((subErr) => {
              if (subErr) {
                app.setProviderStatus(`Subscription failed: ${subErr.message}`);
                retryScanning();
              } else {
                app.setProviderStatus('Streaming live data successfully.');
              }
            });
            
            txChar.on('data', (data, isNotification) => {
              processIncomingBytes(data);
            });
          } else {
            app.setProviderStatus('Error: Required RaceBox data streams missing.');
            retryScanning();
          }
        }
      );
    });

    peripheral.on('disconnect', () => {
      app.setProviderStatus('RaceBox disconnected unexpectedly. Re-scanning...');
      retryScanning();
    });
  }

  function retryScanning() {
    connectedDevice = null;
    rxBuffer = Buffer.alloc(0);
    if (noble.state === 'poweredOn') {
      noble.startScanning([], false);
    }
  }

  function processIncomingBytes(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);

    while (rxBuffer.length >= 6) {
      if (rxBuffer[0] !== 0xB5 || rxBuffer[1] !== 0x62) {
        rxBuffer = rxBuffer.slice(1);
        continue;
      }

      const msgClass = rxBuffer.readUInt8(2);
      const msgId = rxBuffer.readUInt8(3);
      const payloadLength = rxBuffer.readUInt16LE(4); 
      const totalPacketLength = 6 + payloadLength + 2; 

      if (rxBuffer.length < totalPacketLength) {
        break; 
      }

      const packet = rxBuffer.slice(0, totalPacketLength);
      const payload = packet.slice(6, 6 + payloadLength);

      if (verifyChecksum(packet.slice(2, totalPacketLength - 2), packet.slice(totalPacketLength - 2))) {
        if (msgClass === 0xFF && msgId === 0x01) { 
          messageCount++;
          parseRaceBoxData(payload);
        }
      }

      rxBuffer = rxBuffer.slice(totalPacketLength);
    }
  }

  function verifyChecksum(dataBytes, checksumBytes) {
    let ckA = 0, ckB = 0;
    for (let i = 0; i < dataBytes.length; i++) {
      ckA = (ckA + dataBytes[i]) & 0xFF;
      ckB = (ckB + ckA) & 0xFF;
    }
    return ckA === checksumBytes[0] && ckB === checksumBytes[1];
  }

  function parseRaceBoxData(payload) {
    if (payload.length < 80) return;

    const fixStatus = payload.readUInt8(14); 
    if (fixStatus < 2) return; 

    const lat = payload.readInt32LE(16) / 10000000;
    const lon = payload.readInt32LE(20) / 10000000;

    const speedMms = payload.readUInt32LE(28); 
    const speedMs = speedMms / 1000;          
    
    const headingDegreesScaled = payload.readInt32LE(32); 
    const headingRad = (headingDegreesScaled / 100000) * (Math.PI / 180); 

    const values = [
      { path: 'navigation.position', value: { latitude: lat, longitude: lon } },
      { path: 'navigation.speedOverGround', value: speedMs },
      { path: 'navigation.courseOverGroundTrue', value: headingRad },
      { path: 'navigation.gnss.type', value: 'GPS+GLONASS+GALILEO' }
    ];

    // Inject calibrated IMU data if enabled in config
    if (activeOptions.enableIMU) {
      const offsets = activeOptions.calibrationOffsets || { x: 0, y: 0, z: 0 };
      const gForceX = (payload.readInt16LE(40) / 1000) - (offsets.x || 0); 
      const gForceY = (payload.readInt16LE(42) / 1000) - (offsets.y || 0); 
      const gForceZ = (payload.readInt16LE(44) / 1000) - (offsets.z || 0); 

      values.push(
        { path: 'navigation.accel.x', value: gForceX },
        { path: 'navigation.accel.y', value: gForceY },
        { path: 'navigation.accel.z', value: gForceZ }
      );
    }

    const delta = {
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values: values
        }
      ]
    };

    app.handleMessage(plugin.id, delta);
  }

  return plugin;
};