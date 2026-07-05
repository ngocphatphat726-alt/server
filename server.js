const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const ADMIN_KEY = 'NPAIMLOCKLIVE';

app.use(cors());
app.use(express.json());

// ============================================
// DATABASE - Lưu file JSON
// ============================================
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

function readDB() {
    try {
        if (fs.existsSync(KEYS_FILE)) {
            return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
        }
    } catch (error) {}
    return { keys: {}, devices: {} };
}

function writeDB(data) {
    try {
        fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

// ============================================
// HÀM TẠO KEY
// ============================================
function generateKey(prefix, length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = prefix + '-';
    for (let i = 0; i < length; i++) {
        if (i > 0 && i % 4 === 0) result += '-';
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function getDurationInDays(type) {
    const map = { 'VIP': -1, '1M': 30, '3M': 90, '2M': 60, '1W': 7, '1D': 1, '11H': 0.458, '5H': 0.208, '2H': 0.083 };
    return map[type] || 0;
}

// ============================================
// API: Tạo key (Admin)
// ============================================
app.post('/api/keys/generate', (req, res) => {
    const { adminKey, type, count = 1, maxDevices = 1 } = req.body;

    if (adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'UNAUTHORIZED' });
    }

    const validTypes = ['VIP', '1M', '3M', '2M', '1W', '1D', '11H', '5H', '2H'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'INVALID_TYPE' });
    }

    const db = readDB();
    const duration = getDurationInDays(type);
    const generated = [];

    for (let i = 0; i < count; i++) {
        const key = generateKey(type, 8);
        db.keys[key] = {
            key: key,
            type: type,
            duration: duration,
            maxDevices: maxDevices,
            status: 'active',
            devices: [],
            createdAt: new Date().toISOString(),
            activatedAt: null,
            expires: duration === -1 ? null : new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString()
        };
        generated.push(key);
    }

    writeDB(db);
    res.json({ success: true, keys: generated, total: Object.keys(db.keys).length });
});

// ============================================
// API: Xác thực key (Client đăng nhập)
// ============================================
app.post('/api/keys/verify', (req, res) => {
    const { key, deviceId, deviceName } = req.body;

    if (!key || !deviceId) {
        return res.status(400).json({ error: 'MISSING_DATA' });
    }

    const db = readDB();
    const upperKey = key.toUpperCase();

    if (!db.keys[upperKey]) {
        return res.json({ valid: false, error: 'INVALID_KEY', message: 'Key không tồn tại!' });
    }

    const keyData = db.keys[upperKey];
    const now = new Date();

    // Kiểm tra key bị vô hiệu hóa
    if (keyData.status === 'disabled') {
        return res.json({ valid: false, error: 'KEY_DISABLED', message: 'Key đã bị vô hiệu hóa!' });
    }

    // Kiểm tra hết hạn
    if (keyData.duration !== -1 && keyData.expires) {
        if (new Date(keyData.expires) < now) {
            keyData.status = 'expired';
            writeDB(db);
            return res.json({ valid: false, error: 'KEY_EXPIRED', message: 'Key đã hết hạn!' });
        }
    }

    // Kiểm tra số thiết bị
    const isNewDevice = !keyData.devices.includes(deviceId);
    if (isNewDevice && keyData.devices.length >= keyData.maxDevices) {
        return res.json({
            valid: false,
            error: 'MAX_DEVICES',
            message: `Key đã đăng nhập trên ${keyData.maxDevices} thiết bị tối đa!`,
            maxDevices: keyData.maxDevices
        });
    }

    // Lần đầu kích hoạt
    if (!keyData.activatedAt) {
        keyData.activatedAt = now.toISOString();
    }

    // Thêm thiết bị mới
    if (isNewDevice) {
        keyData.devices.push(deviceId);
        if (!db.devices[deviceId]) {
            db.devices[deviceId] = {
                deviceId: deviceId,
                deviceName: deviceName || 'Unknown',
                keys: [],
                firstSeen: now.toISOString(),
                lastSeen: now.toISOString()
            };
        }
        if (!db.devices[deviceId].keys.includes(upperKey)) {
            db.devices[deviceId].keys.push(upperKey);
        }
        db.devices[deviceId].lastSeen = now.toISOString();
    }

    keyData.status = 'active';
    writeDB(db);

    res.json({
        valid: true,
        success: true,
        message: 'Đăng nhập thành công!',
        type: keyData.type,
        maxDevices: keyData.maxDevices,
        deviceCount: keyData.devices.length,
        expires: keyData.expires
    });
});

// ============================================
// API: Danh sách key (Admin)
// ============================================
app.get('/api/keys/list', (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'UNAUTHORIZED' });
    }
    const db = readDB();
    res.json({ total: Object.keys(db.keys).length, keys: Object.values(db.keys) });
});

// ============================================
// API: Thống kê (Admin)
// ============================================
app.get('/api/keys/stats', (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'UNAUTHORIZED' });
    }
    const db = readDB();
    const keys = Object.values(db.keys);
    const stats = {
        total: keys.length,
        byType: {},
        byStatus: { active: 0, expired: 0, disabled: 0 },
        totalDevices: Object.keys(db.devices).length
    };
    keys.forEach(k => {
        stats.byType[k.type] = (stats.byType[k.type] || 0) + 1;
        stats.byStatus[k.status] = (stats.byStatus[k.status] || 0) + 1;
    });
    res.json(stats);
});

// ============================================
// API: Vô hiệu hóa key (Admin)
// ============================================
app.post('/api/keys/disable', (req, res) => {
    const { adminKey, key } = req.body;
    if (adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'UNAUTHORIZED' });
    }
    const db = readDB();
    const upperKey = key.toUpperCase();
    if (!db.keys[upperKey]) {
        return res.status(404).json({ error: 'KEY_NOT_FOUND' });
    }
    db.keys[upperKey].status = 'disabled';
    writeDB(db);
    res.json({ success: true, message: `Key ${upperKey} đã bị vô hiệu hóa` });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
    console.log(`🚀 Key Server running on port ${port}`);
    console.log(`📊 Admin Key: ${ADMIN_KEY}`);
});
