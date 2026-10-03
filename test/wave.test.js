const assert = require('chai').assert;
const pluginFactory = require('../index.js');

// Build a RaceBox data packet (class 0xFF, id 0x01) carrying the six IMU axes.
// accel is g*1000 (int16), gyro is deg/s*100 (int16).
function packet({ ax, ay, az, gx = 0, gy = 0, gz = 0 }) {
  const payload = Buffer.alloc(80);
  payload.writeInt16LE(Math.round(ax * 1000), 68);
  payload.writeInt16LE(Math.round(ay * 1000), 70);
  payload.writeInt16LE(Math.round(az * 1000), 72);
  payload.writeInt16LE(Math.round(gx * 100), 74);
  payload.writeInt16LE(Math.round(gy * 100), 76);
  payload.writeInt16LE(Math.round(gz * 100), 78);
  const pkt = Buffer.alloc(6 + 80 + 2);
  pkt[0] = 0xB5; pkt[1] = 0x62; pkt[2] = 0xFF; pkt[3] = 0x01;
  pkt.writeUInt16LE(80, 4);
  payload.copy(pkt, 6);
  let ckA = 0, ckB = 0;
  for (let i = 2; i < pkt.length - 2; i++) { ckA = (ckA + pkt[i]) & 0xFF; ckB = (ckB + ckA) & 0xFF; }
  pkt[pkt.length - 2] = ckA; pkt[pkt.length - 1] = ckB;
  return pkt;
}

// Earth frame -> body frame for a roll of phi about the boat's fore-aft axis.
// Checked against the plugin's own convention: at rest the earth vertical
// (0,0,1) must read (0, sin phi, cos phi) in the body frame, which is what
// roll = atan2(aY, aZ) inverts.
function toBody(surge, sway, vert, phi) {
  return {
    ax: surge,
    ay: sway * Math.cos(phi) + vert * Math.sin(phi),
    az: -sway * Math.sin(phi) + vert * Math.cos(phi),
  };
}

function harness(opts = {}) {
  const seen = {};
  const app = {
    debug: () => {},
    setProviderStatus: () => {},
    savePluginOptions: () => {},
    handleMessage: (id, delta) => {
      (delta.updates || []).forEach((u) => (u.values || []).forEach((v) => { seen[v.path] = v.value; }));
    }
  };
  const plugin = pluginFactory(app);
  plugin.start(Object.assign({
    enableWaveDetection: true, waveAttitudeTau: 20, waveHsWindow: 120,
    offsets: { pitch: 0, roll: 0 }
  }, opts));
  return { plugin, seen };
}

// 25 Hz. Steady heel of heelDeg. Horizontal surge/sway in the EARTH frame only
// (so genuinely flat water), plus an optional earth-vertical heave of
// `heaveAmp` metres amplitude at `heavePeriod` seconds.
function run(plugin, seconds, heelDeg, swayAmp, heaveAmp = 0, heavePeriod = 4) {
  const n = seconds * 25, phi = (heelDeg * Math.PI) / 180;
  const w = (2 * Math.PI) / heavePeriod;
  for (let i = 0; i < n; i++) {
    const t = i / 25;
    const sway = swayAmp * Math.sin((2 * Math.PI * t) / 5);       // 5 s horizontal slop
    const surge = 0.4 * swayAmp * Math.sin((2 * Math.PI * t) / 7);
    // vertical specific force = gravity + heave acceleration, in g
    const heaveAcc = heaveAmp * w * w * Math.sin(w * t) / 9.80665;
    const b = toBody(surge, sway, 1.0 + heaveAcc, phi);
    plugin._ingestForTest(packet(b));
  }
}

describe('wave pipeline', () => {
  it('does not turn steady heel into wave height', function () {
    this.timeout(60000);
    const a = harness();
    run(a.plugin, 240, 20, 0.08);          // 20 deg heel, 4 minutes, flat water
    const hs = a.seen['environment.wind.waveHeight'];
    a.plugin.stop();
    // Flat water heeled hard over. On 2026-10-03 this configuration reported
    // 5-6 m because the tilt compensation was degenerate.
    assert.isBelow(hs === undefined ? 0 : hs, 0.35,
      `heeled flat water reported Hs = ${hs} m`);
  });

  it('reports the same sea state heeled as upright', function () {
    this.timeout(120000);
    const flat = harness();
    run(flat.plugin, 240, 2, 0.08);
    const upright = flat.seen['environment.wind.waveHeight'] || 0;
    flat.plugin.stop();

    const heeled = harness();
    run(heeled.plugin, 240, 20, 0.08);
    const athwart = heeled.seen['environment.wind.waveHeight'] || 0;
    heeled.plugin.stop();

    // Same water, different heel. On the reference sail these differed by ~4 m.
    assert.isBelow(Math.abs(athwart - upright), 0.35,
      `upright ${upright.toFixed(3)} m vs heeled ${athwart.toFixed(3)} m — heel still leaking in`);
  });

  it('still measures a real wave while heeled', function () {
    this.timeout(60000);
    const a = harness();
    run(a.plugin, 240, 20, 0.08, 0.5, 4);   // 0.5 m amplitude heave, 4 s period
    const hs = a.seen['environment.wind.waveHeight'];
    a.plugin.stop();
    // Hs = 4 sigma; a sinusoid of amplitude A has sigma = A/sqrt(2),
    // so the expected figure is about 2.8*A = 1.4 m. Generous bounds: the
    // point is that a real wave is still detected, and detected while heeled.
    assert.isAbove(hs === undefined ? 0 : hs, 0.4, `real heave under-read as ${hs} m`);
    assert.isBelow(hs, 3.0, `real heave over-read as ${hs} m`);
  });

  it('measures short chop, where the stock 8 s filter period over-reads most', function () {
    this.timeout(60000);
    const a = harness();
    run(a.plugin, 300, 20, 0.08, 0.15, 2.2);   // 0.15 m at 2.2 s: Vanern on 2026-10-03
    const hs = a.seen['environment.wind.waveHeight'];
    a.plugin.stop();
    // Expected 2.83 * 0.15 = 0.42 m. With omega0 pinned at the configured 8 s
    // this reads ~13x high and is then thrown out by the steepness guard,
    // leaving 0.00 — which is exactly the pair of failures seen on the water.
    assert.isAbove(hs === undefined ? 0 : hs, 0.25, `short chop under-read as ${hs} m`);
    assert.isBelow(hs, 0.70, `short chop over-read as ${hs} m`);
  });

  it('rearms the auto-zero timer so the heave window can refill', () => {
    // Regression guard for the latch: the flush used to leave
    // lastWaveDetectedTime untouched, so once 60 s passed without a detection
    // the window was cleared on every sample and Hs could never be computed.
    const src = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    const i = src.indexOf('Auto-zero and flush buffers');
    const body = src.slice(i, src.indexOf('}', i) + 1);
    assert.include(body, 'lastWaveDetectedTime = now',
      'the 60 s flush must rearm lastWaveDetectedTime or it latches permanently');
  });
});
