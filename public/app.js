// RaceBox IMU live visualization
// Subscribes to Signal K WebSocket and renders heave displacement, attitude, and wave stats.

const WINDOW_S   = 30;          // seconds of heave trace visible
const BUFFER_MAX = 60 * 25;     // 60 s × 25 Hz samples buffered

const heaveBuffer = [];         // { t:ms, h:m, slam:m/s2 }
const vals = { hs: 0, period: 0, slam: 0, pitch: 0, roll: 0 };
let lastDataMs = 0;
let connected  = false;

// ── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws    = new WebSocket(`${proto}//${location.host}/signalk/v1/stream?subscribe=none`);

    ws.onopen = () => {
        connected = true;
        ws.send(JSON.stringify({
            context: 'vessels.self',
            subscribe: [
                { path: 'navigation.imu.heaveDisplacement',  period: 40   },
                { path: 'environment.wind.waveHeight',        period: 1000 },
                { path: 'environment.wind.wavePeriod',        period: 1000 },
                { path: 'performance.hull.slamAcceleration',  period: 40   },
                { path: 'navigation.attitude.pitch',          period: 100  },
                { path: 'navigation.attitude.roll',           period: 100  },
            ]
        }));
    };

    ws.onmessage = e => {
        try {
            const msg = JSON.parse(e.data);
            if (!msg.updates) return;
            for (const upd of msg.updates)
                for (const v of (upd.values || []))
                    ingest(v.path, v.value);
        } catch (_) {}
    };

    ws.onclose = ws.onerror = () => {
        connected = false;
        setTimeout(connect, 3000);
    };
}

function ingest(path, value) {
    if (typeof value !== 'number' || !isFinite(value)) return;
    lastDataMs = Date.now();
    switch (path) {
        case 'navigation.imu.heaveDisplacement':
            heaveBuffer.push({ t: lastDataMs, h: value, slam: vals.slam });
            if (heaveBuffer.length > BUFFER_MAX) heaveBuffer.shift();
            break;
        case 'environment.wind.waveHeight':      vals.hs     = value; break;
        case 'environment.wind.wavePeriod':      vals.period = value; break;
        case 'performance.hull.slamAcceleration': vals.slam   = value; break;
        case 'navigation.attitude.pitch':        vals.pitch  = value; break;
        case 'navigation.attitude.roll':         vals.roll   = value; break;
    }
}

// ── Canvas helper ──────────────────────────────────────────────────────────

function fitCanvas(canvas) {
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const pw   = Math.round(rect.width  * dpr);
    const ph   = Math.round(rect.height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width  = pw;
        canvas.height = ph;
    }
    // Re-apply DPR scale every frame (canvas.width reset clears the transform)
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: rect.width, h: rect.height };
}

// ── Heave chart ────────────────────────────────────────────────────────────

function drawHeave(canvas) {
    const { w, h } = fitCanvas(canvas);
    const ctx    = canvas.getContext('2d');
    const nowMs  = Date.now();
    const winMs  = WINDOW_S * 1000;
    const recent = heaveBuffer.filter(s => nowMs - s.t <= winMs);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, w, h);

    // Auto-scale Y: max |heave| in window, minimum 0.5 m
    let yMax = 0.5;
    for (const s of recent) if (Math.abs(s.h) > yMax) yMax = Math.abs(s.h);
    yMax = Math.ceil(yMax * 1.4 * 4) / 4;  // round up to nearest 0.25 m

    const toX = t  => ((t - (nowMs - winMs)) / winMs) * w;
    const toY = hv => h * 0.5 - (hv / yMax) * (h * 0.5 - 14);

    // Grid lines
    const step = yMax >= 2 ? 1.0 : yMax >= 0.75 ? 0.5 : 0.25;
    ctx.font = '10px monospace';
    for (let y = -yMax; y <= yMax + 0.01; y += step) {
        const py = toY(y);
        const isZero = Math.abs(y) < 0.01;
        ctx.strokeStyle = isZero ? '#252535' : '#14151e';
        ctx.lineWidth   = isZero ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
        if (!isZero) {
            ctx.fillStyle = '#2a3040';
            ctx.fillText((y > 0 ? '+' : '') + y.toFixed(step < 0.5 ? 2 : 1) + ' m', 4, py - 3);
        }
    }

    // Hs band: ±Hs/2 = ±2σ shaded region
    if (vals.hs > 0.05) {
        const hy = vals.hs / 2;
        ctx.fillStyle = 'rgba(76, 175, 80, 0.05)';
        ctx.fillRect(0, toY(hy), w, toY(-hy) - toY(hy));
        ctx.strokeStyle = 'rgba(76, 175, 80, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        for (const sign of [1, -1]) {
            ctx.beginPath(); ctx.moveTo(0, toY(sign * hy)); ctx.lineTo(w, toY(sign * hy)); ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    // Slam markers: vertical red flash behind the trace
    const SLAM_MARK = 2.0;
    for (const s of recent) {
        if (s.slam > SLAM_MARK) {
            const alpha = Math.min(0.6, 0.15 + (s.slam - SLAM_MARK) / 25);
            ctx.fillStyle = `rgba(255, 70, 50, ${alpha})`;
            ctx.fillRect(toX(s.t) - 1.5, 0, 3, h);
        }
    }

    // Heave trace
    if (recent.length > 1) {
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth   = 2;
        ctx.lineJoin    = 'round';
        ctx.beginPath();
        for (let i = 0; i < recent.length; i++) {
            const x = toX(recent[i].t), y = toY(recent[i].h);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Corner labels
    ctx.font = '10px monospace';
    ctx.fillStyle = '#2a3448';
    ctx.fillText(`heave  ${WINDOW_S} s`, 4, h - 5);
    if (vals.hs > 0.05) {
        const label = `±Hs/2 = ±${(vals.hs / 2).toFixed(2)} m`;
        ctx.fillStyle = 'rgba(76, 175, 80, 0.5)';
        ctx.fillText(label, w - label.length * 6.5, h - 5);
    }
}

// ── Artificial horizon ─────────────────────────────────────────────────────

function drawHorizon(canvas) {
    const { w, h } = fitCanvas(canvas);
    const ctx  = canvas.getContext('2d');
    const cx   = w / 2, cy = h / 2;
    const r    = Math.min(w, h) / 2 - 2;
    const maxP = Math.PI / 4;           // ±45° pitch spans ±r pixels

    ctx.clearRect(0, 0, w, h);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    // Translate to center + pitch offset, then rotate with roll
    const pitchPx = (vals.pitch / maxP) * r;
    ctx.save();
    ctx.translate(cx, cy + pitchPx);
    ctx.rotate(-vals.roll);

    // Sky (dark blue) and sea (near-black green)
    ctx.fillStyle = '#0d1e30';
    ctx.fillRect(-r * 2, -r * 2, r * 4, r * 2);
    ctx.fillStyle = '#091209';
    ctx.fillRect(-r * 2, 0, r * 4, r * 2);

    // Horizon line
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-r * 2, 0); ctx.lineTo(r * 2, 0); ctx.stroke();

    ctx.restore();

    // Plane reference — fixed, not affected by roll/pitch
    ctx.strokeStyle = '#ffd060';
    ctx.lineWidth = 1.5;
    const arm = r * 0.35;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.62, cy); ctx.lineTo(cx - arm, cy);
    ctx.moveTo(cx + arm, cy);      ctx.lineTo(cx + r * 0.62, cy);
    ctx.moveTo(cx, cy - 5);        ctx.lineTo(cx, cy + 5);
    ctx.stroke();

    ctx.restore();

    // Outer ring
    ctx.strokeStyle = '#1e2535';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
}

// ── Stats DOM ──────────────────────────────────────────────────────────────

function updateStats() {
    const stale = Date.now() - lastDataMs > 5000;
    const badge = document.getElementById('conn-badge');
    if (connected && !stale) {
        badge.textContent = '● LIVE';
        badge.className   = 'badge live';
    } else if (connected && stale) {
        badge.textContent = '● STALE';
        badge.className   = 'badge stale';
    } else {
        badge.textContent = '● OFFLINE';
        badge.className   = 'badge offline';
    }

    const fmt = (v, d) => (v > 0.01) ? v.toFixed(d) : '–';
    document.getElementById('val-hs').textContent     = fmt(vals.hs, 2);
    document.getElementById('val-period').textContent  = fmt(vals.period, 1);

    const slamEl = document.getElementById('val-slam');
    slamEl.textContent = vals.slam > 0.5 ? vals.slam.toFixed(1) : '–';
    slamEl.style.color = vals.slam > 15 ? '#ff4444' : vals.slam > 5 ? '#ff9922' : '';

    const deg = r => (r * 180 / Math.PI).toFixed(1) + '°';
    document.getElementById('val-pitch').textContent = deg(vals.pitch);
    document.getElementById('val-roll').textContent  = deg(vals.roll);
}

// ── Animation loop ─────────────────────────────────────────────────────────

function frame() {
    drawHeave(document.getElementById('heave-canvas'));
    drawHorizon(document.getElementById('horizon-canvas'));
    updateStats();
    requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);
