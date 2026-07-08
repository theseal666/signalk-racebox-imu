const { createBluetooth } = require('node-ble');
const { exec } = require('child_process');

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'racebox-signalk-plugin';
  plugin.name = 'RaceBox BLE Telemetry';
  plugin.description = 'Streams 25Hz GNSS and 6-Axis IMU data from RaceBox Mini/Micro directly into Signal K';

  // Nordic UART Service mappings (RaceBox uses this standard)
  // node-ble/BlueZ uses dashed lowercase UUID format
  const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Device → Host (notify)

  // Timing configuration (ms)
  const ADAPTER_TIMEOUT = 10000;      // waiting for the BlueZ adapter
  const SCAN_POLL_INTERVAL = 2000;    // how often to check discovered devices
  const CONNECT_TIMEOUT = 15000;      // GATT connection establishment
  const GATT_TIMEOUT = 10000;         // service/characteristic discovery
  const RETRY_DELAY = 5000;           // pause between failed sessions
  const WATCHDOG_INTERVAL = 5000;     // connection/data health check period
  const DATA_STALE_TIMEOUT = 15000;   // no data for this long => reconnect

  let rxBuffer = Buffer.alloc(0);
  let calibrationRequested = false;
  let activeOptions = {};
  let dataPacketCount = 0;
  let debug = false;

  // Session lifecycle: the main loop runs one session at a time; the
  // generation counter invalidates callbacks from finished sessions
  let running = false;
  let sessionGeneration = 0;
  let btContext = null;      // { bluetooth, destroy } from createBluetooth()
  let currentDevice = null;
  let currentTxChar = null;
  let lastDataTime = 0;
  let isMicro = false;       // RaceBox Micro reports input voltage instead of battery %

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
        title: 'RESET BLUETOOTH - Check this box and click Save to restart the system Bluetooth service and clear connection lockups.',
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

    // Remove leftover keys from older plugin versions so the saved config
    // matches the current schema
    const staleKeys = ['enableIMU', 'triggerCalibration', 'triggerBleReset', 'calibrationOffsets'];
    const foundStale = staleKeys.filter((k) => k in activeOptions);
    if (foundStale.length > 0) {
      foundStale.forEach((k) => delete activeOptions[k]);
      if (debug) app.debug('[RaceBox] Removed stale config keys:', foundStale.join(', '));
      app.savePluginOptions(activeOptions, (err) => {
        if (err) app.error('[RaceBox] Failed to clean stale config keys:', err);
      });
    }

    // Action 1: Restart the system Bluetooth service (BlueZ)
    if (activeOptions.rebootBluetoothStack) {
      app.setProviderStatus('RESET: Restarting Bluetooth service...');
      if (debug) app.debug('[RaceBox] Bluetooth reset requested');

      activeOptions.rebootBluetoothStack = false;
      app.savePluginOptions(activeOptions, (err) => {
        if (err) app.error('[RaceBox] Failed to clear reset flag:', err);
      });

      exec('sudo systemctl restart bluetooth', (error) => {
        if (error) {
          app.error('[RaceBox] Bluetooth reset error:', error.message);
          app.setProviderStatus('RESET FAILED: ' + error.message);
        } else {
          if (debug) app.debug('[RaceBox] Bluetooth service restarted');
        }
        // Continue with normal startup either way, after a settle delay
        setTimeout(() => {
          running = true;
          mainLoop().catch((e) => app.error('[RaceBox] Main loop crashed:', e.message));
        }, 2000);
      });
      return;
    }

    // Action 2: Arm Calibration Flag
    if (activeOptions.zeroImuNow) {
      calibrationRequested = true;
      app.setProviderStatus('CAL: Armed for calibration. Boat must be level and floating naturally.');
      if (debug) app.debug('[RaceBox] Calibration mode armed');

      activeOptions.zeroImuNow = false;
      dataPacketCount = 0;

      app.savePluginOptions(activeOptions, (err) => {
        if (err) app.error('[RaceBox] Failed to clear calibration flag:', err);
      });
    }

    running = true;
    mainLoop().catch((e) => app.error('[RaceBox] Main loop crashed:', e.message));
  };

  plugin.stop = function () {
    app.setProviderStatus('Stopped');
    if (debug) app.debug('[RaceBox] ========== PLUGIN STOP ==========');
    running = false;
    sessionGeneration++; // invalidate in-flight session callbacks
    cleanupSession('plugin stop'); // fire-and-forget async teardown
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // --- Main reconnect loop: one BLE session at a time, retry on failure ---
  async function mainLoop() {
    while (running) {
      const gen = ++sessionGeneration;
      try {
        await runSession(gen);
      } catch (err) {
        if (!running) break;
        app.setProviderStatus(`${err.message}. Retrying in ${RETRY_DELAY / 1000}s...`);
        if (debug) app.debug('[RaceBox] Session ended:', err.message);
      }
      await cleanupSession('session end');
      if (!running) break;
      await sleep(RETRY_DELAY);
    }
  }

  async function runSession(gen) {
    app.setProviderStatus('Initializing Bluetooth (BlueZ/D-Bus)...');
    btContext = createBluetooth();
    const adapter = await withTimeout(btContext.bluetooth.defaultAdapter(), ADAPTER_TIMEOUT, 'Bluetooth adapter init');

    if (!(await adapter.isPowered().catch(() => false))) {
      throw new Error('Bluetooth adapter is powered off (try: bluetoothctl power on)');
    }

    // Scan and poll BlueZ's device list for a RaceBox by name
    app.setProviderStatus('Scanning for RaceBox hardware...');
    try {
      if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
    } catch (e) {
      if (debug) app.debug('[RaceBox] startDiscovery:', e.message);
    }

    let device = null;
    let deviceName = null;
    while (running && gen === sessionGeneration && !device) {
      const macs = await adapter.devices();
      for (const mac of macs) {
        try {
          const candidate = await adapter.getDevice(mac);
          const name = await withTimeout(candidate.getName(), 3000, 'getName').catch(() => null);
          if (debug && name) app.debug('[RaceBox] Discovered device:', name);
          if (name && name.startsWith('RaceBox')) {
            device = candidate;
            deviceName = name;
            break;
          }
        } catch (e) {
          // device disappeared from BlueZ cache - ignore
        }
      }
      if (!device) await sleep(SCAN_POLL_INTERVAL);
    }
    if (!device) return; // stopped while scanning

    currentDevice = device;
    // RaceBox Micro has no battery - byte 67 of the data message carries
    // input voltage x10 instead of a charge level (protocol rev 8)
    isMicro = deviceName.startsWith('RaceBox Micro');
    app.setProviderStatus(`Found ${deviceName}! Connecting...`);
    if (debug) app.debug(`[RaceBox] Connecting to: ${deviceName}${isMicro ? ' (Micro - input voltage mode)' : ''}`);

    try {
      await adapter.stopDiscovery();
    } catch (e) {
      if (debug) app.debug('[RaceBox] stopDiscovery:', e.message);
    }

    await withTimeout(device.connect(), CONNECT_TIMEOUT, 'Connection');

    app.setProviderStatus('Connected. Discovering GATT services...');
    const gatt = await withTimeout(device.gatt(), GATT_TIMEOUT, 'GATT discovery');
    const service = await withTimeout(gatt.getPrimaryService(SERVICE_UUID), GATT_TIMEOUT, 'UART service lookup');
    const txChar = await withTimeout(service.getCharacteristic(TX_UUID), GATT_TIMEOUT, 'TX characteristic lookup');
    currentTxChar = txChar;

    rxBuffer = Buffer.alloc(0);
    dataPacketCount = 0;
    lastDataTime = Date.now();

    txChar.on('valuechanged', (buf) => {
      if (gen !== sessionGeneration) return; // stale session
      lastDataTime = Date.now();
      if (debug && dataPacketCount === 0) app.debug('[RaceBox] First notification received, length:', buf.length);
      processIncomingBytes(buf);
    });

    app.setProviderStatus('Subscribing to 25Hz telemetry stream...');
    await withTimeout(txChar.startNotifications(), GATT_TIMEOUT, 'Subscription');

    app.setProviderStatus('Streaming live data successfully into Signal K.');
    if (debug) app.debug('[RaceBox] Subscribed to TX characteristic - streaming');

    // Watchdog: hold the session open until stop, disconnect, or stale data
    while (running && gen === sessionGeneration) {
      await sleep(WATCHDOG_INTERVAL);
      if (!running || gen !== sessionGeneration) break;

      const connected = await device.isConnected().catch(() => false);
      if (!connected) throw new Error('Device link severed');

      if (Date.now() - lastDataTime > DATA_STALE_TIMEOUT) {
        throw new Error('Data stream stalled');
      }
    }
  }

  async function cleanupSession(reason) {
    if (debug) app.debug('[RaceBox] cleanupSession:', reason);

    const txChar = currentTxChar;
    const device = currentDevice;
    const ctx = btContext;
    currentTxChar = null;
    currentDevice = null;
    btContext = null;
    rxBuffer = Buffer.alloc(0);

    if (txChar) {
      try { txChar.removeAllListeners('valuechanged'); } catch (e) {}
      await withTimeout(txChar.stopNotifications(), 3000, 'stopNotifications').catch(() => {});
    }
    if (device) {
      await withTimeout(device.disconnect(), 5000, 'disconnect').catch(() => {});
    }
    if (ctx) {
      try { ctx.destroy(); } catch (e) {}
    }
  }

  // --- Stream Buffer Re-assembly Pipeline ---
  function processIncomingBytes(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);

    if (debug && dataPacketCount === 0) {
      app.debug('[RaceBox] First chunk received, length:', chunk.length, 'buffer total:', rxBuffer.length);
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
      { path: 'navigation.gyro.y', value: gyroY },
      { path: 'navigation.gyro.z', value: gyroZ }
    );

    // 2. Read System State Metrics
    // Byte 67 is model-dependent (protocol rev 8):
    // - Micro: input voltage x10 (e.g. 0x79 = 121 = 12.1V) - it has no battery
    // - Mini/MiniS: bit 7 = charging flag, bits 0-6 = battery level in percent
    const batteryByte = payload.readUInt8(67);

    if (isMicro) {
      values.push({
        path: 'electrical.batteries.racebox.voltage',
        value: batteryByte / 10
      });
    } else {
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
    }

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

    if (debug && (dataPacketCount % 250 === 0)) {
      app.debug(`[RaceBox] Received ${dataPacketCount} data packets, last roll=${finalRoll.toFixed(4)}`);
    }
  }

  return plugin;
};
