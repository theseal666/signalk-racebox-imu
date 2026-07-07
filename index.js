const noble = require('@abandonware/noble');
const { exec } = require('child_process');

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'racebox-signalk-plugin';
  plugin.name = 'RaceBox BLE Telemetry';
  plugin.description = 'Streams 25Hz GNSS and 6-Axis IMU data from RaceBox Mini/Micro directly into Signal K';

  // Strict Nordic UART Service mappings used by RaceBox
  const SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e'; 
  const TX_UUID      = '6e400003b5a3f393e0a9e50e24dcca9e';      
  
  let rxBuffer = Buffer.alloc(0);
  let connectedPeripheral = null;
  let isConnecting = false;
  let calibrationRequested = false;
  let activeOptions = {};

  // Dynamic config options inside the Signal K Admin UI
  plugin.schema = {
    type: 'object',
    properties: {
      zeroImuNow: {
        type: 'boolean',
        title: '👉 CALIBRATE IMU: Check this box and click Save while the boat is level and floating naturally to zero out Pitch & Roll offsets.',
        default: false
      },
      rebootBluetoothStack: {
        type: 'boolean',
        title: '🔄 RESET BLUETOOTH: Check this box and click Save to force-cycle the system Bluetooth radio and clear connection lockups.',
        default: false
      },
      offsets: {
        type: 'object',
        title: 'Saved Calibration Pitch/Roll Offsets (radians)',
        properties: {
          pitch: { type: 'number', default: 0 },
          roll: { type: 'number', default: 0 }
        }
      }
    }
  };

  plugin.start = function (options) {
    activeOptions = options || { offsets: { pitch: 0, roll: 0 } };

    // Action 1: Hard Reset Linux Bluetooth Stack
    if (activeOptions.rebootBluetoothStack) {
      app.setProviderStatus('Executing hardware hcitool/hciconfig reset...');
      activeOptions.rebootBluetoothStack = false;
      app.savePluginOptions(activeOptions, () => {});
      exec('sudo hciconfig hci0 down && sudo hciconfig hci0 up', () => {});
      return;
    }

    // Action 2: Arm Calibration Flag
    if (activeOptions.zeroImuNow) {
      calibrationRequested = true;
      app.setProviderStatus('Armed for calibration! Awaiting next clean data packet...');
    } else {
      app.setProviderStatus('Initializing Bluetooth subsystem...');
    }

    // Clean old listeners to prevent memory leaking duplication
    noble.removeAllListeners('stateChange');
    noble.removeAllListeners('discover');

    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        if (!connectedPeripheral && !isConnecting) {
          app.setProviderStatus('Scanning for RaceBox hardware...');
          noble.startScanning([], false);
        }
      } else {
        app.setProviderStatus(`Bluetooth radio state: ${state}`);
        noble.stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      if (isConnecting || connectedPeripheral) return;

      const localName = peripheral.advertisement.localName;
      if (localName && localName.startsWith('RaceBox')) {
        isConnecting = true;
        app.setProviderStatus(`Found ${localName}! Opening connection channel...`);
        noble.stopScanning();

        // 500ms delay protects against BlueZ concurrent socket request crashes
        setTimeout(() => connectToDevice(peripheral), 500);
      }
    });

    // Fire initial state check manually
    if (noble.state === 'poweredOn') {
      app.setProviderStatus('Scanning for RaceBox hardware...');
      noble.startScanning([], false);
    }
  };

  plugin.stop = function () {
    app.setProviderStatus('Stopped');
    noble.removeAllListeners('stateChange');
    noble.removeAllListeners('discover');
    noble.stopScanning();
    if (connectedPeripheral) {
      try { connectedPeripheral.disconnect(); } catch (e) {}
    }
    connectedPeripheral = null;
    isConnecting = false;
  };

  function connectToDevice(peripheral) {
    connectedPeripheral = peripheral;

    peripheral.connect((err) => {
      if (err) {
        app.setProviderStatus(`Link failed: ${err.message}. Retrying...`);
        cleanupAndRestartScan();
        return;
      }

      app.setProviderStatus('Connected. Syncing targeted GATT profile...');

      // Fixes the freeze: explicitly find ONLY the exact RaceBox Service UUID
      peripheral.discoverServices([SERVICE_UUID], (sErr, services) => {
        if (sErr || !services || services.length === 0) {
          app.setProviderStatus('Error: Targeted RaceBox service structure not exposed.');
          cleanupAndRestartScan();
          return;
        }

        // Explicitly find ONLY the exact RaceBox TX Characteristic UUID
        services[0].discoverCharacteristics([TX_UUID], (cErr, characteristics) => {
          isConnecting = false; 

          const txChar = characteristics ? characteristics.find(c => c.uuid === TX_UUID) : null;
          if (cErr || !txChar) {
            app.setProviderStatus('Error: Core telemetry stream characteristic not found.');
            cleanupAndRestartScan();
            return;
          }

          app.setProviderStatus('Subscribing to 25Hz telemetry stream...');
          txChar.subscribe((subErr) => {
            if (subErr) {
              app.setProviderStatus(`Subscription denied: ${subErr.message}`);
              cleanupAndRestartScan();
            } else {
              app.setProviderStatus('Streaming live data successfully into Signal K.');
            }
          });

          txChar.on('data', (rawBytes) => {
            processIncomingBytes(rawBytes);
          });
        });
      });
    });

    peripheral.on('disconnect', () => {
      app.setProviderStatus('Device link severed. Searching for hardware...');
      cleanupAndRestartScan();
    });
  }

  function cleanupAndRestartScan() {
    if (connectedPeripheral) {
      try { connectedPeripheral.disconnect(); } catch(e) {}
    }
    connectedPeripheral = null;
    isConnecting = false;
    rxBuffer = Buffer.alloc(0);
    if (noble.state === 'poweredOn') {
      noble.startScanning([], false);
    }
  }

  // --- Stream Buffer Re-assembly Pipeline ---
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

      // Verify checksum integrity
      let ckA = 0, ckB = 0;
      for (let i = 2; i < totalPacketLength - 2; i++) {
        ckA = (ckA + packet[i]) & 0xFF;
        ckB = (ckB + ckA) & 0xFF;
      }

      if (ckA === packet[totalPacketLength - 2] && ckB === packet[totalPacketLength - 1]) {
        if (msgClass === 0xFF && msgId === 0x01) {
          parseRaceBoxData(payload);
        }
      }

      rxBuffer = rxBuffer.slice(totalPacketLength);
    }
  }

  // --- Core Binary Packet Parser ---
  function parseRaceBoxData(payload) {
    if (payload.length < 80) return;

    const values = [];

    // 1. Raw 6-Axis IMU Sensor Channels
    const accelX = payload.readInt16LE(40) / 1000; // Front/Back (g)
    const accelY = payload.readInt16LE(42) / 1000; // Side/Side (g)
    const accelZ = payload.readInt16LE(44) / 1000; // Vertical (g)

    const gyroX = (payload.readInt16LE(46) / 100) * (Math.PI / 180); // Roll rate (rad/s)
    const gyroY = (payload.readInt16LE(48) / 100) * (Math.PI / 180); // Pitch rate (rad/s)
    const gyroZ = (payload.readInt16LE(50) / 100) * (Math.PI / 180); // Yaw rate/Rate of Turn (rad/s)

    // Calculate immediate derived Pitch/Roll orientation angles
    const calculatedRoll = Math.atan2(accelY, accelZ);
    const calculatedPitch = Math.atan2(-accelX, Math.sqrt(accelY * accelY + accelZ * accelZ));

    // Live execution of boat level calibration request
    if (calibrationRequested) {
      calibrationRequested = false;
      activeOptions.zeroImuNow = false;
      activeOptions.offsets = { pitch: calculatedPitch, roll: calculatedRoll };
      app.savePluginOptions(activeOptions, () => {
        app.debug('Boat alignment calibration successful.');
      });
    }

    // Apply baseline alignment offsets
    const currentOffsets = activeOptions.offsets || { pitch: 0, roll: 0 };
    const finalRoll = calculatedRoll - currentOffsets.roll;
    const finalPitch = calculatedPitch - currentOffsets.pitch;

    // Push 6 IMU metrics and calculated values to standard paths
    values.push(
      { path: 'navigation.attitude.roll', value: finalRoll },
      { path: 'navigation.attitude.pitch', value: finalPitch },
      { path: 'navigation.rateOfTurn', value: gyroZ }, // Gyro Z is standard ROT
      { path: 'navigation.accel.x', value: accelX },
      { path: 'navigation.accel.y', value: accelY },
      { path: 'navigation.accel.z', value: accelZ },
      { path: 'navigation.gyro.x', value: gyroX },
      { path: 'navigation.gyro.y', value: gyroY }
    );

    // 2. Read System State Metrics
    const batteryPercent = payload.readUInt8(52); // Battery level %
    values.push({ 
      path: 'electrical.batteries.racebox.capacity.stateOfCharge', 
      value: batteryPercent / 100 
    });

    // 3. High-Performance GNSS Engine Extraction
    const fixStatus = payload.readUInt8(14); 
    const satellitesConnected = payload.readUInt8(15);
    const positionAccuracyMm = payload.readUInt32LE(36); // Horizontal Accuracy (mm)

    values.push(
      { path: 'navigation.gnss.satellites', value: satellitesConnected },
      { path: 'navigation.gnss.horizontalDilution', value: positionAccuracyMm / 1000 } // Expose in meters
    );

    // Only broadcast tracking and position vectors if a live 2D/3D fix exists
    if (fixStatus >= 2) { 
      const lat = payload.readInt32LE(16) / 10000000;
      const lon = payload.readInt32LE(20) / 10000000;

      const speedMms = payload.readUInt32LE(28); 
      const speedMs = speedMms / 1000;          
      
      const headingDegreesScaled = payload.readInt32LE(32); 
      const headingRad = (headingDegreesScaled / 100000) * (Math.PI / 180); 

      values.push(
        { path: 'navigation.position', value: { latitude: lat, longitude: lon } },
        { path: 'navigation.speedOverGround', value: speedMs },
        { path: 'navigation.courseOverGroundTrue', value: headingRad },
        { path: 'navigation.gnss.type', value: 'GPS+GLONASS+GALILEO' }
      );
    }

    // Deliver unified update packet right to the Signal K Data Browser
    app.handleMessage(plugin.id, {
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values: values
        }
      ]
    });
  }

  return plugin;
};