const { createBluetooth } = require('node-ble');
const { exec } = require('child_process');

/**
 * Signal K Plugin: RaceBox BLE Telemetry
 */

const pluginMetadata = {
  id: 'signalk-racebox-imu',
  name: 'RaceBox BLE Telemetry',
  description: 'Streams 25Hz GNSS and 6-Axis IMU data from RaceBox Mini/Micro directly into Signal K',
  schema: {
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
      enableWaveDetection: {
        type: 'boolean',
        title: 'EXPERIMENTAL: Enable Wave Height & Period detection',
        default: false
      },
      slamThreshold: {
        type: 'number',
        title: 'Hull Slam Threshold (G above baseline)',
        default: 0.5
      },
      waveFilterPeriod: {
        type: 'number',
        title: 'Wave Filter: Dominant Period (seconds)',
        description: 'Starting estimate of the dominant wave period used by the Ornstein-Uhlenbeck Kalman filter. Use 3–6 s for Baltic or coastal chop; 7–12 s for open-ocean swell. This is only a starting value: the filter now measures the dominant period from the heave zero-crossings and follows it. That matters because the inferred wave height scales with the SQUARE of the ratio between this setting and the real period — at 8 s against 2 s chop it over-reads by sixteen times.',
        default: 8.0
      },
      waveFilterDamping: {
        type: 'number',
        title: 'Wave Filter: Damping Ratio (ζ, 0.05–0.50)',
        description: 'Controls how quickly oscillations decay in the wave model. Lower values (0.05–0.10) suit long ocean swell that rings for many cycles. Higher values (0.25–0.40) suit short, steep chop that damps quickly. Leave at 0.15 for most conditions.',
        default: 0.15
      },
      waveAttitudeTau: {
        type: 'number',
        title: 'Wave Filter: Attitude Time Constant (seconds)',
        description: 'How slowly the wave pipeline leans on the accelerometer as a gravity reference. The attitude it uses is integrated from the gyro, because an accelerometer-only tilt estimate is degenerate for this purpose — it makes the "vertical" channel equal to the vector magnitude, and the resulting wave height tracks heel instead of sea state. Longer values (20–60 s) reject sailing accelerations better; shorter values recover faster from gyro drift. 20 s suits a keelboat.',
        default: 20
      },
      waveAttitudeGate: {
        type: 'number',
        title: 'Wave Filter: Gravity Trust Gate (g)',
        description: 'The accelerometer is only used to correct attitude while total specific force is within this much of 1 g — that is, while it is plausibly measuring gravity rather than the boat accelerating. 0.15 g is a reasonable default; lower is stricter.',
        default: 0.15
      },
      waveHsWindow: {
        type: 'number',
        title: 'Wave Filter: Hs Window (seconds, 30–300)',
        description: 'Duration of the rolling window used to compute Significant Wave Height (Hs = 4σ, the oceanographic standard). Longer windows (120–300 s) give a stable, slow-moving reading. Shorter windows (30–60 s) respond faster to changing conditions but are noisier. Requires 30 s of data before Hs is published.',
        default: 120
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
  }
};

// 3×3 matrix helpers for the OU Kalman wave-height filter
function mat3Mul(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i=0;i<3;i++) for (let j=0;j<3;j++) for (let k=0;k<3;k++) C[i][j]+=A[i][k]*B[k][j];
  return C;
}
function mat3T(A) {
  return [[A[0][0],A[1][0],A[2][0]],[A[0][1],A[1][1],A[2][1]],[A[0][2],A[1][2],A[2][2]]];
}
function mat3Add(A,B){return A.map((r,i)=>r.map((v,j)=>v+B[i][j]));}
function mat3Sub(A,B){return A.map((r,i)=>r.map((v,j)=>v-B[i][j]));}

module.exports = function (app) {
  const plugin = { ...pluginMetadata };

  // Nordic UART Service mappings
  const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

  // Timing configuration (ms)
  const ADAPTER_TIMEOUT = 10000;
  const SCAN_POLL_INTERVAL = 2000;
  const CONNECT_TIMEOUT = 15000;
  const GATT_TIMEOUT = 10000;
  const RETRY_DELAY = 5000;
  const WATCHDOG_INTERVAL = 5000;
  const DATA_STALE_TIMEOUT = 15000;
  const RESTART_SETTLE_DELAY = 2000;

  // Runtime State
  let rxBuffer = Buffer.alloc(0);
  let calibrationRequested = false;
  // Set the instant a calibration is captured (parseRaceBoxData) so the
  // live UI's "Calibrate Now" button can tell a request was actually
  // fulfilled, rather than just optimistically assuming it worked the
  // moment the button was clicked.
  let lastCalibratedAt = null;
  let activeOptions = {};
  let dataPacketCount = 0;
  let debug = false;
  let running = false;
  let sessionGeneration = 0;
  let btContext = null;
  let currentDevice = null;
  let currentTxChar = null;
  let lastDataTime = 0;
  let isMicro = false;

  // Wave detection pipeline state
  const DT = 0.04;  // 25Hz sample rate

  // OU Kalman state: heave displacement (m), heave velocity (m/s), accel bias (m/s²)
  // Algorithm: Ornstein-Uhlenbeck Kalman filter for ship heave — see README and
  // github.com/bareboat-necessities/ocean-imu for the underlying theory.
  let kfS = 0, kfV = 0, kfB = 0;
  let kfP = [[1,0,0],[0,1,0],[0,0,1]];  // error covariance, reset to identity each start
  let heaveWindow = [];                  // rolling displacement samples for Hs = 4σ
  let heaveUpdateCounter = 0;           // throttles Hs recomputation to once per second
  let zeroXingTimes = [];               // timestamps of upward heave zero-crossings
  let prevHeavePosSign = false;
  // Attitude used ONLY by the wave pipeline. The published navigation.attitude.*
  // stays accel-derived so nothing downstream changes, but the wave pipeline
  // cannot use that estimate: see the note above the tilt compensation below.
  let waveRoll = null, wavePitch = null;
  let waveAttitudeSamples = 0;
  // The wave pipeline advances on sample count, not wall clock. The two had
  // been mixed: the filter stepped at a fixed DT while the period estimate and
  // the auto-zero read Date.now(), so a bursty BLE delivery (every reconnect,
  // and every time the host stalls) silently corrupted both.
  let waveClockMs = 0;
  let adaptivePeriod = 0;               // smoothed dominant period driving omega0
  let lastGyro = { x: 0, y: 0, z: 0 };
  let peakSlam = 0;
  let slamTimer = 0;

  // Persistent wave output
  let currentWaveHeight = 0;
  let currentWavePeriod = 0;
  let lastWaveDetectedTime = 0;   // on waveClockMs, not wall clock
  let waveHeightSuppressed = 0;         // count of physically impossible Hs rejected

  plugin.start = function (options) {
    if (!app) return;

    activeOptions = options || { offsets: { pitch: 0, roll: 0 } };
    debug = activeOptions.debugLogging !== false;

    if (debug) {
      app.debug('[RaceBox] ========== PLUGIN START ==========');
    }

    const staleKeys = ['enableIMU', 'triggerCalibration', 'triggerBleReset', 'calibrationOffsets'];
    const foundStale = staleKeys.filter((k) => k in activeOptions);
    if (foundStale.length > 0) {
      foundStale.forEach((k) => delete activeOptions[k]);
      app.savePluginOptions(activeOptions, (err) => {
        if (err && debug) app.error('[RaceBox] Failed to clean stale config keys:', err);
      });
    }

    if (activeOptions.rebootBluetoothStack) {
      app.setProviderStatus('RESET: Restarting Bluetooth service...');
      activeOptions.rebootBluetoothStack = false;
      app.savePluginOptions(activeOptions, () => {});

      exec('sudo systemctl restart bluetooth', (error) => {
        if (error) {
          app.error('[RaceBox] Bluetooth reset error:', error.message);
          app.setProviderStatus('RESET FAILED: ' + error.message);
        }
        setTimeout(() => {
          running = true;
          mainLoop().catch((e) => app.error('[RaceBox] Main loop crashed:', e.message));
        }, RESTART_SETTLE_DELAY);
      });
      return;
    }

    if (activeOptions.zeroImuNow) {
      calibrationRequested = true;
      app.setProviderStatus('CAL: Armed for calibration. Boat must be level.');
      activeOptions.zeroImuNow = false;
      dataPacketCount = 0;
    }

    setTimeout(() => {
      running = true;
      mainLoop().catch((e) => {
        if (app) app.error('[RaceBox] Main loop crashed:', e.message);
      });
    }, 1000);
  };

  plugin.stop = function () {
    if (app) app.setProviderStatus('Stopped');
    running = false;
    sessionGeneration++;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function mainLoop() {
    while (running) {
      const gen = ++sessionGeneration;
      try {
        await runSession(gen);
      } catch (err) {
        if (!running) break;
        if (app) app.setProviderStatus(`${err.message}. Retrying in ${RETRY_DELAY / 1000}s...`);
      }
      await cleanupSession('session end');
      if (!running) break;
      await sleep(RETRY_DELAY);
    }
  }

  async function runSession(gen) {
    if (!app) return;
    app.setProviderStatus('Initializing Bluetooth...');

    btContext = createBluetooth();
    const adapter = await withTimeout(btContext.bluetooth.defaultAdapter(), ADAPTER_TIMEOUT, 'Bluetooth adapter init');

    if (!(await adapter.isPowered().catch(() => false))) {
      throw new Error('Bluetooth adapter is powered off');
    }

    app.setProviderStatus('Scanning for RaceBox hardware...');

    // Send metadata for experimental paths
    if (activeOptions.enableWaveDetection) {
      app.handleMessage(plugin.id, {
        updates: [{
          meta: [
            { path: 'navigation.accel.trueZ', value: { units: 'm/s2' } },
            { path: 'navigation.imu.heaveDisplacement', value: { units: 'm' } },
            { path: 'environment.wind.waveHeight', value: { units: 'm' } },
            { path: 'environment.wind.wavePeriod', value: { units: 's' } },
            { path: 'performance.hull.slamAcceleration', value: { units: 'm/s2' } },
            { path: 'performance.hull.slamAngularJolt', value: { units: 'rad/s2' } }
          ]
        }]
      });
    }

    try {
      if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
    } catch (e) {}

    let device = null;
    let deviceName = null;
    while (running && gen === sessionGeneration && !device) {
      const macs = await adapter.devices();
      for (const mac of macs) {
        try {
          const candidate = await adapter.getDevice(mac);
          const name = await withTimeout(candidate.getName(), 3000, 'getName').catch(() => null);
          if (name && name.startsWith('RaceBox')) {
            device = candidate;
            deviceName = name;
            break;
          }
        } catch (e) {}
      }
      if (!device) await sleep(SCAN_POLL_INTERVAL);
    }
    if (!device) return;

    currentDevice = device;
    isMicro = deviceName.startsWith('RaceBox Micro');
    app.setProviderStatus(`Found ${deviceName}! Connecting...`);

    try { await adapter.stopDiscovery(); } catch (e) {}
    await withTimeout(device.connect(), CONNECT_TIMEOUT, 'Connection');

    const gatt = await withTimeout(device.gatt(), GATT_TIMEOUT, 'GATT discovery');
    const service = await withTimeout(gatt.getPrimaryService(SERVICE_UUID), GATT_TIMEOUT, 'UART service lookup');
    const txChar = await withTimeout(service.getCharacteristic(TX_UUID), GATT_TIMEOUT, 'TX characteristic lookup');
    currentTxChar = txChar;

    rxBuffer = Buffer.alloc(0);
    dataPacketCount = 0;
    lastDataTime = Date.now();

    txChar.on('valuechanged', (buf) => {
      if (gen !== sessionGeneration) return;
      lastDataTime = Date.now();
      processIncomingBytes(buf);
    });

    app.setProviderStatus('Subscribing to telemetry...');
    await withTimeout(txChar.startNotifications(), GATT_TIMEOUT, 'Subscription');

    if (running && gen === sessionGeneration) {
      app.setProviderStatus('Streaming live data.');
    }

    while (running && gen === sessionGeneration) {
      await sleep(WATCHDOG_INTERVAL);
      const connected = await device.isConnected().catch(() => false);
      if (!connected) throw new Error('Device link severed');
      if (Date.now() - lastDataTime > DATA_STALE_TIMEOUT) throw new Error('Data stream stalled');
    }
  }

  async function cleanupSession(reason) {
    const txChar = currentTxChar;
    const device = currentDevice;
    const ctx = btContext;
    currentTxChar = null;
    currentDevice = null;
    btContext = null;
    rxBuffer = Buffer.alloc(0);

    if (txChar) {
      try { txChar.removeAllListeners('valuechanged'); } catch (e) {}
      await txChar.stopNotifications().catch(() => {});
    }
    if (device) await device.disconnect().catch(() => {});
    if (ctx) try { ctx.destroy(); } catch (e) {}
  }

  function processIncomingBytes(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);
    while (rxBuffer.length >= 6) {
      if (rxBuffer[0] !== 0xB5 || rxBuffer[1] !== 0x62) {
        rxBuffer = rxBuffer.slice(1);
        continue;
      }
      const payloadLength = rxBuffer.readUInt16LE(4);
      const totalPacketLength = 6 + payloadLength + 2;
      if (rxBuffer.length < totalPacketLength) break;

      const packet = rxBuffer.slice(0, totalPacketLength);
      const payload = packet.slice(6, 6 + payloadLength);

      let ckA = 0, ckB = 0;
      for (let i = 2; i < totalPacketLength - 2; i++) {
        ckA = (ckA + packet[i]) & 0xFF;
        ckB = (ckB + ckA) & 0xFF;
      }

      if (ckA === packet[totalPacketLength - 2] && ckB === packet[totalPacketLength - 1]) {
        const msgClass = rxBuffer.readUInt8(2);
        const msgId = rxBuffer.readUInt8(3);
        if (msgClass === 0xFF && msgId === 0x01) {
          parseRaceBoxData(payload);
        }
      }
      rxBuffer = rxBuffer.slice(totalPacketLength);
    }
  }

  function parseRaceBoxData(payload) {
    if (payload.length < 80) return;
    dataPacketCount++;

    const accelX = payload.readInt16LE(68) / 1000;
    const accelY = payload.readInt16LE(70) / 1000;
    const accelZ = payload.readInt16LE(72) / 1000;
    const gyroX = (payload.readInt16LE(74) / 100) * (Math.PI / 180);
    const gyroY = (payload.readInt16LE(76) / 100) * (Math.PI / 180);
    const gyroZ = (payload.readInt16LE(78) / 100) * (Math.PI / 180);

    const calculatedRoll = Math.atan2(accelY, accelZ);
    const calculatedPitch = Math.atan2(-accelX, Math.sqrt(accelY * accelY + accelZ * accelZ));

    if (calibrationRequested) {
      calibrationRequested = false;
      activeOptions.offsets = { pitch: calculatedPitch, roll: calculatedRoll };
      lastCalibratedAt = Date.now();
      if (app) {
        app.setProviderStatus('Calibration captured and applied.');
        app.savePluginOptions(activeOptions, () => {});
      }
    }

    const currentOffsets = activeOptions.offsets || { pitch: 0, roll: 0 };
    const finalRoll = calculatedRoll - currentOffsets.roll;
    const finalPitch = calculatedPitch - currentOffsets.pitch;

    const values = [
      // Signal K's spec defines navigation.attitude as a single object-valued
      // path ({roll, pitch, yaw}), the same way navigation.position is one
      // object ({latitude, longitude}) rather than two separate paths (see
      // the position value further down in this same delta). The dotted
      // navigation.attitude.roll / .pitch paths below are kept for anyone
      // already relying on them, but plugins that subscribe to the exact
      // path "navigation.attitude" (e.g. speedandcurrent's heel input for
      // leeway/current calculation) only ever see an update when a delta
      // uses that exact path — they never receive one from dotted sub-path
      // deltas alone, so without this composite entry their heel/roll input
      // silently never arrives. yaw is omitted rather than faked as 0,
      // since this IMU has no compass/magnetometer to back a heading claim.
      { path: 'navigation.attitude', value: { roll: finalRoll, pitch: finalPitch } },
      { path: 'navigation.attitude.roll', value: finalRoll },
      { path: 'navigation.attitude.pitch', value: finalPitch },
      { path: 'navigation.rateOfTurn', value: gyroZ },
      { path: 'navigation.accel.x', value: accelX },
      { path: 'navigation.accel.y', value: accelY },
      { path: 'navigation.accel.z', value: accelZ },
      { path: 'navigation.gyro.x', value: gyroX },
      { path: 'navigation.gyro.y', value: gyroY },
      { path: 'navigation.gyro.z', value: gyroZ }
    ];

    if (activeOptions.enableWaveDetection) {
      // --- Attitude for the wave pipeline ---
      //
      // Rotating an acceleration vector into the earth frame using angles derived
      // from that same vector is degenerate: substituting
      // roll = atan2(aY, aZ), pitch = atan2(-aX, hypot(aY, aZ)) into
      //   -aX*sinP + aY*sinR*cosP + aZ*cosR*cosP
      // reduces exactly to |a|. Verified against a logged sail: the published
      // "vertical" channel matched the raw vector magnitude to 5e-4 g (r=0.99998).
      // So dynamicZ carried no vertical direction at all — only how far total
      // specific force sat from 1 g — and the resulting Hs tracked heel angle
      // (r = +0.973 against heave sigma) instead of sea state.
      //
      // The fix is an attitude estimate that does not come from this sample:
      // integrate the gyro, and lean on the accelerometer for the long-term
      // reference only while total specific force is near 1 g, i.e. while it is
      // plausibly measuring gravity rather than the boat's own acceleration.
      const accMag = Math.sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ);

      if (waveRoll === null) {
        waveRoll = calculatedRoll;
        wavePitch = calculatedPitch;
      } else {
        // Euler kinematics; pitch is clamped so tan() cannot run away near vertical
        const cp = Math.cos(waveRoll), sp = Math.sin(waveRoll);
        const tanP0 = Math.tan(Math.max(-1.3, Math.min(1.3, wavePitch)));
        waveRoll  += (gyroX + sp * tanP0 * gyroY + cp * tanP0 * gyroZ) * DT;
        wavePitch += (cp * gyroY - sp * gyroZ) * DT;

        // Gravity reference, applied slowly and only when it is trustworthy
        const tauS = Math.max(2, activeOptions.waveAttitudeTau || 20);
        const gate = Math.max(0.02, Math.min(0.5, activeOptions.waveAttitudeGate || 0.15));
        if (Math.abs(accMag - 1.0) < gate) {
          const k = DT / tauS;
          let dR = calculatedRoll - waveRoll;
          while (dR >  Math.PI) dR -= 2 * Math.PI;
          while (dR < -Math.PI) dR += 2 * Math.PI;
          let dP = calculatedPitch - wavePitch;
          while (dP >  Math.PI) dP -= 2 * Math.PI;
          while (dP < -Math.PI) dP += 2 * Math.PI;
          waveRoll  += k * dR;
          wavePitch += k * dP;
        }
      }
      waveAttitudeSamples++;

      const sinP = Math.sin(wavePitch - (currentOffsets.pitch || 0));
      const cosP = Math.cos(wavePitch - (currentOffsets.pitch || 0));
      const sinR = Math.sin(waveRoll - (currentOffsets.roll || 0));
      const cosR = Math.cos(waveRoll - (currentOffsets.roll || 0));

      const trueZ    = -accelX * sinP + accelY * sinR * cosP + accelZ * cosR * cosP;
      const trueZMS2 = trueZ * 9.80665;
      const dynamicZ = (trueZ - 1.0) * 9.80665;  // dynamic vertical accel (m/s²)

      // --- OU Kalman filter for heave displacement ---
      // State x = [s (heave m), v (heave vel m/s), b (accel bias m/s²)]
      // Model: s'' = -ω₀²·s − 2ζω₀·v  (damped harmonic oscillator / OU process)
      // Observation: z = s'' + b + noise  →  H = [-ω₀², -2ζω₀, 1]
      waveClockMs += DT * 1000;

      // omega0 follows the sea, not a setting.
      //
      // The OU observation model says accel = omega0^2 * s, so the heave it
      // infers scales with (configured period / actual period)^2. At the stock
      // 8 s against the 2.1 s chop actually measured on 2026-10-03 that is a
      // factor of fourteen — which is most of why a flat lake reported metres.
      // The zero-crossing estimate below tracks the forcing frequency even when
      // omega0 is wrong (the filter is driven, not free-running), so feeding it
      // back is stable; it is smoothed and clamped regardless.
      const configuredPeriod = Math.max(activeOptions.waveFilterPeriod || 8.0, 2.0);
      const effectivePeriod = adaptivePeriod > 0 ? adaptivePeriod : configuredPeriod;
      const omega0 = 2 * Math.PI / Math.max(effectivePeriod, 1.5);
      const zeta   = Math.min(Math.max(activeOptions.waveFilterDamping  || 0.15, 0.01), 0.50);
      const omSq   = omega0 * omega0;
      const damp2  = 2 * zeta * omega0;

      // Noise constants (fixed): Q_V = wave energy forcing; Q_B = bias drift; R_A = accel noise
      const Q_V = 0.25, Q_B = 1e-6, R_A = 9e-4;

      // Predict step
      const sP  = kfS + DT * kfV;
      const vP  = kfV + DT * (-omSq * kfS - damp2 * kfV);
      const bP  = kfB;
      const Phi = [[1, DT, 0], [-omSq * DT, 1 - damp2 * DT, 0], [0, 0, 1]];
      const Q   = [[0, 0, 0], [0, Q_V, 0], [0, 0, Q_B]];
      const Pp  = mat3Add(mat3Mul(mat3Mul(Phi, kfP), mat3T(Phi)), Q);

      // Update step
      const H   = [-omSq, -damp2, 1];
      const inn = dynamicZ - (H[0]*sP + H[1]*vP + H[2]*bP);
      const HP  = [H[0]*Pp[0][0]+H[1]*Pp[1][0]+H[2]*Pp[2][0],
                   H[0]*Pp[0][1]+H[1]*Pp[1][1]+H[2]*Pp[2][1],
                   H[0]*Pp[0][2]+H[1]*Pp[1][2]+H[2]*Pp[2][2]];
      const Sinv = 1 / (HP[0]*H[0] + HP[1]*H[1] + HP[2]*H[2] + R_A);
      const K   = [(Pp[0][0]*H[0]+Pp[0][1]*H[1]+Pp[0][2]*H[2])*Sinv,
                   (Pp[1][0]*H[0]+Pp[1][1]*H[1]+Pp[1][2]*H[2])*Sinv,
                   (Pp[2][0]*H[0]+Pp[2][1]*H[1]+Pp[2][2]*H[2])*Sinv];
      kfS = sP + K[0]*inn;  kfV = vP + K[1]*inn;  kfB = bP + K[2]*inn;
      kfP = mat3Mul(mat3Sub([[1,0,0],[0,1,0],[0,0,1]],
                             [[K[0]*H[0],K[0]*H[1],K[0]*H[2]],
                              [K[1]*H[0],K[1]*H[1],K[1]*H[2]],
                              [K[2]*H[0],K[2]*H[1],K[2]*H[2]]]), Pp);

      // Significant wave height: Hs = 4σ of heave displacement (oceanographic standard)
      const windowSamples = Math.round((activeOptions.waveHsWindow || 120) * 25);
      heaveWindow.push(kfS);
      if (heaveWindow.length > windowSamples) heaveWindow.shift();
      heaveUpdateCounter = (heaveUpdateCounter + 1) % 25;
      // The complementary filter needs a few time constants before its output
      // means anything; publishing during that settling produced the drift ramp.
      const attitudeSettled = waveAttitudeSamples > 25 * 3 * Math.max(2, activeOptions.waveAttitudeTau || 20);
      if (heaveWindow.length >= 750 && heaveUpdateCounter === 0 && attitudeSettled) {
        const mean = heaveWindow.reduce((a, b) => a + b, 0) / heaveWindow.length;
        const variance = heaveWindow.reduce((a, v) => a + (v - mean) * (v - mean), 0) / heaveWindow.length;
        const hs = 4 * Math.sqrt(variance);
        // Physical sanity: deep-water wavelength L = 1.56*T², and a wave breaks
        // near H/L = 1/7. An Hs steeper than that cannot be sea state, it is
        // filter drift. On the reference sail this rejected every bad sample
        // (median H/L 0.70, five times past breaking) and no good one.
        let plausible = true;
        if (currentWavePeriod > 1.5) {
          const limit = 0.14 * 1.56 * currentWavePeriod * currentWavePeriod;
          if (hs > limit) {
            plausible = false;
            waveHeightSuppressed++;
            if (debug && app && waveHeightSuppressed % 25 === 1) {
              app.debug(`wave: rejected Hs ${hs.toFixed(2)} m at T=${currentWavePeriod.toFixed(1)} s ` +
                        `(steeper than the ${limit.toFixed(2)} m breaking limit) — filter has not settled`);
            }
          }
        }
        if (plausible && hs > 0.05) { currentWaveHeight = hs; lastWaveDetectedTime = waveClockMs; }
      }

      // Wave period from upward zero-crossings of filtered heave
      const isPos = kfS > 0;
      if (!prevHeavePosSign && isPos) {
        zeroXingTimes.push(waveClockMs);
        if (zeroXingTimes.length > 6) zeroXingTimes.shift();
        if (zeroXingTimes.length >= 3) {
          let total = 0;
          for (let i = 1; i < zeroXingTimes.length; i++) total += zeroXingTimes[i] - zeroXingTimes[i-1];
          const T = (total / (zeroXingTimes.length - 1)) / 1000;
          if (T > 1.5 && T < 25) {
            currentWavePeriod = T;
            // Slow EMA, and never let one estimate move omega0 by more than
            // 20% of the way, so a bad crossing cannot destabilise the filter.
            adaptivePeriod = adaptivePeriod > 0 ? adaptivePeriod + 0.2 * (T - adaptivePeriod) : T;
            adaptivePeriod = Math.max(1.5, Math.min(25, adaptivePeriod));
          }
        }
      }
      prevHeavePosSign = isPos;

      // Auto-zero and flush buffers if no wave activity for 60s.
      //
      // lastWaveDetectedTime MUST be rearmed here. Without it the condition stays
      // true forever once it first trips, so heaveWindow is cleared on every
      // sample at 25 Hz and can never reach the 750 it needs to compute Hs at
      // all — a permanent latch. On the reference sail the channel read a hard
      // 0.00 for the first 51 minutes (37% of the day's samples) for this reason,
      // while heave had already drifted past a metre.
      const now = waveClockMs;
      if (now - lastWaveDetectedTime > 60000) {
        currentWaveHeight = 0;
        currentWavePeriod = 0;
        heaveWindow.length = 0;
        zeroXingTimes.length = 0;
        // adaptivePeriod deliberately survives the flush. It is measured from
        // heave zero-crossings, which stay meaningful even while Hs is being
        // rejected as implausible — and clearing it here would reset omega0 to
        // the configured value, re-inflate Hs, get it rejected again, and leave
        // the estimate stuck in that loop forever.
        lastWaveDetectedTime = now;
      }

      // Complex Slam Detection (Multi-vector impact analysis)
      const slamLimit = activeOptions.slamThreshold || 0.5;

      // 1. G-Force Resultant (Impacts from any direction)
      const gResultant = Math.sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ);
      const gImpact = Math.abs(gResultant - 1.0); // Deviation from 1G baseline

      // 2. Angular Jolt (Sudden changes in rotation rates)
      const gyroJolt = Math.sqrt(
        Math.pow(gyroX - lastGyro.x, 2) +
        Math.pow(gyroY - lastGyro.y, 2) +
        Math.pow(gyroZ - lastGyro.z, 2)
      ) / DT;

      // Update last gyro state
      lastGyro = { x: gyroX, y: gyroY, z: gyroZ };

      // Unified Slam Metric (Converted to SI: m/s2)
      const currentSlam = gImpact * 9.80665;

      if (currentSlam > (slamLimit * 9.80665)) {
        if (currentSlam > peakSlam) peakSlam = currentSlam;
        slamTimer = 25; // Hold peak for 1 second @ 25Hz
      }

      if (slamTimer > 0) {
        slamTimer--;
        if (slamTimer === 0) peakSlam = 0;
      }

      // Persistent reporting: Always include these in the 25Hz delta
      values.push(
        { path: 'navigation.accel.trueZ',          value: trueZMS2 },
        { path: 'navigation.imu.heaveDisplacement', value: kfS },
        { path: 'environment.wind.waveHeight',      value: currentWaveHeight },
        { path: 'environment.wind.wavePeriod',      value: currentWavePeriod },
        { path: 'performance.hull.slamAcceleration', value: peakSlam },
        { path: 'performance.hull.slamAngularJolt',  value: gyroJolt }
      );
    }

    const batteryByte = payload.readUInt8(67);
    if (isMicro) {
      values.push({ path: 'electrical.batteries.racebox.voltage', value: batteryByte / 10 });
    } else {
      values.push(
        { path: 'electrical.batteries.racebox.capacity.stateOfCharge', value: (batteryByte & 0x7F) / 100 },
        { path: 'electrical.batteries.racebox.chargingMode', value: (batteryByte & 0x80) ? 'charging' : 'not charging' }
      );
    }

    const fixStatus = payload.readUInt8(20);
    const fixStatusFlags = payload.readUInt8(21);
    values.push(
      { path: 'navigation.gnss.satellites', value: payload.readUInt8(23) },
      { path: 'navigation.gnss.horizontalDilution', value: payload.readUInt16LE(64) / 100 },
      { path: 'navigation.gnss.positionError', value: payload.readUInt32LE(40) / 1000 }
    );

    if (fixStatus >= 2 && (fixStatusFlags & 0x01)) {
      values.push(
        { path: 'navigation.position', value: { latitude: payload.readInt32LE(28) / 10000000, longitude: payload.readInt32LE(24) / 10000000 } },
        { path: 'navigation.speedOverGround', value: payload.readInt32LE(48) / 1000 },
        { path: 'navigation.courseOverGroundTrue', value: (payload.readInt32LE(52) / 100000) * (Math.PI / 180) },
        { path: 'navigation.gnss.type', value: 'GPS+GLONASS+GALILEO' }
      );
    }

    if (app) {
      app.handleMessage(plugin.id, {
        updates: [{ source: { label: plugin.id }, timestamp: new Date().toISOString(), values }]
      });
    }
  }

  plugin.registerWithRouter = function (router) {
    router.get('/status', (req, res) => {
      res.json({
        connected: !!currentDevice,
        isMicro,
        waveDetection: !!(activeOptions && activeOptions.enableWaveDetection),
        packetCount: dataPacketCount,
        kfState: { s: kfS, v: kfV, b: kfB },
        currentHs: currentWaveHeight,
        currentPeriod: currentWavePeriod,
        calibrationArmed: calibrationRequested,
        offsets: (activeOptions && activeOptions.offsets) || { pitch: 0, roll: 0 },
        lastCalibratedAt
      });
    });

    // Arms an immediate IMU zero calibration: the very next incoming
    // RaceBox packet captures the current accelerometer-derived pitch/roll
    // as the new zero offset and persists it via savePluginOptions. Unlike
    // the config-screen "zeroImuNow" checkbox (which only takes effect on
    // Save, and Save triggers plugin.stop()+start() — a full BLE
    // disconnect/reconnect), this flips a flag the running session already
    // polls on every packet, so calibrating never interrupts the live data
    // stream. Requires the boat to be level and floating naturally the
    // moment this fires, same as the checkbox method.
    router.post('/calibrate', (req, res) => {
      if (!currentDevice) {
        res.status(409).json({ error: 'RaceBox not connected yet — wait for a live connection before calibrating.' });
        return;
      }
      calibrationRequested = true;
      if (app) app.setProviderStatus('CAL: Armed for calibration. Boat must be level.');
      res.json({ ok: true, armed: true });
    });
  };

  // Test hook: lets the suite drive the real parser and wave pipeline with
  // synthetic packets instead of a live BLE device. Not part of the plugin API.
  Object.defineProperty(plugin, '_ingestForTest', {
    value: processIncomingBytes, enumerable: false
  });

  return plugin;
};

module.exports._testable = {
  createPlugin: (app) => module.exports(app)
};
