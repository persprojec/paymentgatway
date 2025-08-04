const socket       = io('http://45.41.206.59:3000');
const amountInput  = document.getElementById('amountInput');
const payBtn       = document.getElementById('payBtn');
const cancelBtn    = document.getElementById('cancelBtn');
const statusP      = document.getElementById('status');
const timerSection = document.getElementById('timerSection');
const timerValue   = document.getElementById('timer');
const actionGroup  = document.getElementById('actionButtons');

let currentComment = null;
let countdownInt   = null;

const DURATION_SEC = 300;
const STORAGE_KEY  = 'payment_session_comment';
const START_KEY    = 'payment_session_start';

function hide(el) { el.classList.add('hidden'); }
function show(el) { el.classList.remove('hidden'); }

function updateTimer(sec) {
  const m = String(Math.floor(sec/60)).padStart(2,'0');
  const s = String(sec%60).padStart(2,'0');
  timerValue.textContent = `${m}:${s}`;
}

function clearSession() {
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(START_KEY);
  if (countdownInt) clearInterval(countdownInt);
}

function saveSession(comment) {
  sessionStorage.setItem(STORAGE_KEY, comment);
  sessionStorage.setItem(START_KEY, Date.now());
}

function resumeOrStartCountdown() {
  const storedComment = sessionStorage.getItem(STORAGE_KEY);
  const startTime     = parseInt(sessionStorage.getItem(START_KEY),10);
  if (!storedComment || !startTime) return false;

  const elapsed = Math.floor((Date.now() - startTime)/1000);
  if (elapsed >= DURATION_SEC) {
    socket.emit('payment-failure', storedComment);
    endSession('❌ Payment session ended');
    clearSession();
    return true;
  }
  currentComment = storedComment;
  socket.emit('join-session', currentComment);

  show(statusP);
  statusP.textContent = 'Waiting for payment…';
  show(timerSection);
  show(actionGroup);

  let remaining = DURATION_SEC - elapsed;
  updateTimer(remaining);
  countdownInt = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownInt);
      socket.emit('payment-failure', currentComment);
      endSession('❌ Payment session ended');
      clearSession();
    } else {
      updateTimer(remaining);
    }
  }, 1000);

  payBtn.disabled      = true;
  amountInput.disabled = true;
  return true;
}

function endSession(message) {
  hide(timerSection);
  hide(actionGroup);
  payBtn.disabled      = false;
  amountInput.disabled = false;
  statusP.textContent  = message;
  show(statusP);
}

window.addEventListener('DOMContentLoaded', () => {
  socket.on('connect', () => {
    console.log('Connected to server:', socket.id);
  });
  socket.on('payment-error', error => {
    statusP.textContent = error;
    show(statusP);
    payBtn.disabled      = false;
    amountInput.disabled = false;
  });

  if (resumeOrStartCountdown()) return;
  hide(timerSection);
  hide(actionGroup);
  hide(statusP);
});

payBtn.addEventListener('click', () => {
  const amt = amountInput.value.trim();
  if (!amt || isNaN(amt) || Number(amt) <= 0) {
    statusP.textContent = 'Please enter a valid amount';
    show(statusP);
    return;
  }
  payBtn.disabled      = true;
  amountInput.disabled = true;
  statusP.textContent  = 'Generating payment link…';
  show(statusP);
  socket.emit('payment', amt);
});

socket.on('payment-comment', comment => {
  currentComment = comment;
  socket.emit('join-session', comment);
  saveSession(comment);
  window.open(`http://45.41.206.59:3001/${comment}`, '_blank');

  statusP.textContent = 'Waiting for payment…';
  show(statusP);
  show(timerSection);
  show(actionGroup);

  updateTimer(DURATION_SEC);
  let remaining = DURATION_SEC;
  countdownInt = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownInt);
      socket.emit('payment-failure', currentComment);
      endSession('❌ Payment session ended');
      clearSession();
    } else {
      updateTimer(remaining);
    }
  }, 1000);
});

socket.on('payment-success', comment => {
  if (comment === currentComment) {
    clearSession();
    endSession(`✅ Payment successful`);
  }
});

socket.on('payment-failure', comment => {
  if (comment === currentComment) {
    clearSession();
    endSession(`❌ Payment failed`);
  }
});

cancelBtn.addEventListener('click', () => {
  if (!currentComment) return;
  socket.emit('payment-failure', currentComment);
  clearSession();
  endSession('❌ Payment cancelled by user');
});
