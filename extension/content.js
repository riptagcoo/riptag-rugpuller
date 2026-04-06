(function(){
  const links = [...document.querySelectorAll('a[href]')];
  for (const a of links) {
    const m = a.href.match(/depop\.com\/([a-zA-Z0-9_]{3,30})\/?$/);
    if (m && !['login','signup','explore','sell','products','messages'].includes(m[1])) {
      chrome.runtime.sendMessage({ type: 'USERNAME_DETECTED', username: m[1] });
      break;
    }
  }
})();
