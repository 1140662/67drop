const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 建立必要資料夾
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('data')) fs.mkdirSync('data');

const DEVICES_FILE = path.join(__dirname, 'data', 'devices.json');
const FILES_FILE = path.join(__dirname, 'data', 'files.json');

// 讀取資料
function loadDevices() {
  if (!fs.existsSync(DEVICES_FILE)) return [];
  return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
}

function saveDevices(devices) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
}

function loadFiles() {
  if (!fs.existsSync(FILES_FILE)) return [];
  return JSON.parse(fs.readFileSync(FILES_FILE, 'utf8'));
}

function saveFiles(files) {
  fs.writeFileSync(FILES_FILE, JSON.stringify(files, null, 2));
}

// 檔案上傳設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// 目前在線設備
const onlineDevices = new Map();

// ========== API ==========

// 註冊 / 更新設備
app.post('/api/device', (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: '缺少參數' });

  let devices = loadDevices();
  const now = Date.now();
  const index = devices.findIndex(d => d.id === id);

  if (index >= 0) {
    devices[index].name = name;
    devices[index].last_seen = now;
  } else {
    devices.push({ id, name, last_seen: now, created_at: now });
  }

  saveDevices(devices);
  res.json({ success: true });
});

// 取得所有設備
app.get('/api/devices', (req, res) => {
  const devices = loadDevices().map(d => ({
    ...d,
    online: onlineDevices.has(d.id)
  }));
  res.json(devices);
});

// 上傳檔案
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '沒有檔案' });

  const { fromDeviceId, toDeviceId } = req.body;
  if (!fromDeviceId || !toDeviceId) {
    return res.status(400).json({ error: '缺少設備資訊' });
  }

  const fileId = uuidv4();
  const now = Date.now();

  const files = loadFiles();
  files.push({
    id: fileId,
    from_device_id: fromDeviceId,
    to_device_id: toDeviceId,
    original_name: req.file.originalname,
    stored_name: req.file.filename,
    size: req.file.size,
    created_at: now,
    is_read: false
  });
  saveFiles(files);

  // 如果目標在線，即時通知
  const targetSocketId = onlineDevices.get(toDeviceId);
  if (targetSocketId) {
    io.to(targetSocketId).emit('new-file', {
      id: fileId,
      fromDeviceId,
      originalName: req.file.originalname,
      size: req.file.size,
      createdAt: now
    });
  }

  res.json({
    success: true,
    fileId,
    message: targetSocketId ? '已即時傳送' : '已存入對方收件夾'
  });
});

// 取得收件夾
app.get('/api/inbox/:deviceId', (req, res) => {
  const files = loadFiles()
    .filter(f => f.to_device_id === req.params.deviceId)
    .sort((a, b) => b.created_at - a.created_at);

  const devices = loadDevices();
  const result = files.map(f => {
    const from = devices.find(d => d.id === f.from_device_id);
    return { ...f, from_name: from ? from.name : '未知設備' };
  });

  res.json(result);
});

// 下載檔案
app.get('/api/download/:fileId', (req, res) => {
  const files = loadFiles();
  const file = files.find(f => f.id === req.params.fileId);
  if (!file) return res.status(404).send('檔案不存在');

  const filePath = path.join(__dirname, 'uploads', file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('檔案遺失');

  // 標記已讀
  file.is_read = true;
  saveFiles(files);

  res.download(filePath, file.original_name);
});

// 刪除檔案
app.delete('/api/file/:fileId', (req, res) => {
  let files = loadFiles();
  const file = files.find(f => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: '不存在' });

  const filePath = path.join(__dirname, 'uploads', file.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  files = files.filter(f => f.id !== req.params.fileId);
  saveFiles(files);

  res.json({ success: true });
});

// ========== Socket.io ==========
io.on('connection', (socket) => {
  let currentDeviceId = null;

  socket.on('register', (deviceId) => {
    currentDeviceId = deviceId;
    onlineDevices.set(deviceId, socket.id);

    // 更新最後上線時間
    const devices = loadDevices();
    const device = devices.find(d => d.id === deviceId);
    if (device) {
      device.last_seen = Date.now();
      saveDevices(devices);
    }

    io.emit('devices-updated');
  });

  socket.on('disconnect', () => {
    if (currentDeviceId) {
      onlineDevices.delete(currentDeviceId);
      io.emit('devices-updated');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`67drop 已啟動：http://localhost:${PORT}`);
});