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
  let isConnecting = false; // Core lock to prevent connection overlapping loops
  let messageCount = 0;
  let statusInterval = null;
  let activeOptions = {};
  let performCalibrationNextPacket = false;

  // --- 1. Interactive Configuration Schema ---
  plugin.schema = {
    type: 'object',
    properties: {
      enableIMU: {
        type: 'boolean',
        title: 'Enable IMU Streaming (Pitch, Roll, Rate of Turn)',
        default: true
      },
      triggerCalibration: {
        type: 'boolean',
        title: '👉 CALIBRATE IMU NOW (Check this box and click Save while the boat is floating naturally at rest to zero out Pitch, Roll, and Yaw-rate offsets)',
        default: false
      },
      triggerBleReset: {
        type: 'boolean',
        title: '🔄 FORCE BLUETOOTH RESET (Check this box and click Save to hard-reboot the system Bluetooth stack and force a fresh device scan)',
        default: false
      },
      calibrationOffsets: {
        type: 'object',
        title: 'Current Saved Calibration Offsets',
        properties: {
          pitch: { type: 'number', default: 0 },
          roll: { type: 'number', default: 0 },
          yawRate: { type: 'number', default: 0 }
        }
      }
    }
  };

  // --- 2. Plugin Lifecycle Management ---
  plugin.start = function (options, restartPlugin) {
    app.debug('RaceBox plugin starting...');
    activeOptions = options || { enableIMU: true, calibrationOffsets: { pitch: 0, roll: 0, yawRate: 0 } };

    if (activeOptions.triggerBleReset) {
      app.setProviderStatus('Executing hard Bluetooth interface cycle...');
      activeOptions.triggerBleReset = false;
      app.savePluginOptions(activeOptions, () => {});
      
      exec('sudo hciconfig hci0 down && sudo hciconfig hci0 up', (err) => {
        if (err) app.error(`Bluetooth hard reset failed: ${err.message}`);
        setTimeout(() => { restartPlugin(activeOptions); }, 2000);
      });
      return; 
    }

    if (activeOptions.triggerCalibration) {
      performCalibrationNextPacket = true;
      app.setProviderStatus('Awaiting next telemetry frame to calibrate...');
    } else {
      app.setProviderStatus('Initializing Bluetooth discovery...');
    }

    noble.removeAllListeners('stateChange');
    noble.removeAllListeners('discover');

    noble.on('stateChange', handleBluetoothState);
    noble.on('discover', handleDiscovery);

    handleBluetoothState(noble.state);

    statusInterval = setInterval(() => {
      if (connectedDevice && messageCount > 0) {
        app.setProviderStatus(`Connected to ${connectedDevice.advertisement.localName} (Streaming data)`);
        messageCount = 0;
      }
    }, 5000);
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
        app.debug(`Disconnect error: ${e.message}`);
      }
    }
    noble.stopScanning();
    connectedDevice = null;
    isConnecting = false;
    app.setProviderStatus('Stopped');
  };

  // --- 3. BLE Connectivity ---
  function handleBluetoothState(state) {
    if (state === 'poweredOn') {
      if (!connectedDevice && !isConnecting) {
        app.setProviderStatus('Scanning for RaceBox hardware...');
        noble.startScanning([], false); 
      }
    } else {
      app.setProviderStatus(`Bluetooth unavailable: ${state}`);
      noble.stopScanning();
    }
  }

  function handleDiscovery(peripheral) {
    // If we are already handling a connection attempt, kill duplicate triggers immediately
    if (isConnecting || connectedDevice) return;

    const name = peripheral.advertisement.localName;
    if (name && name.startsWith('RaceBox')) {
      isConnecting = true; 
      app.setProviderStatus(`Found ${name}! Halting active scan slots...`);
      noble.stopScanning();
      
      // Let BlueZ completely clear out the scanning sockets before spinning up connection lines
      setTimeout(() => {
        app.setProviderStatus(`Connecting directly to ${name}...`);
        connectToDevice(peripheral);
      }, 500);
    }
  }

  function connectToDevice(peripheral) {
    connectedDevice = peripheral;
    
    peripheral.connect((error) => {
      if (error) {
        app.setProviderStatus(`Connection failed: ${error.message}`);
        retryScanning();
        return;
      }
      
      app.setProviderStatus(`Connected to ${peripheral.advertisement.localName}. Waiting for GATT sync...`);
      
      setTimeout(() => {
        app.setProviderStatus('Querying all data streams from device...');
        
        peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
          // Clear connection lock since discovery successfully wrapped up
          isConnecting = false; 

          if (err) {
            app.setProviderStatus(`Service discovery error: ${err.message}`);
            retryScanning();
            return;
          }
          
          const txChar = characteristics.find(c => c.uuid.toLowerCase() === RACEBOX_TX_UUID);
          
          if (txChar) {
            txChar.subscribe((subErr) => {
              if (subErr) {
                app.setProviderStatus(`Subscription error: ${subErr.message}`);
                retryScanning();
              } else {
                app.setProviderStatus('Streaming live data successfully.');
              }
            });
            
            txChar.on('data', (data) => {
              processIncomingBytes(data);
            });
          } else {
            app.setProviderStatus('Error: Core telemetry stream UUID not found.');
            retryScanning();
          }
        });
      }, 1000);
    });

    peripheral.on('disconnect', () => {
      app.setProviderStatus('Device link lost. Re-scanning...');
      retryScanning();
    });
  }

  function retryScanning() {
    if (connectedDevice) {
      try { connectedDevice.disconnect(); } catch(e) {}
    }
    connectedDevice = null;
    isConnecting = false;
    rxBuffer = Buffer.alloc(0);
    if (noble.state === 'poweredOn') {
      noble.startScanning([], false);
    }
  }

  // --- 4. Byte Stream Reassembly & Parsers ---
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

    const values = [];

    if (activeOptions.enableIMU) {
      const gX = payload.readInt16LE(40) / 1000; 
      const gY = payload.readInt16LE(42) / 1000; 
      const gZ = payload.readInt16LE(44) / 1000; 

      const rotZ = (payload.readInt16LE(50) / 100) * (Math.PI / 180); 

      const rawRoll = Math.atan2(gY, gZ);
      const rawPitch = Math.atan2(-gX, Math.sqrt(gY * gY + gZ * gZ));
      const rawYawRate = rotZ; 

      if (performCalibrationNextPacket) {
        performCalibrationNextPacket = false;
        activeOptions.triggerCalibration = false;
        activeOptions.calibrationOffsets = { pitch: rawPitch, roll: rawRoll, yawRate: rawYawRate };
        
        app.savePluginOptions(activeOptions, () => {
          app.debug('Static natural floating calibration offsets saved.');
        });
      }

      const offsets = activeOptions.calibrationOffsets || { pitch: 0, roll: 0, yawRate: 0 };
      const calibratedRoll = rawRoll - (offsets.roll || 0);
      const calibratedPitch = rawPitch - (offsets.pitch || 0);
      const calibratedYawRate = rawYawRate - (offsets.yawRate || 0);

      values.push(
        { path: 'navigation.attitude.roll', value: calibratedRoll },
        { path: 'navigation.attitude.pitch', value: calibratedPitch },
        { path: 'navigation.rateOfTurn', value: calibratedYawRate },
        { path: 'navigation.accel.x', value: gX },
        { path: 'navigation.accel.y', value: gY },
        { path: 'navigation.accel.z', value: gZ }
      );
    }

    const fixStatus = payload.readUInt8(14); 
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

    if (values.length > 0) {
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
  }

  return plugin;
};