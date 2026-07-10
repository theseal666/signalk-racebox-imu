# signalk-racebox-imu — Development Plan

## Released

### v1.0.0
Initial release: BLE via `@abandonware/noble`, 25Hz telemetry streaming, full UBX packet parser.

### v1.1.0
- Experimental wave height & period detection (leaky double-integrator + pitch zero-crossing heuristic)
- Complex slam detection: 3D G-force resultant + angular jolt derivative
- In-app IMU calibration (pitch/roll offset zeroing)

### v1.1.1 — 2026-07-08
- Migrated BLE stack from `@abandonware/noble` to `node-ble` to fix a deterministic ~41 s event-loop stall on Linux kernel 6.18 (`KarukeraPi`)
- Async session loop with per-step timeouts and data-staleness watchdog
- RaceBox Micro vs Mini auto-detection (voltage path vs battery %)

### v1.3.0 — 2026-07-10
**OU Kalman wave height filter + live visualization webapp**

Replaces the leaky double-integrator approach for heave estimation with a proper
3-state Ornstein-Uhlenbeck Kalman filter.

**Algorithm** (credit: [bareboat-necessities/ocean-imu](https://github.com/bareboat-necessities/ocean-imu),
*Kalman OU-W3D* paper):

> Ocean waves are modelled as a mean-reverting (OU) stochastic process — specifically
> a damped harmonic oscillator driven by white noise. This prevents the unbounded drift
> of naive double-integration without a leaky-factor hack, and allows the filter to
> simultaneously estimate and remove the accelerometer's DC bias.

State vector: `x = [heave_displacement, heave_velocity, accel_bias]`

Process model (Euler, dt = 0.04 s):
```
s_{k+1} = s_k + dt · v_k
v_{k+1} = v_k + dt · (−ω₀²·s_k − 2ζω₀·v_k)   ← OU mean-reversion
b_{k+1} = b_k                                    ← bias random walk
```

Observation model (accelerometer measures v̇ + bias):
```
z_k = −ω₀²·s − 2ζω₀·v + b + noise
H   = [−ω₀², −2ζω₀, 1]
```

Significant wave height: **Hs = 4σ** of `heave_displacement` over a rolling window
(standard oceanographic definition — not single-wave peak-to-peak).

Wave period: rolling mean of upward zero-crossing intervals of filtered heave.

**Settings exposed for tuning:**
- `waveFilterPeriod` — dominant wave period initial estimate (s), default 8.0
- `waveFilterDamping` — ζ damping ratio, default 0.15
- `waveHsWindow` — rolling window duration for Hs (s), default 120

**Fixed internal noise constants:**
- `Q_V = 0.25` — wave energy forcing variance per step (m/s²)²
- `Q_B = 1e-6` — bias drift variance per step
- `R_A = 9e-4` — accelerometer measurement noise variance (≈ 0.03 m/s²)²

**Live visualization webapp** (`public/`):
- Registered as `signalk-webapp` — appears in Signal K Webapps panel at `/signalk-racebox-imu/`
- Scrolling 30s heave displacement chart (canvas, 60fps via requestAnimationFrame)
- ±Hs/2 band overlay on the trace (= ±2σ region)
- Slam events as red timeline flashes
- Artificial horizon with live pitch/roll
- Hs, Period, Slam stat cards — data via Signal K WebSocket, auto-reconnects
- New path: `navigation.imu.heaveDisplacement` (m) — the Kalman-filtered heave state

## Backlog

### Adaptive ω₀
Let the filter adapt its dominant frequency estimate from the measured zero-crossing
period, so the model stays accurate when actual wave period drifts from the initial
`waveFilterPeriod` setting.

### Correct Signal K path for wave height
Current path `environment.wind.waveHeight` is a placeholder.
The proper SK path is `environment.water.waves.significantWaveHeight`.
Held back to avoid breaking existing Grafana dashboards and Expedition configs on the boat.

### 3D OU (surge + sway + heave)
Extend to the full OU_II 18-state model from the ocean-imu paper. Requires resolving
surge and sway accelerations — meaningful only if the IMU is mounted on the keel centreline.
