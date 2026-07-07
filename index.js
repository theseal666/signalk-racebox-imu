const noble = require('@abandonware/noble');
const { exec } = require('child_process');

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'racebox-signalk-plugin';
  plugin.name = 'RaceBox BLE Telemetry';
  plugin.description = 'Streams 25Hz GNSS and 6-Axis IMU data from RaceBox Mini/Micro directly into Signal K';

  // Nordic UART Service mappings (RaceBox uses this standard)
  const SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e'; 
  const RX_UUID      = '6e400002b5a3f393e0a9e50e24dcca9e'; // Host → Device (write)
  const TX_UUID      = '6e400003b5a3f393e0a9e50e24dcca9e'; // Device → Host (notify/read)
  
  // Timeouts in ms
  const CONNECT_TIMEOUT = 10000;
  const DISCOVER_SERVICES_TIMEOUT = 5000;
  const DISCOVER_CHARACTERISTICS_TIMEOUT = 5000;
  const SUBSCRIBE_TIMEOUT = 5000;
  const SCAN_TIMEOUT = 30000;
  
  let rxBuffer = Buffer.alloc(0);
  let connectedPeripheral = null;
  let isConnecting = false;
  let calibrationRequested = false;
  let activeOptions = {};
  let dataPacketCount = 0;
  let scanTimeoutId = null;
  let connectTimeoutId = null;

  // Dynamic config options inside the Signal K Admin UI
  plugin.schema = {
    type: 'object',
    properties: {
      zeroImuNow: {
        type: 'boolean',
        title: 'CALIBRATE IMU - Check this box and click Save while the boat is level and floating naturally to zero out Pitch & Roll offsets.',
        default: false
      },
      rebootBluetoothStack: {
        type: 'boolean',
        title: 'RESET BLUETOOTH - Check this box and click Save to force-cycle the system Bluetooth radio and clear connection lockups.',
        default: false
      },
      debugLogging: {
        type: 'boolean',
        title: 'Enable debug logging to console',
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
    const debug = activeOptions.debugLogging;

    if (debug) {
      app.debug('[RaceBox] Plugin starting with options:', JSON.stringify(activeOptions));
    }

    // Action 1: Hard Reset Linux Bluetooth Stack
    if (activeOptions.rebootBluetoothStack) {
      app.setProviderStatus('RESET: Executing hciconfig reset...');
      if (debug) app.debug('[RaceBox] Bluetooth reset requested');
      
      activeOptions.rebootBluetoothStack = false;
      app.savePluginOptions(activeOptions, (err) => {
        if (err) {
          app.error('[RaceBox] Failed to clear reset flag:', err);
        } else {
          if (debug) app.debug('[RaceBox] Reset flag cleared in config');
        }
      });

      // Execute reset command with proper error handling
      exec('sudo hciconfig hci0 down && sudo hciconfig hci0 up', (error, stdout, stderr) => {
        if (error) {
          app.error('[RaceBox] Bluetooth reset error:', error.message);
          app.setProviderStatus('RESET FAILED: ' + error.message);
          if (debug) app.debug('[RaceBox] stderr:', stderr);
        } else {
          if (debug) app.debug('[RaceBox] Bluetooth reset completed successfully');
          app.setProviderStatus('RESET: Bluetooth stack cycled. Scanning for RaceBox...');
          // Restart plugin after reset
          plugin.stop();
          plugin.start(activeOptions);
        }
      });
      return;
    }

    // Action 2: Arm Calibration Flag
    if (activeOptions.zeroImuNow) {
      calibrationRequested = true;
      app.setProviderStatus('CAL: Armed for calibration. Boat must be level and floating naturally.');
      if (debug) app.debug('[RaceBox] Calibration mode armed');
      
      // Clear the flag immediately so it doesn't persist after save
      activeOptions.zeroImuNow = false;
      dataPacketCount = 0;
      
      app.savePluginOptions(activeOptions, (err) => {
        if (err) {
          app.error('[RaceBox] Failed to clear calibration flag:', err);
        } else {
          if (debug) app.debug('[RaceBox] Calibration flag cleared in config');
        }
      });
    } else {
      app.setProviderStatus('Initializing Bluetooth subsystem...');
      if (debug) app.debug('[RaceBox] Normal startup');
    }

    // Clean old listeners to prevent memory leaking duplication
    noble.removeAllListeners('stateChange');
    noble.removeAllListeners('discover');

    noble.on('stateChange', (state) => {
      if (debug) app.debug('[RaceBox] Bluetooth state changed to:', state);
      
      if (state === 'poweredOn') {
        if (!connectedPeripheral && !isConnecting) {
          app.setProviderStatus('Scanning for RaceBox hardware...');
          // Defer scanning to next tick to avoid blocking Signal K
          setImmediate(() => {
            noble.startScanning([], false);
            
            // Set scan timeout to prevent indefinite scanning
            if (scanTimeoutId) clearTimeout(scanTimeoutId);
            scanTimeoutId = setTimeout(() => {
              if (debug) app.debug('[RaceBox] Scan timeout - stopping scan');
              noble.stopScanning();
              scanTimeoutId = null;
              // Restart scan after a brief pause
              setTimeout(() => {
                if (!connectedPeripheral && !isConnecting) {
                  app.setProviderStatus('Scan timeout. Restarting scan...');
                  if (debug) app.debug('[RaceBox] Restarting scan');
                  setImmediate(() => noble.startScanning([], false));
                }
              }, 2000);
            }, SCAN_TIMEOUT);
          });
        }
      } else {
        app.setProviderStatus(`Bluetooth radio state: ${state}`);
        if (scanTimeoutId) clearTimeout(scanTimeoutId);
        noble.stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      if (isConnecting || connectedPeripheral) return;

      const localName = peripheral.advertisement.localName;
      if (localName && localName.startsWith('RaceBox')) {
        isConnecting = true;
        app.setProviderStatus(`Found ${localName}! Opening connection channel...`);
        if (debug) app.debug(`[RaceBox] Discovered device: ${localName}`);
        
        // Clear scan timeout when device found
        if (scanTimeoutId) clearTimeout(scanTimeoutId);
        scanTimeoutId = null;
        
        noble.stopScanning();

        // 500ms delay protects against BlueZ concurrent socket request crashes
        setTimeout(() => connectToDevice(peripheral), 500);
      }
    });

    // Fire initial state check manually
    if (noble.state === 'poweredOn') {
      app.setProviderStatus('Scanning for RaceBox hardware...');
      // Defer to next tick
      setImmediate(() => {
        noble.startScanning([], false);
        
        // Set initial scan timeout
        if (scanTimeoutId) clearTimeout(scanTimeoutId);
        scanTimeoutId = setTimeout(() => {
          if (debug) app.debug('[RaceBox] Initial scan timeout');
          noble.stopScanning();
          scanTimeoutId = null;
          setTimeout(() => {
            if (!connectedPeripheral && !isConnecting) {
              setImmediate(() => noble.startScanning([], false));
            }
          }, 2000);
        }, SCAN_TIMEOUT);
      });
    } else {
      if (debug) app.debug('[RaceBox] Bluetooth not yet powered on, state:', noble.state);
    }
  };

  plugin.stop = function () {
    app.setProviderStatus('Stopped');
    
    if (scanTimeoutId) clearTimeout(scanTimeoutId);
    if (connectTimeoutId) clearTimeout(connectTimeoutId);
    
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

    // Set connection timeout
    if (connectTimeoutId) clearTimeout(connectTimeoutId);
    connectTimeoutId = setTimeout(() => {
      app.setProviderStatus('Connection timeout. Retrying...');
      if (activeOptions.debugLogging) app.debug('[RaceBox] Connection timeout');
      cleanupAndRestartScan();
    }, CONNECT_TIMEOUT);

    peripheral.connect((err) => {
      if (connectTimeoutId) clearTimeout(connectTimeoutId);
      connectTimeoutId = null;

      if (err) {
        app.setProviderStatus(`Link failed: ${err.message}. Retrying...`);
        if (activeOptions.debugLogging) app.debug('[RaceBox] Connection error:', err.message);
        cleanupAndRestartScan();
        return;
      }

      app.setProviderStatus('Connected. Syncing targeted GATT profile...');
      if (activeOptions.debugLogging) app.debug('[RaceBox] Connected to RaceBox device');

      // Set timeout for service discovery
      let servicesTimeoutId = setTimeout(() => {
        app.setProviderStatus('Service discovery timeout. Retrying...');
        if (activeOptions.debugLogging) app.debug('[RaceBox] Service discovery timeout');
        cleanupAndRestartScan();
      }, DISCOVER_SERVICES_TIMEOUT);

      // Explicitly find ONLY the exact RaceBox Service UUID
      peripheral.discoverServices([SERVICE_UUID], (sErr, services) => {
        if (servicesTimeoutId) clearTimeout(servicesTimeoutId);

        if (sErr || !services || services.length === 0) {
          app.setProviderStatus('Error: Targeted RaceBox service structure not exposed.');
          if (activeOptions.debugLogging) app.debug('[RaceBox] Service discovery error:', sErr);
          cleanupAndRestartScan();
          return;
        }

        // Now discover characteristics on the SERVICE, not the peripheral
        const service = services[0];
        
        // Set timeout for characteristic discovery
        let charsTimeoutId = setTimeout(() => {
          app.setProviderStatus('Characteristic discovery timeout. Retrying...');
          if (activeOptions.debugLogging) app.debug('[RaceBox] Characteristic discovery timeout');
          cleanupAndRestartScan();
        }, DISCOVER_CHARACTERISTICS_TIMEOUT);

        service.discoverCharacteristics([TX_UUID, RX_UUID], (cErr, characteristics) => {
          if (charsTimeoutId) clearTimeout(charsTimeoutId);
          isConnecting = false; 

          if (cErr || !characteristics) {
            app.setProviderStatus('Error: Could not discover RaceBox characteristics.');
            if (activeOptions.debugLogging) app.debug('[RaceBox] Characteristic discovery error:', cErr);
            cleanupAndRestartScan();
            return;
          }

          const txChar = characteristics.find(c => c.uuid === TX_UUID);
          const rxChar = characteristics.find(c => c.uuid === RX_UUID);

          if (!txChar) {
            app.setProviderStatus('Error: TX characteristic (data stream) not found.');
            if (activeOptions.debugLogging) app.debug('[RaceBox] TX characteristic not found');
            cleanupAndRestartScan();
            return;
          }

          if (!rxChar) {
            if (activeOptions.debugLogging) app.debug('[RaceBox] Warning: RX characteristic not found.');
          }

          // Subscribe to TX (device → host data stream)
          app.setProviderStatus('Subscribing to 25Hz telemetry stream...');
          
          // Set timeout for subscription
          let subTimeoutId = setTimeout(() => {
            app.setProviderStatus('Subscription timeout. Retrying...');
            if (activeOptions.debugLogging) app.debug('[RaceBox] Subscription timeout');
            cleanupAndRestartScan();
          }, SUBSCRIBE_TIMEOUT);

          txChar.subscribe((subErr) => {
            if (subTimeoutId) clearTimeout(subTimeoutId);

            if (subErr) {
              app.setProviderStatus(`Subscription denied: ${subErr.message}`);
              if (activeOptions.debugLogging) app.debug('[RaceBox] Subscribe error:', subErr.message);
              cleanupAndRestartScan();
            } else {
              app.setProviderStatus('Streaming live data successfully into Signal K.');
              if (activeOptions.debugLogging) app.debug('[RaceBox] Successfully subscribed to TX characteristic');
              dataPacketCount = 0;
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
      if (activeOptions.debugLogging) app.debug('[RaceBox] Device disconnected unexpectedly');
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
      // Defer restart to next tick
      setImmediate(() => {
        noble.startScanning([], false);
        
        // Set scan timeout
        if (scanTimeoutId) clearTimeout(scanTimeoutId);
        scanTimeoutId = setTimeout(() => {
          if (activeOptions.debugLogging) app.debug('[RaceBox] Recovery scan timeout');
          noble.stopScanning();
          scanTimeoutId = null;
          setTimeout(() => {
            if (!connectedPeripheral && !isConnecting) {
              setImmediate(() => noble.startScanning([], false));
            }
          }, 2000);
        }, SCAN_TIMEOUT);
      });
    }
  }

  // --- Stream Buffer Re-assembly Pipeline ---
  function processIncomingBytes(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);

    // Yield to event loop every 100 packets to keep Signal K responsive
    if (dataPacketCount % 100 === 0) {
      setImmediate(() => {});
    }

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

    dataPacketCount++;

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
      activeOptions.offsets = { pitch: calculatedPitch, roll: calculatedRoll };
      
      if (activeOptions.debugLogging) {
        app.debug(`[RaceBox] CAL CAPTURED at packet ${dataPacketCount}: Roll=${calculatedRoll.toFixed(4)} rad, Pitch=${calculatedPitch.toFixed(4)} rad`);
      }
      app.setProviderStatus(`Calibration captured at packet ${dataPacketCount}. Offsets applied.`);
      
      // Do NOT save during data stream - just apply immediately
      // Save will happen asynchronously in a timeout to avoid blocking
      setTimeout(() => {
        app.savePluginOptions(activeOptions, (err) => {
          if (err) {
            app.error('[RaceBox] Failed to persist calibration offsets:', err);
          } else {
            if (activeOptions.debugLogging) app.debug('[RaceBox] Calibration offsets persisted to config.');
          }
        });
      }, 0);
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
    const batteryRaw = payload.readUInt16LE(53);   // Battery voltage (raw, usually mV)
    const batteryVoltage = batteryRaw / 1000;      // Convert to Volts
    
    values.push(
      { 
        path: 'electrical.batteries.racebox.capacity.stateOfCharge', 
        value: batteryPercent / 100 
      },
      {
        path: 'electrical.batteries.racebox.voltage',
        value: batteryVoltage
      }
    );

    // 3. High-Performance GNSS Engine Extraction
    const fixStatus = payload.readUInt8(14); 
    const satellitesConnected = payload.readUInt8(15);
    const positionAccuracyMm = payload.readUInt32LE(36); // Horizontal Accuracy (mm)
    const positionAccuracyM = positionAccuracyMm / 1000;  // Convert to meters

    values.push(
      { path: 'navigation.gnss.satellites', value: satellitesConnected },
      { path: 'navigation.gnss.horizontalDilution', value: positionAccuracyM },
      { path: 'navigation.gnss.positionError', value: positionAccuracyM } // GPS error in meters
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

    // Deliver unified delta packet to Signal K Data Broker
    // Using handleMessage with correct Signal K delta format
    app.handleMessage(plugin.id, {
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values: values
        }
      ]
    });

    if (activeOptions.debugLogging && (dataPacketCount % 25 === 0)) {
      app.debug(`[RaceBox] Received ${dataPacketCount} data packets, last roll=${finalRoll.toFixed(4)}`);
    }
  }

  return plugin;
};
