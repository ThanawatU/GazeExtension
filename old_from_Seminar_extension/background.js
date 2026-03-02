
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'highlight-selection',
    title: 'ไฮไลท์ข้อความที่เลือก',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'highlight-selection' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_SELECTION' });
  }
});
