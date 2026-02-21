const path = require('path');
const express = require('express');
const http = require('http');
const cors = require("cors");
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const MAX_PARTICIPANTS = 4;
const ALLOWED_USERNAMES = new Set(['shradha', 'chaitanya', 'shradha2424', 'chaittnya1414']);

const allowed = ["http://127.0.0.1:8081", "http://127.0.0.1:5500", "http://127.0.0.1:5501", "http://127.0.0.1:8082"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes(origin)) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  }
}));

const io = new Server(server);

/** @type {Map<string, {id: string, username: string}>} */
const usersById = new Map();

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.on('join-room', ({ username }) => {
    const normalized = String(username || '').trim().toLowerCase();

    if (!ALLOWED_USERNAMES.has(normalized)) {
      socket.emit('join-error', {
        message: 'Username is not allowed for this watch party link.',
      });
      return;
    }

    if ([...usersById.values()].some((u) => u.username === normalized)) {
      socket.emit('join-error', {
        message: 'That username is already in use.',
      });
      return;
    }

    if (usersById.size >= MAX_PARTICIPANTS) {
      socket.emit('join-error', {
        message: `Room is full (max ${MAX_PARTICIPANTS} people).`,
      });
      return;
    }

    usersById.set(socket.id, { id: socket.id, username: normalized });

    const participants = [...usersById.values()].map(({ id, username: name }) => ({
      id,
      username: name,
    }));

    socket.emit('joined-room', {
      selfId: socket.id,
      participants,
      limits: {
        maxParticipants: MAX_PARTICIPANTS,
      },
    });

    socket.broadcast.emit('participant-joined', {
      id: socket.id,
      username: normalized,
    });
  });

  socket.on('signal', ({ to, data }) => {
    if (!usersById.has(socket.id) || !usersById.has(to)) {
      return;
    }

    io.to(to).emit('signal', {
      from: socket.id,
      data,
    });
  });

  socket.on('chat-message', ({ text }) => {
    const sender = usersById.get(socket.id);
    if (!sender) {
      return;
    }

    io.emit('chat-message', {
      from: sender.username,
      senderId: socket.id,
      text: String(text || '').slice(0, 800),
      at: Date.now(),
    });
  });

  socket.on('sync-event', (payload) => {
    if (!usersById.has(socket.id)) {
      return;
    }

    socket.broadcast.emit('sync-event', {
      ...payload,
      from: socket.id,
      at: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const leaving = usersById.get(socket.id);
    if (!leaving) {
      return;
    }

    usersById.delete(socket.id);
    socket.broadcast.emit('participant-left', {
      id: socket.id,
      username: leaving.username,
    });
  });
});

server.listen(PORT, () => {
  console.log(`StrApp running on http://localhost:${PORT}`);
});
