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
  let debug = false;
  // Generation counter: bumped on every new connection attempt and every
  // cleanup. BLE callbacks from an abandoned attempt compare their captured
  // value against this and tear themselves down instead of continuing,
  // preventing a stale connect from hijacking the state machine.
  let connectionAttempt = 0;

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
        default: true
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
    debug = activeOptions.debugLogging !== false; // Default to true

    if (debug) {
      app.debug('[RaceBox] ========== PLUGIN START ==========');
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
          if (debug) app.debug('[RaceBox] Starting scan...');
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
              scanTimeoutId = setTimeout(() => {
                scanTimeoutId = null;
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
      if (debug) app.debug('[RaceBox] Discovered device:', localName);
      
      if (localName && localName.startsWith('RaceBox')) {
        isConnecting = true;
        app.setProviderStatus(`Found ${localName}! Opening connection channel...`);
        if (debug) app.debug(`[RaceBox] Connecting to RaceBox device: ${localName}`);
        
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
      if (debug) app.debug('[RaceBox] Bluetooth already powered on, starting initial scan');
      // Defer to next tick
      setImmediate(() => {
        noble.startScanning([], false);
        
        // Set initial scan timeout
        if (scanTimeoutId) clearTimeout(scanTimeoutId);
        scanTimeoutId = setTimeout(() => {
          if (debug) app.debug('[RaceBox] Initial scan timeout');
          noble.stopScanning();
          scanTimeoutId = null;
          scanTimeoutId = setTimeout(() => {
            scanTimeoutId = null;
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
    if (debug) app.debug('[RaceBox] ========== PLUGIN STOP ==========');
    
    connectionAttempt++; // invalidate any in-flight BLE callbacks
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
    const attempt = ++connectionAttempt;
    const isStale = () => attempt !== connectionAttempt;
    // A stale callback means this attempt was abandoned (timeout/cleanup).
    // The BLE link may still have come up afterwards - force it down so the
    // device resumes advertising and can be found by the active scan.
    const abortStale = (where) => {
      if (debug) app.debug(`[RaceBox] Ignoring stale ${where} callback (attempt ${attempt}) - forcing disconnect`);
      try { peripheral.disconnect(); } catch (e) {}
    };

    connectedPeripheral = peripheral;
    if (debug) app.debug('[RaceBox] connectToDevice() called, attempt', attempt);

    // Set connection timeout
    if (connectTimeoutId) clearTimeout(connectTimeoutId);
    connectTimeoutId = setTimeout(() => {
      if (isStale()) return;
      app.setProviderStatus('Connection timeout. Retrying...');
      if (debug) app.debug('[RaceBox] Connection timeout');
      cleanupAndRestartScan();
    }, CONNECT_TIMEOUT);

    peripheral.connect((err) => {
      if (isStale()) return abortStale('connect');

      if (connectTimeoutId) clearTimeout(connectTimeoutId);
      connectTimeoutId = null;

      if (err) {
        app.setProviderStatus(`Link failed: ${err.message}. Retrying...`);
        if (debug) app.debug('[RaceBox] Connection error:', err.message);
        cleanupAndRestartScan();
        return;
      }

      app.setProviderStatus('Connected. Syncing targeted GATT profile...');
      if (debug) app.debug('[RaceBox] Connected to RaceBox device, discovering services...');

      // Set timeout for service discovery
      let servicesTimeoutId = setTimeout(() => {
        if (isStale()) return;
        app.setProviderStatus('Service discovery timeout. Retrying...');
        if (debug) app.debug('[RaceBox] Service discovery timeout');
        cleanupAndRestartScan();
      }, DISCOVER_SERVICES_TIMEOUT);

      // Explicitly find ONLY the exact RaceBox Service UUID
      peripheral.discoverServices([SERVICE_UUID], (sErr, services) => {
        if (servicesTimeoutId) clearTimeout(servicesTimeoutId);
        if (isStale()) return abortStale('discoverServices');

        if (debug) app.debug('[RaceBox] discoverServices callback, sErr:', sErr, 'services:', services ? services.length : 'null');

        if (sErr || !services || services.length === 0) {
          app.setProviderStatus('Error: Targeted RaceBox service structure not exposed.');
          if (debug) app.debug('[RaceBox] Service discovery error:', sErr);
          cleanupAndRestartScan();
          return;
        }

        // Now discover characteristics on the SERVICE, not the peripheral
        const service = services[0];
        if (debug) app.debug('[RaceBox] Found service, discovering characteristics...');
        
        // Set timeout for characteristic discovery
        let charsTimeoutId = setTimeout(() => {
          if (isStale()) return;
          app.setProviderStatus('Characteristic discovery timeout. Retrying...');
          if (debug) app.debug('[RaceBox] Characteristic discovery timeout');
          cleanupAndRestartScan();
        }, DISCOVER_CHARACTERISTICS_TIMEOUT);

        service.discoverCharacteristics([TX_UUID, RX_UUID], (cErr, characteristics) => {
          if (charsTimeoutId) clearTimeout(charsTimeoutId);
          if (isStale()) return abortStale('discoverCharacteristics');
          isConnecting = false;

          if (debug) app.debug('[RaceBox] discoverCharacteristics callback, cErr:', cErr, 'characteristics:', characteristics ? characteristics.length : 'null');

          if (cErr || !characteristics) {
            app.setProviderStatus('Error: Could not discover RaceBox characteristics.');
            if (debug) app.debug('[RaceBox] Characteristic discovery error:', cErr);
            cleanupAndRestartScan();
            return;
          }

          const txChar = characteristics.find(c => c.uuid === TX_UUID);
          const rxChar = characteristics.find(c => c.uuid === RX_UUID);

          if (debug) app.debug('[RaceBox] TX characteristic found:', !!txChar, 'RX characteristic found:', !!rxChar);

          if (!txChar) {
            app.setProviderStatus('Error: TX characteristic (data stream) not found.');
            if (debug) app.debug('[RaceBox] TX characteristic not found');
            cleanupAndRestartScan();
            return;
          }

          if (!rxChar) {
            if (debug) app.debug('[RaceBox] Warning: RX characteristic not found.');
          }

          // Subscribe to TX (device → host data stream)
          app.setProviderStatus('Subscribing to 25Hz telemetry stream...');
          if (debug) app.debug('[RaceBox] Subscribing to TX characteristic...');
          
          // Set timeout for subscription. On some BlueZ stacks the subscribe
          // callback never fires even though notifications flow, so the
          // timeout only fails the connection if no data has arrived either -
          // the first received data packet also counts as success.
          let subTimeoutId = setTimeout(() => {
            if (isStale()) return;
            subTimeoutId = null;
            app.setProviderStatus('Subscription timeout. Retrying...');
            if (debug) app.debug('[RaceBox] Subscription timeout - no callback and no data received');
            cleanupAndRestartScan();
          }, SUBSCRIBE_TIMEOUT);

          const clearSubTimeout = () => {
            if (subTimeoutId) {
              clearTimeout(subTimeoutId);
              subTimeoutId = null;
            }
          };

          // Make sure nothing restarted the scanner while we were connecting -
          // scanning during an active connection destabilizes BlueZ
          const markStreaming = () => {
            clearSubTimeout();
            if (scanTimeoutId) {
              clearTimeout(scanTimeoutId);
              scanTimeoutId = null;
            }
            noble.stopScanning();
            app.setProviderStatus('Streaming live data successfully into Signal K.');
          };

          txChar.subscribe((subErr) => {
            if (isStale()) return abortStale('subscribe');
            if (debug) app.debug('[RaceBox] subscribe callback, subErr:', subErr);

            if (subErr) {
              clearSubTimeout();
              app.setProviderStatus(`Subscription denied: ${subErr.message}`);
              if (debug) app.debug('[RaceBox] Subscribe error:', subErr.message);
              cleanupAndRestartScan();
            } else {
              markStreaming();
              if (debug) app.debug('[RaceBox] Successfully subscribed to TX characteristic - waiting for data...');
            }
          });

          txChar.on('data', (rawBytes) => {
            if (isStale()) return;
            if (subTimeoutId) {
              // Data is flowing even though the subscribe callback hasn't
              // fired - treat the subscription as successful
              markStreaming();
              if (debug) app.debug('[RaceBox] Data flowing without subscribe callback - treating as subscribed');
            }
            if (debug && dataPacketCount === 0) app.debug('[RaceBox] First data packet received, length:', rawBytes.length);
            processIncomingBytes(rawBytes);
          });
        });
      });
    });

    // Use removeAllListeners + once so repeated connect cycles on the same
    // peripheral object don't accumulate duplicate disconnect handlers
    peripheral.removeAllListeners('disconnect');
    peripheral.once('disconnect', () => {
      if (isStale()) return; // newer attempt already handling recovery
      app.setProviderStatus('Device link severed. Searching for hardware...');
      if (debug) app.debug('[RaceBox] Device disconnected unexpectedly');
      cleanupAndRestartScan();
    });
  }

  function cleanupAndRestartScan() {
    // Invalidate all in-flight callbacks/timeouts from the current attempt
    connectionAttempt++;
    if (debug) app.debug('[RaceBox] cleanupAndRestartScan() called');
    
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
          if (debug) app.debug('[RaceBox] Recovery scan timeout');
          noble.stopScanning();
          scanTimeoutId = null;
          scanTimeoutId = setTimeout(() => {
            scanTimeoutId = null;
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

    if (debug && dataPacketCount === 0) {
      app.debug('[RaceBox] First chunk received, length:', chunk.length, 'buffer total:', rxBuffer.length);
    }

    // Yield to event loop every 100 packets to keep Signal K responsive
    if (dataPacketCount % 100 === 0) {
      setImmediate(() => {});
    }

    while (rxBuffer.length >= 6) {
      if (rxBuffer[0] !== 0xB5 || rxBuffer[1] !== 0x62) {
        if (debug && dataPacketCount === 0) app.debug('[RaceBox] Invalid packet header, searching for sync...');
        rxBuffer = rxBuffer.slice(1);
        continue;
      }

      const msgClass = rxBuffer.readUInt8(2);
      const msgId = rxBuffer.readUInt8(3);
      const payloadLength = rxBuffer.readUInt16LE(4);
      const totalPacketLength = 6 + payloadLength + 2;

      if (debug && dataPacketCount === 0) {
        app.debug('[RaceBox] Found packet header, msgClass:', msgClass.toString(16), 'msgId:', msgId.toString(16), 'payloadLength:', payloadLength, 'totalLength:', totalPacketLength);
      }

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

      if (debug && dataPacketCount === 0) {
        app.debug('[RaceBox] Checksum - calculated:', ckA.toString(16), ckB.toString(16), 'expected:', packet[totalPacketLength - 2].toString(16), packet[totalPacketLength - 1].toString(16));
      }

      if (ckA === packet[totalPacketLength - 2] && ckB === packet[totalPacketLength - 1]) {
        if (debug && dataPacketCount === 0) {
          app.debug('[RaceBox] Checksum VALID');
        }

        if (msgClass === 0xFF && msgId === 0x01) {
          if (debug && dataPacketCount === 0) app.debug('[RaceBox] Valid RaceBox packet! Parsing data...');
          parseRaceBoxData(payload);
        } else {
          if (debug && dataPacketCount === 0) {
            app.debug('[RaceBox] Packet is not RaceBox telemetry (msgClass:', msgClass.toString(16), 'msgId:', msgId.toString(16), ')');
          }
        }
      } else {
        if (debug && dataPacketCount === 0) {
          app.debug('[RaceBox] Checksum FAILED');
        }
      }

      rxBuffer = rxBuffer.slice(totalPacketLength);
    }
  }

  // --- Core Binary Packet Parser ---
  function parseRaceBoxData(payload) {
    if (payload.length < 80) {
      if (debug) app.debug('[RaceBox] Payload too short:', payload.length);
      return;
    }

    dataPacketCount++;

    const values = [];

    // 1. Raw 6-Axis IMU Sensor Channels
    // GForce X/Y/Z: Int16 at offsets 68/70/72, in milli-g (divide by 1000 for g)
    const accelX = payload.readInt16LE(68) / 1000;
    const accelY = payload.readInt16LE(70) / 1000;
    const accelZ = payload.readInt16LE(72) / 1000;

    // Rotation rate X/Y/Z: Int16 at offsets 74/76/78, in centi-deg/s (X=roll, Y=pitch, Z=yaw)
    const gyroX = (payload.readInt16LE(74) / 100) * (Math.PI / 180);
    const gyroY = (payload.readInt16LE(76) / 100) * (Math.PI / 180);
    const gyroZ = (payload.readInt16LE(78) / 100) * (Math.PI / 180);

    if (debug && dataPacketCount === 1) {
      app.debug('[RaceBox] Packet 1: accelX=', accelX, 'accelY=', accelY, 'accelZ=', accelZ);
    }

    // Calculate immediate derived Pitch/Roll orientation angles
    const calculatedRoll = Math.atan2(accelY, accelZ);
    const calculatedPitch = Math.atan2(-accelX, Math.sqrt(accelY * accelY + accelZ * accelZ));

    // Live execution of boat level calibration request
    if (calibrationRequested) {
      calibrationRequested = false;
      activeOptions.offsets = { pitch: calculatedPitch, roll: calculatedRoll };
      
      if (debug) {
        app.debug(`[RaceBox] CAL CAPTURED at packet ${dataPacketCount}: Roll=${calculatedRoll.toFixed(4)} rad, Pitch=${calculatedPitch.toFixed(4)} rad`);
      }
      app.setProviderStatus(`Calibration captured at packet ${dataPacketCount}. Offsets applied.`);
      
      setTimeout(() => {
        app.savePluginOptions(activeOptions, (err) => {
          if (err) {
            app.error('[RaceBox] Failed to persist calibration offsets:', err);
          } else {
            if (debug) app.debug('[RaceBox] Calibration offsets persisted to config.');
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
      { path: 'navigation.rateOfTurn', value: gyroZ },
      { path: 'navigation.accel.x', value: accelX },
      { path: 'navigation.accel.y', value: accelY },
      { path: 'navigation.accel.z', value: accelZ },
      { path: 'navigation.gyro.x', value: gyroX },
      { path: 'navigation.gyro.y', value: gyroY }
    );

    // 2. Read System State Metrics
    // Byte 67: for Mini/MiniS, bit 7 = charging flag, bits 0-6 = battery level in percent.
    // (For RaceBox Micro this byte is input voltage x10 instead - no battery.)
    const batteryByte = payload.readUInt8(67);
    const isCharging = (batteryByte & 0x80) !== 0;
    const batteryPercent = batteryByte & 0x7F;

    values.push(
      { 
        path: 'electrical.batteries.racebox.capacity.stateOfCharge', 
        value: batteryPercent / 100 
      },
      {
        path: 'electrical.batteries.racebox.chargingMode',
        value: isCharging ? 'charging' : 'not charging'
      }
    );

    // 3. High-Performance GNSS Engine Extraction
    const fixStatus = payload.readUInt8(20);       // 0 = no fix, 2 = 2D, 3 = 3D
    const fixStatusFlags = payload.readUInt8(21);  // bit 0 = valid fix
    const satellitesConnected = payload.readUInt8(23);
    const horizontalAccuracyM = payload.readUInt32LE(40) / 1000; // mm -> m
    const pdop = payload.readUInt16LE(64) / 100;

    values.push(
      { path: 'navigation.gnss.satellites', value: satellitesConnected },
      { path: 'navigation.gnss.horizontalDilution', value: pdop },
      { path: 'navigation.gnss.positionError', value: horizontalAccuracyM }
    );

    // Only broadcast tracking and position vectors if a live, valid 2D/3D fix exists
    if (fixStatus >= 2 && (fixStatusFlags & 0x01)) { 
      const lon = payload.readInt32LE(24) / 10000000;
      const lat = payload.readInt32LE(28) / 10000000;

      const speedMms = payload.readInt32LE(48); // mm/s
      const speedMs = speedMms / 1000;          
      
      const headingDegreesScaled = payload.readInt32LE(52); // degrees x 100000
      const headingRad = (headingDegreesScaled / 100000) * (Math.PI / 180); 

      values.push(
        { path: 'navigation.position', value: { latitude: lat, longitude: lon } },
        { path: 'navigation.speedOverGround', value: speedMs },
        { path: 'navigation.courseOverGroundTrue', value: headingRad },
        { path: 'navigation.gnss.type', value: 'GPS+GLONASS+GALILEO' }
      );
    }

    // Deliver unified delta packet to Signal K Data Broker
    if (debug && dataPacketCount === 1) {
      app.debug('[RaceBox] Sending first delta to Signal K with', values.length, 'values');
      app.debug('[RaceBox] Delta:', JSON.stringify({
        updates: [
          {
            source: { label: plugin.id },
            timestamp: new Date().toISOString(),
            values: values.slice(0, 3)
          }
        ]
      }));
    }

    app.handleMessage(plugin.id, {
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values: values
        }
      ]
    });

    if (debug && (dataPacketCount % 25 === 0)) {
      app.debug(`[RaceBox] Received ${dataPacketCount} data packets, last roll=${finalRoll.toFixed(4)}`);
    }
  }

  return plugin;
};
