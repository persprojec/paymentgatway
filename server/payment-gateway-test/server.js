// client/client-server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory map of comment → amount
const sessionMap = {};

function generateComment() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let comment = '';
  for (let i = 0; i < 10; i++) {
    comment += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return comment;
}

// ** NEW: HTTP endpoint for payment lookup **
app.get('/amount/:comment', (req, res) => {
  const comment = req.params.comment;
  const amount = sessionMap[comment];
  if (amount !== undefined) {
    res.json({ amount });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  socket.on('join-session', comment => {
    socket.join(comment);
  });

  socket.on('payment', amount => {
    console.log('Payment request received:', amount);
    if (!amount || isNaN(amount)) {
      socket.emit('payment-error', `Invalid amount: ${amount}`);
      return;
    }
    const comment = generateComment();
    sessionMap[comment] = amount;
    socket.emit('payment-comment', comment);
  });

  socket.on('payment-success', comment => {
    io.to(comment).emit('payment-success', comment);
    delete sessionMap[comment];
  });

  socket.on('payment-failure', comment => {
    io.to(comment).emit('payment-failure', comment);
    delete sessionMap[comment];
  });

  socket.on('error', err => {
    console.error('Socket error:', err);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Client‐server listening on http://localhost:${PORT}`);
});
