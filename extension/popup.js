document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-connect').addEventListener('click', connectNow);
  document.getElementById('open-dashboard').addEventListener('click', openDashboard);
  document.getElementById('btn-disconnect').addEventListener('click', disconnect);

  const stored = await chrome.storage.local.get(['serverUrl', 'connectedAs']);
  if (stored.serverUrl) document.getElementById('server-url').value = stored.serverUrl;
  if (stored.connectedAs) setStatus('on', `Connected: @${stored.connectedAs}`);

  // Auto-detect username from Depop tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('depop.com')) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const links = [...document.querySelectorAll('a[href]')];
          for (const a of links) {
            const m = a.href.match(/depop\.com\/([a-zA-Z0-9_]{3,30})\/?$/);
            if (m && !['login','signup','explore','sell','products','messages'].includes(m[1])) return m[1];
          }
          return null;
        }
      });
      const username = results?.[0]?.result;
      if (username) document.getElementById('detected-username').value = username;
    }
  } catch {}
});

async function connectNow() {
  const serverUrl = document.getElementById('server-url').value.trim().replace(/\/$/, '');
  const username = document.getElementById('detected-username').value.trim().replace('@', '');
  if (!serverUrl) { setStatus('err', 'Enter server URL'); return; }
  if (!username) { setStatus('err', 'Enter your Depop username'); return; }

  setStatus('', 'Getting cookies...');
  document.getElementById('btn-connect').disabled = true;

  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ domain: '.depop.com' });
  } catch (e) { setStatus('err', 'Cookie error: ' + e.message); document.getElementById('btn-connect').disabled = false; return; }

  setStatus('', `Sending ${cookies.length} cookies...`);

  try {
    const res = await fetch(`${serverUrl}/api/save-cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': '1010' },
      body: JSON.stringify({
        username,
        cookies: cookies.map(c => ({
          name: c.name, value: c.value,
          domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
          path: c.path, secure: c.secure, httpOnly: c.httpOnly,
          sameSite: c.sameSite === 'unspecified' ? 'Lax' : c.sameSite
        }))
      })
    });
    if (!res.ok) throw new Error('Server error ' + res.status);
    const d = await res.json();
    await chrome.storage.local.set({ serverUrl, connectedAs: username, accountId: d.id });
    setStatus('on', `Connected: @${username}`);
    document.getElementById('btn-connect').textContent = 'Reconnect';
  } catch (err) {
    setStatus('err', err.message.includes('fetch') ? 'Cannot reach server' : err.message);
  }
  document.getElementById('btn-connect').disabled = false;
}

function setStatus(type, msg) {
  document.getElementById('status-dot').className = 'status-dot' + (type ? ' ' + type : '');
  document.getElementById('status-text').className = 'status-text' + (type ? ' ' + type : '');
  document.getElementById('status-text').textContent = msg;
}

function openDashboard() {
  const url = document.getElementById('server-url').value.trim() || 'http://localhost:3099';
  chrome.tabs.create({ url });
}

async function disconnect() {
  await chrome.storage.local.remove(['connectedAs', 'accountId']);
  setStatus('', 'Disconnected');
  document.getElementById('btn-connect').textContent = 'Connect Account';
}
