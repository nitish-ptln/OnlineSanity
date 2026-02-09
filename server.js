const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();

const DATA_DIR = path.join(__dirname, 'data');
const COMMANDS_FILE = path.join(DATA_DIR, 'commands.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');

// Helper: Get all valid local IPs for this machine (including IPv4 and IPv6)
const getLocalIps = () => {
    const interfaces = os.networkInterfaces();
    const ips = ['127.0.0.1', '::1'];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            ips.push(iface.address);
        }
    }
    return ips;
};

// Helper: Get the primary network IPv4 for display
const getPrimaryIp = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
};

// Configuration
let config = {
    targetPort: 22,
    adbPort: 5555,
    adbCommand: 'adb1'
};

// Store user-specific overrides: Map<ID, config>
const userConfigs = new Map();

// TCP Proxy Storage for DLT remote access
const dltProxies = new Map(); // Port -> net.Server

const setupDltProxy = (publicPort, internalPort) => {
    if (dltProxies.has(publicPort)) return;

    const proxy = net.createServer((clientSocket) => {
        // Bridge to the INTERNAL port where ADB is listening
        const serverSocket = net.connect(internalPort, '127.0.0.1', () => {
            clientSocket.pipe(serverSocket);
            serverSocket.pipe(clientSocket);
        });

        clientSocket.on('error', (err) => {
            console.error(`[DLT Bridge ${publicPort}] Client disconnected:`, err.message);
            serverSocket.destroy();
        });

        serverSocket.on('error', (err) => {
            console.error(`[DLT Bridge ${publicPort}] Internal ADB Error:`, err.message);
            clientSocket.destroy();
        });
    });

    // We listen on 0.0.0.0 to allow ALL network computers to connect
    proxy.listen(publicPort, '0.0.0.0', () => {
        console.log(`[DLT BRIDGE] 🚀 Global access: ${getPrimaryIp()}:${publicPort} -> Device`);
    });

    proxy.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[DLT Bridge] Public port ${publicPort} is occupied.`);
        } else {
            console.error(`[DLT Bridge ${publicPort}] Proxy error:`, err);
        }
    });

    dltProxies.set(publicPort, proxy);
};

// Global device cache for low-latency command execution
let deviceCache = { devices: [], timestamp: 0 };
const CACHE_TTL = 2000; // 2 seconds cache

// Helper to get cached devices or refresh
const getCachedDevices = async (binary) => {
    const now = Date.now();
    if (now - deviceCache.timestamp < CACHE_TTL && deviceCache.devices.length > 0) {
        return deviceCache.devices;
    }

    const result = await execAsync(`${binary} devices`, 5000);
    const devices = [];
    if (result.stdout) {
        const lines = result.stdout.split(/\r?\n/);
        let listStarted = false;
        for (const line of lines) {
            const raw = line.trim();
            if (!raw || raw.toLowerCase().includes('daemon')) continue;
            if (raw.toLowerCase().includes('list of devices attached')) {
                listStarted = true;
                continue;
            }
            if (listStarted) {
                const parts = raw.split(/\s+/);
                if (parts.length >= 2) {
                    devices.push({ id: parts[0].trim(), status: parts[1].trim() });
                }
            }
        }
    }
    deviceCache = { devices, timestamp: now };
    return devices;
};

// Admin credentials
const ADMIN_USERS = {
    'nitish10.kumar': 'LGE123',
    'vinay.kumar': 'LGE123'
};

const adminTokens = new Set();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware: Check if request is authenticated as admin
const adminAuth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (adminTokens.has(token)) {
        next();
    } else {
        res.status(401).json({ success: false, error: 'Unauthorized' });
    }
};

const getClientId = (req) => {
    const clientId = req.headers['x-client-id'];
    if (clientId) return clientId;
    return getClientIp(req);
};

const getClientIp = (req) => {
    let ip = req.headers['x-forwarded-for'];
    if (ip) {
        ip = ip.split(',')[0].trim();
    } else {
        ip = req.connection?.remoteAddress || req.socket?.remoteAddress;
    }
    if (ip && ip.includes('::ffff:')) ip = ip.split(':').pop();
    if (ip === '::1' || !ip) ip = '127.0.0.1';
    return ip;
};

const getAdbBinary = (req) => {
    const id = getClientId(req);
    const userConfig = userConfigs.get(id);
    if (userConfig && userConfig.adbCommand) return userConfig.adbCommand;
    return config.adbCommand || 'adb1';
};

// Helper to execute command
const execAsync = (command, timeout = 30000) => {
    return new Promise((resolve) => {
        const options = timeout > 0 ? { timeout } : {};
        exec(command, options, (error, stdout, stderr) => {
            const out = stdout ? stdout.toString().trim() : '';
            const err = stderr ? stderr.toString().trim() : '';
            resolve({
                success: !error,
                stdout: out,
                stderr: err,
                error: error,
                exitCode: error ? error.code : 0
            });
        });
    });
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 4), 'utf8');

// Get List of Connected Devices
app.get('/api/devices', async (req, res) => {
    const id = getClientId(req);
    const binary = getAdbBinary(req);
    const clientIp = getClientIp(req);
    const localIps = getLocalIps();

    // If remote, try to connect before listing
    if (!localIps.includes(clientIp)) {
        await execAsync(`${binary} connect ${clientIp}:5555`);
    }

    const result = await execAsync(`${binary} devices`);
    const devices = [];

    if (result.stdout) {
        const lines = result.stdout.split(/\r?\n/);
        let listStarted = false;
        for (const line of lines) {
            const raw = line.trim();
            if (!raw || raw.toLowerCase().includes('daemon')) continue;
            if (raw.toLowerCase().includes('list of devices attached')) {
                listStarted = true;
                continue;
            }
            if (listStarted) {
                const parts = raw.split(/\s+/);
                if (parts.length >= 2) {
                    devices.push({ id: parts[0], status: parts[1] });
                }
            }
        }
    }

    // Cache devices for this session
    if (!userConfigs.has(id)) userConfigs.set(id, { adbCommand: binary, serial: '' });
    userConfigs.get(id).lastKnownDevices = devices;

    res.json({ success: true, devices });
});

// Device status - The core logic that was failing
app.get('/api/device-status', async (req, res) => {
    const id = getClientId(req);
    const binary = getAdbBinary(req);

    // 1. FRESH Discovery
    const result = await execAsync(`${binary} devices`);
    const devices = [];
    if (result.stdout) {
        const lines = result.stdout.split(/\r?\n/);
        let listStarted = false;
        for (const line of lines) {
            const raw = line.trim();
            if (!raw || raw.toLowerCase().includes('daemon')) continue;
            if (raw.toLowerCase().includes('list of devices attached')) {
                listStarted = true;
                continue;
            }
            if (listStarted) {
                const parts = raw.split(/\s+/);
                if (parts.length >= 2) {
                    devices.push({ id: parts[0].trim(), status: parts[1].trim() });
                }
            }
        }
    }

    // 2. Sync session config to ensure ID consistency
    if (!userConfigs.has(id)) userConfigs.set(id, { adbCommand: binary, serial: '' });
    const userConfig = userConfigs.get(id);
    userConfig.lastKnownDevices = devices;

    // 3. Robust Targeting logic
    // We strive to match exactly what is in the dropdown or localStorage
    const savedSerial = (userConfig.serial || '').trim().toLowerCase();
    const readyDevices = devices.filter(d => d.status.toLowerCase() === 'device');

    let isConnected = false;
    let activeTarget = null;

    // A. Priority 1: Match the specific serial requested by browser
    if (savedSerial) {
        const match = devices.find(d => d.id.toLowerCase() === savedSerial);
        if (match && match.status.toLowerCase() === 'device') {
            isConnected = true;
            activeTarget = match.id;
        }
    }

    // B. Priority 2: Absolute Fallback (Auto-Detect)
    // Only fallback to auto-detect IF the user hasn't explicitly locked onto a serial.
    // If they have a savedSerial and it's offline, we report as DISCONNECTED for that serial.
    if (!isConnected && !savedSerial && readyDevices.length > 0) {
        isConnected = true;
        activeTarget = readyDevices[0].id;
    }

    // C. Automatic Root for all ready devices
    if (!global.rootedSerials) global.rootedSerials = new Set();
    readyDevices.forEach(d => {
        const serialKey = `${binary}_${d.id}`;
        if (!global.rootedSerials.has(serialKey)) {
            console.log(`[AUTO-ROOT] New device detected: ${d.id}. Running root...`);
            // Run root in background, don't block
            execAsync(`${binary} -s ${d.id} root`, 5000).catch(() => { });
            global.rootedSerials.add(serialKey);
        }
    });

    // D. Cleanup rootedSet: Remove serials that are no longer online
    if (global.rootedSerials) {
        const onlineKeys = readyDevices.map(d => `${binary}_${d.id}`);
        for (const key of global.rootedSerials) {
            if (!onlineKeys.includes(key)) {
                global.rootedSerials.delete(key);
            }
        }
    }

    let extraInfo = {
        imei: '-', serviceState: '-', region: '-',
        isServicePass: false, radioOn: false,
        simState: -1, simStateText: 'Unknown'
    };

    // 4. Fetch details if we have an active target
    if (isConnected && activeTarget) {
        const adbBase = `${binary} -s ${activeTarget}`;
        try {
            // Run commands in parallel for maximum UI speed
            const [sim, imei, svc, reg, rad, ver] = await Promise.all([
                execAsync(`${adbBase} shell sldd telephony getsimstate`),
                execAsync(`${adbBase} shell sldd telephony getimei`),
                execAsync(`${adbBase} shell sldd telephony getservicestate`),
                execAsync(`${adbBase} shell sldd region getnation`),
                execAsync(`${adbBase} shell "sldd telephony getradiostate; sldd telephony isRadioOn"`),
                execAsync(`${adbBase} shell cat etc/version`)
            ]);

            const parse = (res, regex) => {
                if (!res || !res.stdout) return null;
                const m = res.stdout.match(regex);
                return m ? m[1].trim() : null;
            };

            // Parse SIM State
            const sMatch = parse(sim, /SIM state\s*:\s*(\d+)/i);
            if (sMatch) {
                extraInfo.simState = parseInt(sMatch);
                const states = { 0: 'Unknown', 1: 'Absent', 5: 'Ready', 6: 'Not Ready' };
                extraInfo.simStateText = states[extraInfo.simState] || `State ${extraInfo.simState}`;
            }

            // Parse IMEI
            const iMatch = parse(imei, /IMEI\s*:\s*(\d+)/i);
            if (iMatch) extraInfo.imei = iMatch;

            // Parse Service State
            if (svc && svc.stdout) {
                const voice = svc.stdout.match(/Voice.*?:\s*(\d)/i);
                const data = svc.stdout.match(/Data.*?:\s*(\d)/i);
                if (voice && data) {
                    extraInfo.isServicePass = (voice[1] === '0' && data[1] === '0');
                    extraInfo.serviceState = extraInfo.isServicePass ? 'In Service' : 'Limited Service';
                }
            }

            // Parse Region/Nation
            const nationMatch = parse(reg, /LGE nation\s*:\s*(\d+)/i);
            const regionMatch = parse(reg, /LGE Region info\s*:\s*([^\r\n]+)/i);
            if (regionMatch && nationMatch) {
                extraInfo.region = `${regionMatch} (${nationMatch})`;
            } else if (regionMatch) {
                extraInfo.region = regionMatch;
            } else if (nationMatch) {
                extraInfo.region = nationMatch;
            }

            // Parse Radio State
            if (rad && rad.stdout) {
                const out = rad.stdout;
                // Support both legacy "RADIO_ON" and new "Result : true" formats
                extraInfo.radioOn = out.includes('RADIO_ON') || /Result\s*:\s*true/i.test(out);
            }

            // Parse Software Version
            // The command is simple cat, so stdout is the value
            if (ver && ver.stdout) {
                extraInfo.swVersion = ver.stdout.trim();
            } else {
                extraInfo.swVersion = 'Unknown';
            }
        } catch (e) {
            console.error('[STATUS] Details fetch error:', e.message);
        }
    }

    res.json({
        connected: isConnected,
        deviceCount: readyDevices.length,
        extraInfo,
        adbUsed: activeTarget ? `${binary} -s ${activeTarget}` : binary,
        debug: { serialStored: savedSerial, idsFound: devices.map(d => d.id) }
    });
});

app.get('/api/config', (req, res) => {
    const id = getClientId(req);
    const userConfig = userConfigs.get(id);
    const clientIp = getClientIp(req);
    const localIps = getLocalIps();
    let displayIp = localIps.includes(clientIp) ? getPrimaryIp() : clientIp;

    res.json({
        ...config,
        adbCommand: userConfig?.adbCommand || config.adbCommand,
        serial: userConfig?.serial || '',
        clientIp: displayIp
    });
});

app.post('/api/config', (req, res) => {
    const id = getClientId(req);
    const { adbCommand, serial } = req.body;
    const current = userConfigs.get(id) || { adbCommand: config.adbCommand, serial: '' };
    const next = {
        adbCommand: adbCommand || current.adbCommand,
        serial: serial !== undefined ? serial : current.serial
    };
    userConfigs.set(id, next);
    res.json({ success: true, config: next });
});

app.get('/api/commands', (req, res) => {
    res.json({ commands: readJson(COMMANDS_FILE), categories: readJson(CATEGORIES_FILE) });
});

// Validate if a specific device is still connected
app.get('/api/validate-device', async (req, res) => {
    const serial = req.query.serial;
    const binary = getAdbBinary(req);

    if (!serial) {
        return res.json({ valid: false, error: 'No serial provided' });
    }

    const devices = await getCachedDevices(binary);
    const match = devices.find(d => d.id.toLowerCase() === serial.toLowerCase() && d.status.toLowerCase() === 'device');

    res.json({
        valid: !!match,
        serial,
        availableDevices: devices.filter(d => d.status.toLowerCase() === 'device').map(d => d.id)
    });
});

// Update standard response to include device name for clarity
app.post('/api/execute', async (req, res) => {
    const { command, targetSerial } = req.body;
    if (!command) return res.status(400).json({ success: false, error: 'No command' });

    const id = getClientId(req);
    const binary = getAdbBinary(req);

    // Use cached devices for speed, but always validate target
    const devices = await getCachedDevices(binary);
    const userConfig = userConfigs.get(id);

    // Priority: Use explicitly passed targetSerial, then saved serial
    const requestedSerial = (targetSerial || userConfig?.serial || '').trim().toLowerCase();
    const readyDevices = devices.filter(d => d.status.toLowerCase() === 'device');

    let targetDevice = null;

    // STRICT TARGETING: Only use the selected device, NO FALLBACK
    if (requestedSerial) {
        targetDevice = devices.find(d => d.id.toLowerCase() === requestedSerial && d.status.toLowerCase() === 'device');

        if (!targetDevice) {
            // Selected device is NOT connected - return specific error for popup
            return res.json({
                success: false,
                output: `Device '${requestedSerial}' not connected`,
                error: 'DEVICE_DISCONNECTED',
                disconnectedSerial: requestedSerial,
                availableDevices: readyDevices.map(d => d.id)
            });
        }
    } else if (readyDevices.length === 0) {
        return res.json({ success: false, output: 'No device connected', error: 'NO_DEVICE' });
    } else if (readyDevices.length === 1) {
        // No device selected but only one available - use it
        targetDevice = readyDevices[0];
    } else {
        // Multiple devices but none selected
        return res.json({
            success: false,
            output: 'Multiple devices connected. Please select a device.',
            error: 'MULTIPLE_DEVICES',
            availableDevices: readyDevices.map(d => d.id)
        });
    }

    const adbBase = `${binary} -s ${targetDevice.id}`;
    let sanitized = command.trim().replace(/^(adb1?(\.exe)?\s+)/i, '');
    const full = `${adbBase} ${sanitized}`;

    console.log(`[EXEC] ${full}`);
    const result = await execAsync(full);

    // Add device serial to output for visual confirmation in UI
    let output = result.stdout || result.stderr || (result.success ? 'Success' : 'Failed');
    if (requestedSerial || targetDevice) {
        const serial = targetDevice.id;
        output = `[${serial}] ${output}`;
    }

    res.json({
        success: result.success,
        output: output,
        error: result.stderr,
        targetUsed: targetDevice.id
    });
});

// Set Region - Used by Region MGR module
app.post('/api/set-region', async (req, res) => {
    const { regionNumber } = req.body;
    if (!regionNumber) return res.status(400).json({ success: false, error: 'No region number provided' });

    const id = getClientId(req);
    const binary = getAdbBinary(req);
    const userConfig = userConfigs.get(id);
    let target = '';
    if (userConfig && userConfig.serial) target = `-s ${userConfig.serial}`;

    const command = `${binary} ${target} shell sldd region sethalsystemnation ${regionNumber}`;
    console.log(`[SET REGION] ${command}`);
    const result = await execAsync(command);

    res.json({
        success: result.success,
        output: result.stdout || result.stderr || (result.success ? `Region set to ${regionNumber}` : 'Failed'),
        error: result.stderr
    });
});

app.post('/api/adb-root', async (req, res) => {
    const binary = getAdbBinary(req);
    // Directly use the target resolve logic to ensure correct device
    const id = getClientId(req);
    const userConfig = userConfigs.get(id);
    let target = '';
    if (userConfig && userConfig.serial) target = `-s ${userConfig.serial}`;
    const result = await execAsync(`${binary} ${target} root`);
    res.json(result);
});

app.post('/api/reboot', async (req, res) => {
    const binary = getAdbBinary(req);
    const id = getClientId(req);
    const userConfig = userConfigs.get(id);
    let target = '';
    if (userConfig && userConfig.serial) target = `-s ${userConfig.serial}`;
    const result = await execAsync(`${binary} ${target} reboot`);
    res.json(result);
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (ADMIN_USERS[username] === password) {
        const token = Math.random().toString(36).substr(2) + Date.now().toString(36);
        adminTokens.add(token);
        res.json({ success: true, token, username });
    } else {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
});

app.get('/api/ping', (req, res) => res.json({ pong: true, time: Date.now() }));

// --- ADMIN MANAGEMENT ROUTES ---

// Manage Models
app.post('/api/models', adminAuth, (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ success: false, error: 'Missing id or name' });

    const commands = readJson(COMMANDS_FILE);
    if (commands[id]) return res.status(400).json({ success: false, error: 'Model already exists' });

    // Create new model with default categories
    commands[id] = {
        name,
        variant: "",
        categories: ["sim", "network", "call", "sms", "ecall", "data", "region"],
        commands: []
    };
    writeJson(COMMANDS_FILE, commands);
    res.json({ success: true });
});

app.put('/api/models/:id', adminAuth, (req, res) => {
    const { name } = req.body;
    const { id } = req.params;
    const commands = readJson(COMMANDS_FILE);
    if (!commands[id]) return res.status(404).json({ success: false, error: 'Model not found' });

    commands[id].name = name;
    writeJson(COMMANDS_FILE, commands);
    res.json({ success: true });
});

app.delete('/api/models/:id', adminAuth, (req, res) => {
    const { id } = req.params;
    const commands = readJson(COMMANDS_FILE);
    if (!commands[id]) return res.status(404).json({ success: false, error: 'Model not found' });

    delete commands[id];
    writeJson(COMMANDS_FILE, commands);
    res.json({ success: true });
});

// Manage Commands
app.post('/api/commands', adminAuth, (req, res) => {
    const { modelId, name, command, category, expected, excludeFromRunAll } = req.body;
    const commands = readJson(COMMANDS_FILE);
    if (!commands[modelId]) return res.status(404).json({ success: false, error: 'Model not found' });

    const newCmd = {
        id: name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now(),
        name,
        command,
        category,
        expected: expected || "",
        excludeFromRunAll: excludeFromRunAll || false
    };

    commands[modelId].commands.push(newCmd);
    writeJson(COMMANDS_FILE, commands);
    res.json({ success: true, command: newCmd });
});

app.put('/api/commands/:modelId/:cmdId', adminAuth, (req, res) => {
    const { modelId, cmdId } = req.params;
    const { name, command, category, expected, excludeFromRunAll } = req.body;

    const commands = readJson(COMMANDS_FILE);
    if (!commands[modelId]) return res.status(404).json({ success: false, error: 'Model not found' });

    const cmdIndex = commands[modelId].commands.findIndex(c => c.id === cmdId);
    if (cmdIndex === -1) return res.status(404).json({ success: false, error: 'Command not found' });

    commands[modelId].commands[cmdIndex] = {
        ...commands[modelId].commands[cmdIndex],
        name: name || commands[modelId].commands[cmdIndex].name,
        command: command || commands[modelId].commands[cmdIndex].command,
        category: category || commands[modelId].commands[cmdIndex].category,
        expected: expected !== undefined ? expected : commands[modelId].commands[cmdIndex].expected,
        excludeFromRunAll: excludeFromRunAll !== undefined ? excludeFromRunAll : commands[modelId].commands[cmdIndex].excludeFromRunAll
    };

    writeJson(COMMANDS_FILE, commands);
    res.json({ success: true });
});

app.delete('/api/commands/:modelId/:cmdId', adminAuth, (req, res) => {
    const { modelId, cmdId } = req.params;
    const commands = readJson(COMMANDS_FILE);
    if (!commands[modelId]) return res.status(404).json({ success: false, error: 'Model not found' });

    commands[modelId].commands = commands[modelId].commands.filter(c => c.id !== cmdId);
    writeJson(COMMANDS_FILE, commands);
    res.json({ success: true });
});

// Manage Categories
app.post('/api/models/:modelId/categories', adminAuth, (req, res) => {
    const { modelId } = req.params;
    const { categoryId, label, color } = req.body;

    if (!categoryId || !label) return res.status(400).json({ success: false, error: 'Missing ID or Label' });

    const commandsData = readJson(COMMANDS_FILE);
    const categoriesData = readJson(CATEGORIES_FILE);

    if (!commandsData[modelId]) return res.status(404).json({ success: false, error: 'Model not found' });

    // Add to global categories if it doesn't exist
    if (!categoriesData[categoryId]) {
        categoriesData[categoryId] = { label, color: color || "#666" };
        writeJson(CATEGORIES_FILE, categoriesData);
    }

    // Add to model's categories if not already there
    if (!commandsData[modelId].categories.includes(categoryId)) {
        commandsData[modelId].categories.push(categoryId);
        writeJson(COMMANDS_FILE, commandsData);
    }

    res.json({ success: true });
});

app.get('/api/categories', (req, res) => {
    res.json(readJson(CATEGORIES_FILE));
});

app.post('/api/tools/launch-dlt', async (req, res) => {
    const { adbCommand, dltPort } = req.body;
    const binary = adbCommand || getAdbBinary(req);
    const port = dltPort || 3490;

    const id = getClientId(req);
    const userConfig = userConfigs.get(id);
    let target = '';
    if (userConfig && userConfig.serial) target = `-s ${userConfig.serial}`;

    try {
        const publicPort = parseInt(port);
        const internalPort = publicPort + 1000; // Unique offset per port

        // 1. Setup Internal Port Forwarding (Unique to this port)
        console.log(`[DLT] Forwarding ${target || 'default'} to localhost:${internalPort}`);

        // Remove existing forward for this specific internal port to avoid conflicts
        await execAsync(`${binary} ${target} forward --remove tcp:${internalPort}`).catch(() => { });

        // Forward public internal port to device's DLT port (3490)
        // CRITICAL: Must use target serial if multiple devices are connected
        const adbRes = await execAsync(`${binary} ${target} forward tcp:${internalPort} tcp:3490`, 5000);

        if (!adbRes.success) {
            console.error(`[DLT] ADB Forward Error:`, adbRes.stderr);
        }

        // 2. Setup/Ensure Bridge is running
        setupDltProxy(publicPort, internalPort);

        res.json({
            success: true,
            message: `DLT Bridge active on port ${publicPort}.`
        });
    } catch (error) {
        console.error(`[DLT] System Error:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Telephony Manager LIVE on port ${PORT}`);
    console.log(`📡 Access locally: http://localhost:${PORT}`);
    console.log(`📡 Access network: http://${os.hostname()}:${PORT}\n`);
});
