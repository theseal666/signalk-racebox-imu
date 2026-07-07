const noble = require('@abandonware/noble');

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'racebox-signalk-plugin';
  plugin.name = 'RaceBox BLE Telemetry';
  plugin.description = 'Streams high-frequency GNSS and IMU data from RaceBox Mini/S/Micro into Signal K';

  // Core RaceBox Protocol Constants[cite: 1]
  const RACEBOX_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e'; // Custom UART Service[cite: 1]
  const RACEBOX_TX_UUID = '6e400003b5a3f393e0a9e50e24dcca9e';      // Notify Characteristic[cite: 1]
  
  let rxBuffer = Buffer.alloc(0);
  let connectedDevice = null;

  plugin.start = function (options, restartPlugin) {
    app.debug('RaceBox plugin starting...');
    
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        app.debug('BLE Powered On. Starting scan for RaceBox devices...');
        noble.startScanning([RACEBOX_SERVICE_UUID], false);
      } else {
        noble.stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      // Look for RaceBox broadcast names[cite: 1]
      if (peripheral.advertisement.localName && peripheral.advertisement.localName.startsWith('RaceBox')) {
        app.debug(`Found device: ${peripheral.advertisement.localName}`);
        noble.stopScanning();
        connectToDevice(peripheral);
      }
    });
  };

  plugin.stop = function () {
    app.debug('RaceBox plugin stopping...');
    if (connectedDevice) {
      connectedDevice.disconnect();
    }
    noble.stopScanning();
  };

  function connectToDevice(peripheral) {
    connectedDevice = peripheral;
    
    peripheral.connect((error) => {
      if (error) {
        app.error(`Connection error: ${error}`);
        return;
      }
      app.debug('Connected to RaceBox. Discovering services...');
      
      peripheral.discoverSomeServicesAndCharacteristics(
        [RACEBOX_SERVICE_UUID],
        [RACEBOX_TX_UUID],
        (err, services, characteristics) => {
          if (err) {
            app.error(`Discovery error: ${err}`);
            return;
          }
          
          const txChar = characteristics.find(c => c.uuid === RACEBOX_TX_UUID);
          if (txChar) {
            app.debug('Subscribing to RaceBox TX stream...');
            txChar.subscribe((subErr) => {
              if (subErr) app.error(`Subscription failed: ${subErr}`);
            });
            
            // Handle raw incoming stream data chunk by chunk[cite: 1]
            txChar.on('data', (data, isNotification) => {
              processIncomingBytes(data);
            });
          }
        }
      );
    });

    peripheral.on('disconnect', () => {
      app.debug('RaceBox disconnected. Re-scanning...');
      connectedDevice = null;
      noble.startScanning([RACEBOX_SERVICE_UUID], false);
    });
  }

  // FIFO Buffer Processor to re-assemble fragmented BLE packets[cite: 1]
  function processIncomingBytes(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);

    while (rxBuffer.length >= 6) {
      // Find sync headers: 0xB5 0x62[cite: 1]
      if (rxBuffer[0] !== 0xB5 || rxBuffer[1] !== 0xB62) {
        // If out of sync, advance 1 byte and try again[cite: 1]
        rxBuffer = rxBuffer.slice(1);
        continue;
      }

      const msgClass = rxBuffer.readUInt8(2);[cite: 1]
      const msgId = rxBuffer.readUInt8(3);[cite: 1]
      const payloadLength = rxBuffer.readUInt16LE(4); // Length field[cite: 1]
      const totalPacketLength = 6 + payloadLength + 2; // Header(6) + Payload(N) + Checksum(2)[cite: 1]

      if (rxBuffer.length < totalPacketLength) {
        // Wait for more data to arrive in the stream[cite: 1]
        break;
      }

      // Extract full packet frame
      const packet = rxBuffer.slice(0, totalPacketLength);
      const payload = packet.slice(6, 6 + payloadLength);[cite: 1]

      // Verify checksum integrity[cite: 1]
      if (verifyChecksum(packet.slice(2, totalPacketLength - 2), packet.slice(totalPacketLength - 2))) {
        if (msgClass === 0xFF && msgId === 0x01) { // Telemetry Data Message[cite: 1]
          parseRaceBoxData(payload);
        }
      }

      // Chop processed packet out of the buffer stream
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

  // Parse fields out of the 80-byte data payload[cite: 1]
  // Note: Adjust specific byte offsets below if using a customized hardware revision mapping.
  function parseRaceBoxData(payload) {
    if (payload.length < 80) return;[cite: 1]

    // 1. Verify GNSS Fix status[cite: 1]
    const fixStatus = payload.readUInt8(14); // Example offset for Fix Status[cite: 1]
    if (fixStatus < 2) return; // Ignore if there's no valid 2D/3D fix[cite: 1]

    // 2. Extract Coordinates (Scaled by 10^7)[cite: 1]
    const lat = payload.readInt32LE(16) / 10000000;[cite: 1]
    const lon = payload.readInt32LE(20) / 10000000;[cite: 1]

    // 3. Extract Speed & Heading[cite: 1]
    const speedMms = payload.readUInt32LE(28); // mm/s[cite: 1]
    const speedMs = speedMms / 1000;          // Convert mm/s to Signal K standard (m/s)
    
    const headingDegreesScaled = payload.readInt32LE(32); // Scaled by 10^5[cite: 1]
    const headingRad = (headingDegreesScaled / 100000) * (Math.PI / 180); // Convert to Radians

    // 4. Extract IMU G-Forces (Scaled milli-g)[cite: 1]
    const gForceX = payload.readInt16LE(40) / 1000; // Front/Back[cite: 1]
    const gForceY = payload.readInt16LE(42) / 1000; // Right/Left[cite: 1]
    const gForceZ = payload.readInt16LE(44) / 1000; // Up/Down[cite: 1]

    // Construct Signal K Delta Format
    const delta = {
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values: [
            { path: 'navigation.position', value: { latitude: lat, longitude: lon } },
            { path: 'navigation.speedOverGround', value: speedMs },
            { path: 'navigation.courseOverGroundTrue', value: headingRad },
            { path: 'navigation.gnss.type', value: 'GPS+GLONASS+GALILEO' },
            // Storing raw metrics dynamically under a custom key or standard keys if available
            { path: 'navigation.accel.x', value: gForceX },
            { path: 'navigation.accel.y', value: gForceY },
            { path: 'navigation.accel.z', value: gForceZ }
          ]
        }
      ]
    };

    // Emit live updates to Signal K Server pipeline
    app.handleMessage(plugin.id, delta);
  }

  return plugin;
};