'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const loginView = $('login');
  const appView = $('app');
  const loginForm = $('login-form');
  const loginError = $('login-error');
  const passwordInput = $('password');
  const statusEl = $('status');
  const reconnectBtn = $('reconnect');
  const choiceSelect = $('choice');
  const CHOICE_KEY = 'cmdlan-startup-choice';

  let term = null;
  let fit = null;
  let socket = null;

  function setStatus(state, text) {
    statusEl.className = state;
    statusEl.textContent = text;
    reconnectBtn.hidden = state !== 'disconnected';
  }

  // Detach first so the socket's close handler knows this close was intentional.
  function dropSocket() {
    const ws = socket;
    socket = null;
    if (ws) ws.close();
  }

  function showLogin(message = '') {
    dropSocket();
    appView.hidden = true;
    loginView.hidden = false;
    loginError.textContent = message;
    passwordInput.value = '';
    passwordInput.focus();
  }

  function sendToServer(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function createTerminal() {
    term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: { background: '#0d1117', foreground: '#e6edf3' },
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('terminal'));

    // Let the browser handle Ctrl+V (paste) and Ctrl+C when text is selected (copy);
    // everything else, including Ctrl+C with no selection, goes to the shell.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey) return true;
      const key = event.key.toLowerCase();
      if (key === 'v') return false;
      if (key === 'c' && term.hasSelection()) return false;
      return true;
    });

    term.onData((data) => sendToServer({ type: 'input', data }));
    term.onResize(({ cols, rows }) => sendToServer({ type: 'resize', cols, rows }));
    new ResizeObserver(() => fit.fit()).observe($('terminal'));
  }

  function connect() {
    setStatus('', 'Connecting…');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const start = choiceSelect.value ? `?start=${encodeURIComponent(choiceSelect.value)}` : '';
    const ws = new WebSocket(`${scheme}://${location.host}/ws${start}`);
    socket = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      setStatus('connected', 'Connected');
      term.reset();
      fit.fit();
      sendToServer({ type: 'resize', cols: term.cols, rows: term.rows });
      term.focus();
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'output') term.write(message.data);
      else if (message.type === 'exit') term.write(`\r\n\x1b[90m[shell exited with code ${message.code}]\x1b[0m\r\n`);
    };

    ws.onclose = async () => {
      if (socket !== ws) return;
      socket = null;
      // A refused handshake usually means the session ended; check before offering a reconnect.
      const session = await fetch('/api/session').catch(() => null);
      if (session && session.status === 401) {
        showLogin(opened ? 'Your session ended. Sign in again.' : '');
        return;
      }
      setStatus('disconnected', session ? 'Disconnected' : 'Host unreachable');
    };
  }

  // Fills the "Run" picker with the host's startup choices; it stays hidden unless there is a choice to make.
  async function loadChoices() {
    let names = [];
    try {
      const response = await fetch('/api/options');
      if (response.ok) names = (await response.json()).startupChoices;
    } catch {
      // Without the list the server just uses its default.
    }
    choiceSelect.replaceChildren(...names.map((name) => new Option(name, name)));
    $('choice-label').hidden = names.length < 2;
    let remembered = null;
    try {
      remembered = localStorage.getItem(CHOICE_KEY);
    } catch {
      // Storage can be blocked; the default choice is fine.
    }
    if (names.includes(remembered)) choiceSelect.value = remembered;
  }

  async function showTerminal() {
    loginView.hidden = true;
    appView.hidden = false;
    $('host').textContent = location.hostname;
    if (!term) createTerminal();
    await loadChoices();
    connect();
  }

  choiceSelect.addEventListener('change', () => {
    try {
      localStorage.setItem(CHOICE_KEY, choiceSelect.value);
    } catch {
      // Not remembered, but still applied to this terminal.
    }
    dropSocket();
    connect();
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';
    let response;
    try {
      response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput.value }),
      });
    } catch {
      loginError.textContent = 'Could not reach the host.';
      return;
    }
    if (response.ok) {
      showTerminal();
      return;
    }
    const body = await response.json().catch(() => ({}));
    loginError.textContent = body.error || `Sign-in failed (${response.status}).`;
    passwordInput.select();
  });

  reconnectBtn.addEventListener('click', connect);

  $('logout').addEventListener('click', async () => {
    dropSocket();
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  fetch('/api/session')
    .then((response) => (response.ok ? showTerminal() : showLogin()))
    .catch(() => showLogin('Could not reach the host.'));
})();
