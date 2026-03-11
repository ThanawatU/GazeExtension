// background.js — GazeLink Service Worker
// Content script connects to WebSocket directly.
// Background only handles: settings storage, popup↔content relay, calibration trigger.

// ── Settings defaults ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['gazeSettings'], (result) => {
        if (!result.gazeSettings) {
            chrome.storage.local.set({
                gazeSettings: {
                    enabled: false,
                    dwellTime: 800,
                    zoomScale: 1.8,
                    doZoom: true,
                    doGlow: true,
                    doTooltip: true,
                    doOpenOnDwell: false,
                    glowColor: '#a855f7',
                    showGazeDot: true,
                }
            });
        }
    });
});

// ── Messages from popup ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === 'START_TRACKING') {
        chrome.storage.local.get(['gazeSettings'], (result) => {
            const settings = { ...(result.gazeSettings || {}), enabled: true };
            chrome.storage.local.set({ gazeSettings: settings });
            sendToActiveTab({ type: 'SETTINGS_UPDATE', settings });
        });
        sendResponse({ ok: true });
        return false;
    }

    if (msg.type === 'STOP_TRACKING') {
        chrome.storage.local.get(['gazeSettings'], (result) => {
            const settings = { ...(result.gazeSettings || {}), enabled: false };
            chrome.storage.local.set({ gazeSettings: settings });
            sendToActiveTab({ type: 'STOP_TRACKING' });
        });
        sendResponse({ ok: true });
        return false;
    }

    if (msg.type === 'SETTINGS_UPDATE') {
        chrome.storage.local.set({ gazeSettings: msg.settings });
        sendToActiveTab({ type: 'SETTINGS_UPDATE', settings: msg.settings });
        return false;
    }

    if (msg.type === 'CALIBRATE') {
        sendToActiveTab({ type: 'CALIBRATE' });
        return false;
    }

    // Status ping from content script — forward to popup
    if (msg.type === 'WS_STATUS') {
        chrome.runtime.sendMessage({ type: 'WS_STATUS', status: msg.status }).catch(() => {});
        return false;
    }

    // Popup asking for current WS status — query active tab's content script
    if (msg.type === 'GET_WS_STATUS') {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab?.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
                sendResponse({ connected: false });
                return;
            }
            chrome.tabs.sendMessage(tab.id, { type: 'GET_WS_STATUS' }, (resp) => {
                sendResponse({ connected: resp?.connected ?? false });
            });
        });
        return true; // async response
    }
});

// ── Clear drowsy state when Chrome closes ─────────────────────────────────────

// Fires when the service worker is about to be shut down (browser closing, extension reload)
chrome.runtime.onSuspend.addListener(() => {
    chrome.storage.local.remove('gazelink_drowsy');
});

// Also fires when the last Chrome window closes (covers normal browser quit)
chrome.windows.onRemoved.addListener(() => {
    chrome.windows.getAll((windows) => {
        if (windows.length === 0) {
            chrome.storage.local.remove('gazelink_drowsy');
        }
    });
});

// ── Send to active tab only ───────────────────────────────────────────────────

function sendToActiveTab(message) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab?.id || !tab.url ||
            tab.url.startsWith('chrome://') ||
            tab.url.startsWith('chrome-extension://')) return;
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
}