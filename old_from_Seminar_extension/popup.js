async function sendMessage(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type });
}

document.getElementById('btn-enable').addEventListener('click', () => {
  sendMessage('ENABLE_GAZE');
});

document.getElementById('btn-disable').addEventListener('click', () => {
  sendMessage('DISABLE_GAZE');
});

document.getElementById('calibrateBtn').addEventListener('click', () => {
  sendMessage('CALIBRATE');
});
