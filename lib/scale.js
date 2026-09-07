// Live scale streaming engine, ported from the weighbridge system's app.js.
// Handles serial-profile auto-detection, frame parsing, stability detection,
// and per-COM-port SSE fan-out so multiple browser tabs can share one open port.

const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');

const SERIAL_PROFILES = [
    { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
    { baudRate: 9600, dataBits: 7, stopBits: 1, parity: 'even' },
    { baudRate: 9600, dataBits: 7, stopBits: 1, parity: 'odd' },
    { baudRate: 2400, dataBits: 8, stopBits: 1, parity: 'none' },
    { baudRate: 4800, dataBits: 8, stopBits: 1, parity: 'none' },
    { baudRate: 19200, dataBits: 8, stopBits: 1, parity: 'none' },
];

const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
const SCALE_PROBE_TIMEOUT_MS = 2500;
const SCALE_HEARTBEAT_MS = 15000;
const SCALE_SAMPLE_WINDOW = 8;
const STREAM_MOVEMENT_DELTA_KG = 0.05;
const STREAM_UNSTABLE_HOLD_MS = 900;
const STREAM_CONNECT_RETRY_COOLDOWN_MS = 1200;
const IDLE_DISCONNECT_MS = 30000;

const successfulProfileByCom = new Map();
const scaleSessionsByCom = new Map();

function normalizeComName(comName) {
    return String(comName || '').trim().toUpperCase();
}

function getProfileKey(profile) {
    return `${profile.baudRate}-${profile.dataBits}-${profile.stopBits}-${profile.parity}`;
}

function dedupeProfiles(profiles) {
    const seen = new Set();
    const output = [];
    for (const profile of profiles) {
        const key = getProfileKey(profile);
        if (!seen.has(key)) {
            seen.add(key);
            output.push(profile);
        }
    }
    return output;
}

function reorderProfiles(comPort, profiles) {
    const normalizedCom = normalizeComName(comPort);
    const cached = successfulProfileByCom.get(normalizedCom);
    if (!cached) {
        return profiles;
    }

    if (Date.now() - cached.lastSuccessAt > PROFILE_CACHE_TTL_MS) {
        successfulProfileByCom.delete(normalizedCom);
        return profiles;
    }

    const cachedKey = getProfileKey(cached.profile);
    const preferred = profiles.find((profile) => getProfileKey(profile) === cachedKey);
    if (!preferred) {
        return profiles;
    }

    return [preferred, ...profiles.filter((profile) => getProfileKey(profile) !== cachedKey)];
}

function getScaleProfiles(comPort) {
    const overrideBaudRate = Number(process.env.SCALE_BAUD_RATE || 0);
    const forceOverride = String(process.env.SCALE_FORCE_BAUD || '').toLowerCase() === 'true';

    if (overrideBaudRate > 0) {
        const overrideProfiles = [
            { baudRate: overrideBaudRate, dataBits: 8, stopBits: 1, parity: 'none' },
            { baudRate: overrideBaudRate, dataBits: 7, stopBits: 1, parity: 'even' },
            { baudRate: overrideBaudRate, dataBits: 7, stopBits: 1, parity: 'odd' },
        ];

        if (forceOverride) {
            return dedupeProfiles(overrideProfiles);
        }

        return reorderProfiles(comPort, dedupeProfiles([...overrideProfiles, ...SERIAL_PROFILES]));
    }

    return reorderProfiles(comPort, SERIAL_PROFILES);
}

function getLastCapturedNumber(text, regex) {
    let lastValue = null;
    let match;

    while ((match = regex.exec(text)) !== null) {
        lastValue = match[1];
    }

    regex.lastIndex = 0;
    return lastValue;
}

function parseScaleReading(text) {
    if (!text) {
        return null;
    }

    const raw = String(text);
    const normalized = raw.replace(/,/g, '.');

    const gsFrameValue = getLastCapturedNumber(
        normalized,
        /(?:ST|US)\s*,\s*GS[^\d-]*(-?\d+(?:\.\d{1,3})?)/gi
    );
    if (gsFrameValue) {
        const numeric = Number(gsFrameValue);
        return Number.isFinite(numeric) ? numeric : null;
    }

    const kgValue = getLastCapturedNumber(
        normalized,
        /(-?\d+(?:\.\d{1,3})?)\s*kg\b/gi
    );
    if (kgValue) {
        const numeric = Number(kgValue);
        return Number.isFinite(numeric) ? numeric : null;
    }

    const looseMatches = [...normalized.matchAll(/-?\d+(?:\.\d{1,3})?/g)];
    if (looseMatches.length > 0) {
        const lastValue = looseMatches[looseMatches.length - 1][0];
        const numeric = Number(lastValue);
        return Number.isFinite(numeric) ? numeric : null;
    }

    return null;
}

function isStable(samples) {
    if (!samples || samples.length < 3) {
        return false;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
    const tolerance = Math.max(0.1, Math.abs(median) * 0.08);
    const inBand = samples.filter((value) => Math.abs(value - median) <= tolerance);
    return inBand.length >= Math.ceil(samples.length * 0.66);
}

function safeCloseAsync(port) {
    return new Promise((resolve) => {
        if (!port || !port.isOpen) {
            return resolve();
        }
        port.close((error) => {
            if (error) {
                console.error('Scale close error:', error.message);
            }
            resolve();
        });
    });
}

function createScaleSession(comPort) {
    return {
        comPort,
        status: 'disconnected',
        profile: null,
        port: null,
        parser: null,
        latestReading: null,
        sampleWindow: [],
        lastWeight: null,
        unstableUntilTs: 0,
        stableSinceTs: 0,
        lastConnectErrorAt: 0,
        lastConnectErrorMessage: null,
        clients: new Set(),
        connectingPromise: null,
        lastError: null,
        pendingCloseTimer: null,
    };
}

function getOrCreateScaleSession(comPort) {
    const normalizedCom = normalizeComName(comPort);
    if (!scaleSessionsByCom.has(normalizedCom)) {
        scaleSessionsByCom.set(normalizedCom, createScaleSession(normalizedCom));
    }
    return scaleSessionsByCom.get(normalizedCom);
}

function broadcastScaleEvent(session, event, payload) {
    const text = JSON.stringify(payload);
    session.clients.forEach((client) => {
        try {
            client.write(`event: ${event}\n`);
            client.write(`data: ${text}\n\n`);
        } catch (_) {
            // ignore stale stream sockets
        }
    });
}

function publishScaleReading(session, raw, value) {
    if (!Number.isFinite(value)) {
        return;
    }

    const now = Date.now();
    if (session.lastWeight !== null && Math.abs(value - session.lastWeight) >= STREAM_MOVEMENT_DELTA_KG) {
        session.unstableUntilTs = now + STREAM_UNSTABLE_HOLD_MS;
    }
    session.lastWeight = value;

    session.sampleWindow.push(value);
    if (session.sampleWindow.length > SCALE_SAMPLE_WINDOW) {
        session.sampleWindow.shift();
    }

    const stableByWindow = isStable(session.sampleWindow);
    const movementUnstable = now < session.unstableUntilTs;
    const stable = stableByWindow && !movementUnstable;
    session.stableSinceTs = stable ? (session.stableSinceTs || now) : 0;

    const reading = {
        com: session.comPort,
        raw: String(raw || '').trim(),
        weight: Number(value.toFixed(2)),
        stable,
        profileUsed: session.profile,
        timestamp: now,
    };

    session.latestReading = reading;
    broadcastScaleEvent(session, 'reading', { success: true, ...reading });
}

function clearPendingClose(session) {
    if (session.pendingCloseTimer) {
        clearTimeout(session.pendingCloseTimer);
        session.pendingCloseTimer = null;
    }
}

async function disconnectScaleSession(comPort, reason = 'Disconnected') {
    const session = getOrCreateScaleSession(comPort);
    clearPendingClose(session);

    if (session.parser) {
        session.parser.removeAllListeners('data');
        try {
            session.port.unpipe(session.parser);
        } catch (_) {
            // no-op
        }
    }

    if (session.port) {
        session.port.removeAllListeners('error');
        session.port.removeAllListeners('close');
    }

    const portToClose = session.port;
    session.port = null;
    session.parser = null;
    session.profile = null;
    session.status = 'disconnected';
    session.sampleWindow = [];
    session.lastWeight = null;
    session.unstableUntilTs = 0;
    session.stableSinceTs = 0;
    session.lastError = reason;

    await safeCloseAsync(portToClose);
    broadcastScaleEvent(session, 'status', {
        success: false,
        com: session.comPort,
        status: session.status,
        message: reason,
    });
    return session;
}

function scheduleIdleDisconnect(session) {
    clearPendingClose(session);
    session.pendingCloseTimer = setTimeout(() => {
        if (session.clients.size === 0) {
            disconnectScaleSession(session.comPort, `Session ${session.comPort} closed due to inactivity`);
        }
    }, IDLE_DISCONNECT_MS);
}

async function tryConnectStreamProfile(session, profile, probeTimeoutMs) {
    const port = new SerialPort(session.comPort, {
        ...profile,
        autoOpen: false,
        lock: false,
        rtscts: false,
        xon: false,
        xoff: false,
        xany: false,
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        let probeCompleted = false;
        let parser = null;

        function finish(error) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);

            if (error) {
                if (parser) {
                    parser.removeAllListeners('data');
                    try {
                        port.unpipe(parser);
                    } catch (_) {
                        // no-op
                    }
                }
                port.removeAllListeners('error');
                port.removeAllListeners('close');
                safeCloseAsync(port).then(() => reject(error));
                return;
            }

            probeCompleted = true;
            resolve({ port, parser });
        }

        const timer = setTimeout(() => {
            finish(new Error('No valid scale stream data received before timeout'));
        }, probeTimeoutMs);

        port.on('error', (error) => {
            if (!probeCompleted) {
                finish(error);
                return;
            }
            disconnectScaleSession(session.comPort, error.message || 'Scale stream error');
        });

        port.on('close', () => {
            if (!probeCompleted) {
                finish(new Error('Port closed before any valid scale stream data was received'));
                return;
            }
            disconnectScaleSession(session.comPort, `Port ${session.comPort} closed`);
        });

        port.open((error) => {
            if (error) {
                finish(error);
                return;
            }

            parser = port.pipe(new Readline({ delimiter: '\r\n' }));
            parser.on('data', (raw) => {
                const parsed = parseScaleReading(raw);
                if (parsed === null) {
                    return;
                }

                publishScaleReading(session, raw, parsed);
                if (!probeCompleted) {
                    finish(null);
                }
            });
        });
    });
}

async function connectScaleSession(comPort) {
    const session = getOrCreateScaleSession(comPort);
    clearPendingClose(session);

    if (
        session.lastConnectErrorAt > 0
        && (Date.now() - session.lastConnectErrorAt) < STREAM_CONNECT_RETRY_COOLDOWN_MS
    ) {
        throw new Error(session.lastConnectErrorMessage || 'Scale connection cooling down, retry shortly.');
    }

    if (session.status === 'connected' && session.port && session.port.isOpen) {
        return session;
    }

    if (session.connectingPromise) {
        return session.connectingPromise;
    }

    session.status = 'connecting';
    session.lastError = null;
    session.connectingPromise = (async () => {
        const profiles = getScaleProfiles(session.comPort);
        let lastError = null;

        for (const profile of profiles) {
            try {
                const connected = await tryConnectStreamProfile(session, profile, SCALE_PROBE_TIMEOUT_MS);
                session.port = connected.port;
                session.parser = connected.parser;
                session.profile = profile;
                session.status = 'connected';
                session.lastConnectErrorAt = 0;
                session.lastConnectErrorMessage = null;
                successfulProfileByCom.set(session.comPort, {
                    profile,
                    lastSuccessAt: Date.now(),
                });
                broadcastScaleEvent(session, 'status', {
                    success: true,
                    com: session.comPort,
                    status: session.status,
                    profileUsed: session.profile,
                });
                return session;
            } catch (error) {
                lastError = error;
                session.lastError = error.message;
                console.warn(`Scale stream profile failed on ${session.comPort}:`, profile, '-', error.message);
            }
        }

        session.status = 'disconnected';
        session.lastConnectErrorAt = Date.now();
        session.lastConnectErrorMessage = (lastError && lastError.message) || 'Unable to open scale stream with available serial profiles.';
        throw (lastError || new Error('Unable to open scale stream with available serial profiles.'));
    })();

    try {
        return await session.connectingPromise;
    } finally {
        session.connectingPromise = null;
    }
}

async function listComPorts() {
    const ports = await SerialPort.list();
    return ports.map((port) => port.path);
}

/**
 * Express handler: GET /api/scale/stream/:com — Server-Sent Events.
 * Emits: connected, reading, status, error, heartbeat.
 */
async function handleScaleStream(req, res) {
    const comPort = normalizeComName(req.params.com);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
        res.write('event: heartbeat\n');
        res.write(`data: {"ts":${Date.now()}}\n\n`);
    }, SCALE_HEARTBEAT_MS);

    try {
        const session = await connectScaleSession(comPort);
        session.clients.add(res);
        clearPendingClose(session);

        res.write('event: connected\n');
        res.write(`data: ${JSON.stringify({
            success: true,
            com: session.comPort,
            status: session.status,
            profileUsed: session.profile,
        })}\n\n`);

        if (session.latestReading) {
            res.write('event: reading\n');
            res.write(`data: ${JSON.stringify({ success: true, ...session.latestReading })}\n\n`);
        }

        req.on('close', () => {
            clearInterval(heartbeat);
            session.clients.delete(res);
            if (session.clients.size === 0) {
                scheduleIdleDisconnect(session);
            }
            res.end();
        });
    } catch (error) {
        clearInterval(heartbeat);
        res.write('event: error\n');
        res.write(`data: ${JSON.stringify({ success: false, message: error.message })}\n\n`);
        res.end();
    }
}

function getLatestReading(comPort) {
    const session = scaleSessionsByCom.get(normalizeComName(comPort));
    return session ? session.latestReading : null;
}

module.exports = {
    listComPorts,
    handleScaleStream,
    getLatestReading,
    parseScaleReading,
    isStable,
    normalizeComName,
};
