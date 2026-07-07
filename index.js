const noble = require('@abandonware/noble');

module.exports = function (app) {
  let plugin = {};
  let rxBuffer = Buffer.alloc(0);
  let accelEarthZBuffer = [];
  let peripheralDevice = null;
  let activeOptions = {};

  // Human-readable variable for internal logs
  let currentStatus = 'Idle. Activate plugin to begin auto-discovery.';

  plugin.id = 'signalk-racebox-imu';
  plugin.name = 'RaceBox BLE Telemetry Bridge';
  plugin.description = 'Auto-discovers and connects to any RaceBox Mini or Micro without needing a manual MAC address entry.';

  // Build the administrative user form
  plugin.schema = () => {
    // Read current configuration on load
    const currentOpts = app.readPluginOptions();
    const savedMac = currentOpts.savedMacAddress || 'None (Will discover automatically)';

    return {
      type: 'object',
      properties: {
        connectionStatusDisplay: {
          type: 'string',
          title: 'LIVE INTERFACE STATUS',
          readonly: true,
          default: `Status: ${currentStatus}\nLocked Device MAC: ${savedMac}`
        },
        triggerScanReset: {
          type: 'boolean',
          title: '🔄 Reset & Force Scan for a new RaceBox Device',
          description: 'Check this box and hit "Save" to drop the current connection and pair with the closest RaceBox.',
          default: false
        },
        windowSizeSeconds: {
          type: 'number',
          title: 'Adaptive Wave Window (Seconds)',
          default: 8
        }
      }
    };
  };

  plugin.uiSchema = {
    connectionStatusDisplay: {
      'ui:widget': 'textarea',
      'ui:options': { rows: 3 }
    }
  };

  plugin.start = function (options) {
    activeOptions = options;
    app.debug('RaceBox Auto-Discovery engine started.');

    // Handle user clicking the "Reset & Force Scan" checkbox
    if (options.triggerScanReset === true) {
      app.debug('Reset requested by user. Clearing saved MAC memory.');
      options.savedMacAddress = null;
      options.triggerScanReset = false; // Reset toggle state
      
      // Persist the wiped settings back to the Signal K database file
      app.savePluginOptions(options, (err) => {
        if (err) app.error('Failed to save reset configuration:', err);
      });
    }

    currentStatus = options.savedMacAddress 
      ? `Targeting locked device [${options.savedMacAddress}]...` 
      : 'Searching broadly for any RaceBox Micro/Mini...';
    
    setServerStatus(currentStatus);

    // Turn on the Bluetooth scanning loop
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        noble.startScanning([], true);
      } else {
        setServerStatus(`Bluetooth Failure: Adapter is "${state}"`);
      }
    });

    noble.on('discover', (peripheral) => {
      const localName = peripheral.advertisement.localName || '';
      const isRaceBox = localName.toLowerCase().includes('racebox');
      const targetMac = options.savedMacAddress;

      // Match Condition: If we have a locked MAC, look for it. If not, pick up the first RaceBox.
      if ((targetMac && peripheral.address.toLowerCase() === targetMac.toLowerCase()) || (!targetMac && isRaceBox)) {
        
        if (!targetMac) {
          app.debug(`Auto-discovered new device: ${localName} (${peripheral.address})`);
          options.savedMacAddress = peripheral.address;
          
          // Permanently lock this MAC address into config file so it connects seamlessly on next reboot
          app.savePluginOptions(options, (err) => {
            if (err) app.error('Failed to auto-save discovered MAC:', err);
          });
        }

        noble.stopScanning();
        peripheralDevice = peripheral;
        connectToDevice(peripheral);
      }
    });
  };

  plugin.stop = function () {
    noble.stopScanning();
    if (peripheralDevice) {
      peripheralDevice.disconnect();
      peripheralDevice = null;
    }
    currentStatus = 'Stopped.';
    setServerStatus(currentStatus);
  };

  function setServerStatus(statusString) {
    currentStatus = statusString;
    // Pushes status updates to the server UI status line under Application Settings
    if (app.setPluginStatus) {
      app.setPluginStatus(statusString);
    } else {
      app.reportOutputMessages && app.reportOutputMessages(statusString);
    }
  }

  function connectToDevice(peripheral) {
    setServerStatus(`Connecting to ${peripheral.advertisement.localName || 'RaceBox'}...`);

    peripheral.connect((err) => {
      if (err) {
        setServerStatus(`Connection Error: ${err.message}. Retrying search.`);
        noble.startScanning([], true);
        return;
      }

      setServerStatus(`⚡ Connected to ${peripheral.advertisement.localName} [${peripheral.address}]`);

      peripheral.on('disconnect', () => {
        setServerStatus('❌ Connection lost. Re-scanning for device...');
        peripheralDevice = null;
        noble.startScanning([], true);
      });

      const UART_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
      const TX_CHAR_UUID = '6e400003b5a3f393e0a9e50e24dcca9e';

      peripheral.discoverSomeServicesAndCharacteristics([UART_SERVICE_UUID], [TX_CHAR_UUID], (err, services, characteristics) => {
        if (err) return setServerStatus(`Service discovery error: ${err.message}`);
        
        const txChar = characteristics.find(c => c.uuid.toLowerCase() === TX_CHAR_UUID);
        if (txChar) {
          txChar.subscribe();
          txChar.on('data', (chunk) => {
            rxBuffer = Buffer.concat([rxBuffer, chunk]);
            processByteStream();
          });
        }
      });
    });
  }

  function processByteStream() {
    while (rxBuffer.length >= 86) {
      if (rxBuffer[0] !== 0xB5 || rxBuffer[1] !== 0x62) {
        rxBuffer = rxBuffer.slice(1);
        continue;
      }
      if (rxBuffer[2] !== 0xFF || rxBuffer[3] !== 0x01) {
        rxBuffer = rxBuffer.slice(2);
        continue;
      }
      const payloadLen = rxBuffer.readUInt16LE(4);
      if (payloadLen !== 80) {
        rxBuffer = rxBuffer.slice(2);
        continue;
      }

      const packet = rxBuffer.slice(0, 86);
      rxBuffer = rxBuffer.slice(86);

      let cka = 0, ckb = 0;
      for (let i = 2; i < 84; i++) {
        cka = (cka + packet[i]) & 0xFF;
        ckb = (ckb + cka) & 0xFF;
      }
      if (packet[84] !== cka || packet[85] !== ckb) continue;

      parseRaceBoxPayload(packet.slice(6, 86));
    }
  }

  function parseRaceBoxPayload(payload) {
    const lon = payload.readInt32LE(24) / 10000000.0;
    const lat = payload.readInt32LE(28) / 10000000.0;
    const mslAltitude = payload.readInt32LE(36) / 1000.0; 
    const speedMs = payload.readInt32LE(48) / 1000.0;
    const heading = payload.readInt32LE(52) / 100000.0;
    const numSVs = payload.readUInt8(23);

    const g = 9.80665;
    const accX = (payload.readInt16LE(68) / 1000.0) * g;
    const accY = (payload.readInt16LE(70) / 1000.0) * g;
    const accZ = (payload.readInt16LE(72) / 1000.0) * g;

    const degToRad = Math.PI / 180.0;
    const gyroX = (payload.readInt16LE(74) / 100.0) * degToRad;
    const gyroY = (payload.readInt16LE(76) / 100.0) * degToRad;

    const dt = 1 / 25.0;
    let roll = Math.atan2(accY, accZ);
    let pitch = Math.atan2(-accX, Math.sqrt(accY * accY + accZ * accZ));

    const accelEarthZ = (accX * Math.sin(pitch)) - (accY * Math.sin(roll) * Math.cos(pitch)) + (accZ * Math.cos(roll) * Math.cos(pitch)) - g;

    const maxSamples = activeOptions.windowSizeSeconds * 25;
    accelEarthZBuffer.push(accelEarthZ);
    if (accelEarthZBuffer.length > maxSamples) accelEarthZBuffer.shift();

    let waveHeight = 0;
    let wavePeriod = 0;

    if (accelEarthZBuffer.length >= maxSamples) {
      let velocity = 0;
      let displacement = 0;
      let displacements = [];
      const alpha = 0.98;

      for (let i = 0; i < accelEarthZBuffer.length; i++) {
        velocity = alpha * (velocity + accelEarthZBuffer[i] * dt);
        displacement = alpha * (displacement + velocity * dt);
        displacements.push(displacement);
      }

      const maxCrest = Math.max(...displacements);
      const minTrough = Math.min(...displacements);
      const rawHeight = maxCrest - minTrough;

      if (rawHeight > 0.05) {
        waveHeight = rawHeight;
        let upCrossings = 0;
        for (let i = 1; i < displacements.length; i++) {
          if (displacements[i - 1] < 0 && displacements[i] >= 0) {
            upCrossings++;
          }
        }
        wavePeriod = upCrossings > 0 ? (activeOptions.windowSizeSeconds / upCrossings) : 0;
      }
    }

    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            { path: 'navigation.position', value: { longitude: lon, latitude: lat } },
            { path: 'navigation.gnss.satellites', value: numSVs },
            { path: 'navigation.courseOverGroundTrue', value: heading * (Math.PI / 180.0) },
            { path: 'navigation.speedOverGround', value: speedMs },
            { path: 'navigation.attitude.roll', value: roll },
            { path: 'navigation.attitude.pitch', value: pitch },
            { path: 'environment.wind.waveHeight', value: waveHeight },
            { path: 'environment.wind.wavePeriod', value: wavePeriod }
          ]
        }
      ]
    });
  }

  return plugin;
};