const noble = require('@abandonware/noble');

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

  plugin.start = function (options, restartPlugin) {
    app.debug('RaceBox plugin starting...');
    app.setProviderStatus('Initializing Bluetooth...');

    // Handle Noble state changes
    noble.on('stateChange', handleBluetoothState);
    
    // Handle discovery
    noble.on('discover', handleDiscovery);

    // Trigger initial state check immediately in case BLE is already powered on
    handleBluetoothState(noble.state);

    // Set up a dashboard status reporter to show you live traffic metrics
    statusInterval = setInterval(() => {
      if (connectedDevice && messageCount > 0) {
        app.setProviderStatus(`Connected to ${connectedDevice.advertisement.localName} (Receiving updates)`);
        messageCount = 0;
      }
    }, 5000);
  };

  plugin.stop = function () {
    app.debug('RaceBox plugin stopping...');
    if (statusInterval) clearInterval(statusInterval);
    
    noble.removeListener('stateChange', handleBluetoothState);
    noble.removeListener('discover', handleDiscovery);
    
    if (connectedDevice) {
      connectedDevice.disconnect();
    }
    noble.stopScanning();
    app.setProviderStatus('Stopped');
  };

  function handleBluetoothState(state) {
    if (state === 'poweredOn') {
      app.setProviderStatus('Scanning for RaceBox devices...');
      // Scan broadly without UUID restrictions so we don't miss the advertisement
      noble.startScanning([], false); 
    } else if (state === 'poweredOff' || state === 'unauthorized' || state === 'unsupported') {
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
      
      app.setProviderStatus(`Connected to ${peripheral.advertisement.localName}. Discovering telemetry streams...`);
      
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
            app.setProviderStatus('Error: Required RaceBox data streams not found on device.');
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

  // FIFO Buffer Processor to re-assemble fragmented BLE packets
  function processIncomingBytes(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);

    while (rxBuffer.length >= 6) {
      // Find sync headers: 0xB5 0x62
      if (rxBuffer[0] !== 0xB5 || rxBuffer[1] !== 0x62) {
        rxBuffer = rxBuffer.slice(1);
        continue;
      }

      const msgClass = rxBuffer.readUInt8(2);
      const msgId = rxBuffer.readUInt8(3);
      const payloadLength = rxBuffer.readUInt16LE(4); 
      const totalPacketLength = 6 + payloadLength + 2; 

      if (rxBuffer.length < totalPacketLength) {
        break; // Wait for the rest of the bytes to arrive
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

  // Parse fields out of the 80-byte data payload
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

    const gForceX = payload.readInt16LE(40) / 1000; 
    const gForceY = payload.readInt16LE(42) / 1000; 
    const gForceZ = payload.readInt16LE(44) / 1000; 

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
            { path: 'navigation.accel.x', value: gForceX },
            { path: 'navigation.accel.y', value: gForceY },
            { path: 'navigation.accel.z', value: gForceZ }
          ]
        }
      ]
    };

    app.handleMessage(plugin.id, delta);
  }

  return plugin;
};