// payment-server/public/script.js
(async function() {
  const comment = location.pathname.slice(1);
  const amountDisplay = document.getElementById('amountDisplay');
  const qrSection     = document.getElementById('qrSection');
  const qrImage       = document.getElementById('qrImage');
  const statusP       = document.getElementById('status');
  const paymentSession= document.getElementById('paymentSession');
  const timerP        = document.getElementById('timer');
  const completeBtn   = document.getElementById('completeBtn');
  const cancelBtn     = document.getElementById('cancelBtn');
  const utrSection    = document.getElementById('utrSection');
  const utrInput      = document.getElementById('utrInput');
  const submitUtrBtn  = document.getElementById('submitUtrBtn');
  const utrResult     = document.getElementById('utrResult');
  const loader        = document.getElementById('loader');
  const container     = document.querySelector('.container');

  const clientSocket = io('http://45.41.206.59:3000');

  let poller, timerInterval;
  let remainingSeconds = 300;
  let currentAmount = '';
  let intervalSec = 5;
  const STORAGE_KEY = `payment_start_${comment}`;

  function hide(el) { el.classList.add('hidden'); }
  function show(el) { el.classList.remove('hidden'); }

  function clearSessionStorage() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function saveStartTime() {
    if (!localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, Date.now().toString());
    }
  }

  function updateTimerDisplay() {
    const m = String(Math.floor(remainingSeconds/60)).padStart(2,'0');
    const s = String(remainingSeconds%60).padStart(2,'0');
    timerP.textContent = `${m}:${s}`;
  }

  function endSession(message) {
    hide(loader);
    hide(qrSection);
    hide(paymentSession);
    hide(statusP);
    hide(utrSection);
    statusP.textContent = message;
    show(statusP);
  }

  clientSocket.on('payment-failure', comm => {
    if (comm === comment) {
      clearInterval(poller);
      clearInterval(timerInterval);
      clearSessionStorage();
      endSession('❌ Payment cancelled by initiator');
    }
  });

  clientSocket.emit('join-session', comment);

  async function init() {
    // 1) fetch amount
    try {
      const resp1 = await fetch(`/session/${comment}`);
      if (!resp1.ok) {
        const text = await resp1.text();
        return endSession(`❌ Payment lookup error`);
      }
      const sess = await resp1.json();
      currentAmount = sess.amount;
      amountDisplay.textContent = `Amount: ₹${currentAmount}`;
    } catch (err) {
      return endSession(`❌ Payment lookup exception`);
    }

    // 2) show loader only
    show(loader);
    hide(qrSection);
    hide(statusP);
    hide(paymentSession);
    hide(utrSection);

    // 3) generate QR
    try {
      const genResp = await fetch(
        `/generate?comment=${encodeURIComponent(comment)}&amount=${encodeURIComponent(currentAmount)}`
      );
      const gen = await genResp.json();
      hide(loader);

      if (!genResp.ok) {
        return endSession(`❌ QR generation error`);
      }

      // display QR & UI
      qrImage.src = gen.qrDataUrl;
      intervalSec = gen.COMMENT_FETCH_PER_SECONDS;
      show(qrSection);
      statusP.textContent = 'Waiting for payment…';
      show(statusP);
      show(paymentSession);

      // timer setup
      saveStartTime();
      const saved = localStorage.getItem(STORAGE_KEY);
      const startTime = saved ? parseInt(saved,10) : Date.now();
      if (!saved) localStorage.setItem(STORAGE_KEY, startTime.toString());
      const elapsed = Math.floor((Date.now() - startTime)/1000);
      remainingSeconds = 300 - elapsed;
      if (remainingSeconds <= 0) {
        clientSocket.emit('payment-failure', comment);
        clearSessionStorage();
        return endSession('❌ Payment session end');
      }
      updateTimerDisplay();
      timerInterval = setInterval(() => {
        remainingSeconds--;
        if (remainingSeconds <= 0) {
          clientSocket.emit('payment-failure', comment);
          clearInterval(timerInterval);
          clearInterval(poller);
          clearSessionStorage();
          endSession('❌ Payment session end');
        } else {
          updateTimerDisplay();
        }
      }, 1000);

      // polling logic with immediate first check
      async function doCheck() {
        const chkResp = await fetch(
          `/check?comment=${encodeURIComponent(comment)}&amount=${encodeURIComponent(currentAmount)}`
        );
        const chk = await chkResp.json();
        if (chk.success) {
          clientSocket.emit('payment-success', comment);
          clearInterval(poller);
          clearInterval(timerInterval);
          clearSessionStorage();
          endSession(`✅ Payment successful of ₹${chk.received}`);
          generateInvoice(chk.meta, chk.txnDetails);
        }
      }
      // immediate check
      await doCheck();
      // then interval checks
      poller = setInterval(doCheck, intervalSec * 1000);

    } catch (err) {
      hide(loader);
      return endSession(`❌ QR generation exception`);
    }
  }

  completeBtn.onclick = () => {
    clearInterval(poller);
    clearInterval(timerInterval);
    hide(qrSection);
    hide(paymentSession);
    show(utrSection);
  };

  cancelBtn.onclick = () => {
    clientSocket.emit('payment-failure', comment);
    clearInterval(poller);
    clearInterval(timerInterval);
    clearSessionStorage();
    endSession('❌ Session cancelled');
  };

  submitUtrBtn.onclick = async () => {
    const utr = utrInput.value.trim();
    if (!utr) return alert('Please enter UTR');
    submitUtrBtn.disabled = true;
    utrResult.textContent = 'Verifying…';
    show(utrResult);
    try {
      const verifyResp = await fetch(
        `/verify?utr=${encodeURIComponent(utr)}&comment=${encodeURIComponent(comment)}&amount=${encodeURIComponent(currentAmount)}`
      );
      const data = await verifyResp.json();
      if (verifyResp.ok && data.success) {
        clientSocket.emit('payment-success', comment);
        clearSessionStorage();
        endSession(`✅ Payment successful of ₹${data.received}`);
        generateInvoice(data.meta, data.txnDetails, utr);
      } else {
        clientSocket.emit('payment-failure', comment);
        clearSessionStorage();
        endSession(`❌ ${data.message || 'Verification failed'}`);
      }
    } catch (err) {
      clientSocket.emit('payment-failure', comment);
      clearSessionStorage();
      endSession(`❌ Verification exception`);
    } finally {
      submitUtrBtn.disabled = false;
    }
  };

  // invoice generator unchanged
  function generateInvoice(meta, txnDetails, utrOverride) {
    const headerText = txnDetails.header || '';
    const payerName = headerText.replace(/^Received from\s*/i, '').toUpperCase();
    const upiId = txnDetails.subtitle || meta['UPI ID'] || meta['Comments'] || '';
    const amount = txnDetails.amount;
    const utrNumber = utrOverride || meta['UPI Transaction ID'] || '';
    const ts = txnDetails.timestamp;
    const dateObj = new Date(ts);
    const istDate = dateObj.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'long', year: 'numeric'
    });
    const timeStr = dateObj.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', hour12: true
    }) + ' IN IST';
    const purpose = meta['Comments'] || 'N/A';

    const lines = [
      '           MAGICAL DEVELOPERS                  ',
      '<------------------------------------------------->',
      '             PAYMENT INVOICE                     ',
      '                                               ',
      ` PAYER NAME               ${payerName}`,
      ` PAYMENT METHOD           AUTO UPI`,
      ` UPI ID                   ${upiId}`,
      ` AMOUNT                   ${amount} INR`,
      ` ORDER ID                 ${utrNumber}`,
      ` DATE                     ${istDate}`,
      ` TIME                     ${timeStr}`,
      '<------------------------------------------------->',
      '                THANK YOU                      ',
      '<------------------------------------------------->'
    ];
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `INVOICE-${utrNumber}.txt`;
    link.textContent = 'Download Invoice';
    link.style.display = 'block';
    link.style.marginTop = '1rem';
    container.appendChild(link);
  }

  init();
})();
