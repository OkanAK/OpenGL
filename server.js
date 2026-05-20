// ── imports
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { WebSocketServer } = require('ws');

// ── config
const PORT    = 3000;
const COLS    = 25;
const ROWS    = 40;
const TICK_MS = 150;

// ── local ip
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();

// ── static file server
const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, urlPath);
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    if (ext === '.html') {
      data = data.replace(
        '<!-- WS_URL -->',
        `<meta name="ws-url" content="ws://${LOCAL_IP}:${PORT}" />`
      );
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ── room state
let room = {
  players:         [null, null],
  state:           null,
  tickInterval:    null,
  countdownHandle: null,
  restartVotes:    [false, false],
};

// ── helpers
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.players) {
    if (ws && ws.readyState === 1) ws.send(data);
  }
}

function sendTo(idx, msg) {
  send(room.players[idx], msg);
}

// ── snake factory
function makeSnake(idx) {
  const midRow = Math.floor(ROWS / 2);
  if (idx === 0) {
    return {
      body:    [{ x: 4, y: midRow }, { x: 3, y: midRow }, { x: 2, y: midRow }],
      dir:     { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      alive:   true,
      score:   0,
    };
  }
  return {
    body:    [{ x: COLS - 5, y: midRow }, { x: COLS - 4, y: midRow }, { x: COLS - 3, y: midRow }],
    dir:     { x: -1, y: 0 },
    nextDir: { x: -1, y: 0 },
    alive:   true,
    score:   0,
  };
}

function spawnFood(snakes) {
  const occupied = new Set();
  for (const s of snakes) for (const seg of s.body) occupied.add(`${seg.x},${seg.y}`);
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (occupied.has(`${pos.x},${pos.y}`));
  return pos;
}

function initGameState() {
  const snakes = [makeSnake(0), makeSnake(1)];
  return { snakes, food: spawnFood(snakes), cols: COLS, rows: ROWS, gameOver: false, winner: -1 };
}

function exportState(state) {
  return {
    snakes: state.snakes.map(s => ({ body: s.body, dir: s.dir, alive: s.alive, score: s.score })),
    food:     state.food,
    cols:     state.cols,
    rows:     state.rows,
    gameOver: state.gameOver,
    winner:   state.winner,
  };
}

// ── game loop
function gameTick() {
  const state = room.state;
  if (!state || state.gameOver) return;

  const snakes = state.snakes;

  for (const snake of snakes) {
    if (!snake.alive) continue;
    const nd = snake.nextDir;
    if (nd.x !== -snake.dir.x || nd.y !== -snake.dir.y) snake.dir = { ...nd };
    const head = snake.body[0];
    snake.body.unshift({ x: head.x + snake.dir.x, y: head.y + snake.dir.y });
    snake.body.pop();
  }

  for (const snake of snakes) {
    if (!snake.alive) continue;
    const h = snake.body[0];
    if (h.x < 0 || h.x >= COLS || h.y < 0 || h.y >= ROWS) snake.alive = false;
  }

  for (const snake of snakes) {
    if (!snake.alive) continue;
    const h = snake.body[0];
    for (let i = 1; i < snake.body.length; i++) {
      if (snake.body[i].x === h.x && snake.body[i].y === h.y) { snake.alive = false; break; }
    }
  }

  for (let i = 0; i < snakes.length; i++) {
    if (!snakes[i].alive) continue;
    const h = snakes[i].body[0];
    for (let j = 0; j < snakes.length; j++) {
      if (i === j) continue;
      for (let k = 0; k < snakes[j].body.length; k++) {
        if (snakes[j].body[k].x === h.x && snakes[j].body[k].y === h.y) {
          snakes[i].alive = false; break;
        }
      }
      if (!snakes[i].alive) break;
    }
  }

  if (snakes[0].alive && snakes[1].alive) {
    const h0 = snakes[0].body[0];
    const h1 = snakes[1].body[0];
    if (h0.x === h1.x && h0.y === h1.y) { snakes[0].alive = false; snakes[1].alive = false; }
  }

  for (const snake of snakes) {
    if (!snake.alive) continue;
    const h = snake.body[0];
    if (h.x === state.food.x && h.y === state.food.y) {
      snake.score += 1;
      snake.body.push({ ...snake.body[snake.body.length - 1] });
      state.food = spawnFood(snakes);
    }
  }

  const a0 = snakes[0].alive;
  const a1 = snakes[1].alive;
  if (!a0 || !a1) {
    state.gameOver = true;
    state.winner = (!a0 && !a1) ? -1 : a0 ? 0 : 1;
    stopGameLoop();
  }

  broadcast({ type: 'state', state: exportState(state) });
}

// ── lifecycle
function stopGameLoop() {
  if (room.tickInterval)    { clearInterval(room.tickInterval);   room.tickInterval    = null; }
  if (room.countdownHandle) { clearTimeout(room.countdownHandle); room.countdownHandle = null; }
}

function resetRoom() {
  stopGameLoop();
  room.state        = null;
  room.restartVotes = [false, false];
}

function startCountdown() {
  room.state = null;
  let n = 3;
  function step() {
    broadcast({ type: 'countdown', n });
    n--;
    if (n > 0) {
      room.countdownHandle = setTimeout(step, 1000);
    } else {
      room.countdownHandle = setTimeout(() => {
        room.countdownHandle = null;
        broadcast({ type: 'go' });
        room.state        = initGameState();
        room.restartVotes = [false, false];
        room.tickInterval = setInterval(gameTick, TICK_MS);
      }, 1000);
    }
  }
  step();
}

// ── websocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const idx = room.players[0] === null ? 0 : room.players[1] === null ? 1 : -1;

  if (idx === -1) {
    send(ws, { type: 'full' });
    ws.close();
    return;
  }

  room.players[idx] = ws;
  send(ws, { type: 'joined', idx, cols: COLS, rows: ROWS });

  const bothReady = room.players[0] !== null && room.players[1] !== null;
  if (!bothReady) {
    send(ws, { type: 'waiting' });
  } else {
    startCountdown();
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'dir') {
      if (room.state && room.state.snakes[idx] && room.state.snakes[idx].alive) {
        room.state.snakes[idx].nextDir = msg.dir;
      }
    }

    if (msg.type === 'restart') {
      room.restartVotes[idx] = true;
      if (room.restartVotes[0] && room.restartVotes[1]) {
        stopGameLoop();
        room.restartVotes = [false, false];
        startCountdown();
      } else {
        broadcast({ type: 'waitRestart' });
      }
    }
  });

  ws.on('close', () => {
    room.players[idx] = null;
    stopGameLoop();
    room.state        = null;
    room.restartVotes = [false, false];
    const other = room.players[1 - idx];
    if (other && other.readyState === 1) send(other, { type: 'left' });
  });
});

// ── start
server.listen(PORT, '0.0.0.0', () => {
  console.log(`http://${LOCAL_IP}:${PORT}`);
});
