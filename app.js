/**
 * CHITCHAT ADVANCED MESSAGING ENGINE (V6 — Production Hardened)
 * Firebase v10 Modular SDK
 *
 * FIXES vs V5:
 *  1. Stored listener callbacks so off() actually works (no more stacking).
 *  2. Debounced scrollToBottom to prevent 100 simultaneous smooth-scroll animations.
 *  3. Replaced querySelectorAll inside pruneMessages with a live childElementCount
 *     so DOM scanning is O(1) instead of O(n) per message.
 *  4. Added isSending guard in handleSend to block duplicate sends.
 *  5. Fixed template literal bug in enterRoom (was a plain string).
 *  6. Moved typing listener inside DOMContentLoaded to prevent stacking.
 *  7. Added message deduplication via a rendered-ID Set.
 *  8. Initial load messages use instant scroll (no smooth), only new messages
 *     use smooth scroll.
 *  9. pruneMessages is now O(1) check + deferred via requestAnimationFrame.
 * 10. Added connection-state monitoring with auto-reconnect banner.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getDatabase, ref, push, set, onChildAdded, onValue, off,
    query, limitToLast, serverTimestamp, get, remove, goOnline, goOffline
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import {
    getAuth, signInAnonymously, setPersistence, browserSessionPersistence, signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    getStorage, ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ==========================================
// 1. FIREBASE CONFIGURATION
// ==========================================
console.log("[ChitChat] Initializing Firebase App...");
const firebaseConfig = {
    apiKey: "AIzaSyCyFiPkMeAzMjz55fpe4d8Ju6kOXYo5PiY",
    authDomain: "chitt-chatt-v01.firebaseapp.com",
    projectId: "chitt-chatt-v01",
    storageBucket: "chitt-chatt-v01.firebasestorage.app",
    messagingSenderId: "337758963578",
    appId: "1:337758963578:web:104cd188afbc0d5eb0f8c3"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const storage = getStorage(app);
console.log("[ChitChat] Firebase Realtime Engine initialized.");

// ==========================================
// 2. STATE & SELECTORS
// ==========================================
let currentUser = { uid: null, name: "" };
let currentRoom = { id: null, name: "", code: "" };

/**
 * FIX #1: Store named callback references so off() can properly detach them.
 * Previously anonymous arrow functions were passed to onChildAdded/onValue,
 * making off(ref) a no-op — listeners stacked on every room entry.
 */
let listeners = {
    msgCallback: null,
    memberCallback: null,
    typingCallback: null,
    msgRef: null,
    memberRef: null,
    typingRef: null,
};

let isTyping = false;
let typingTimeout = null;
let isBotResponding = false;
let isSending = false; // FIX #5: Guard against double-sends

/** FIX #7: Track rendered message IDs to prevent duplicate DOM nodes. */
const renderedMsgIds = new Set();

/**
 * FIX #8: Track whether we are in the "initial batch load" phase.
 * Firebase fires onChildAdded for all existing messages synchronously.
 * During this phase we suppress smooth scrolling and only scroll once at the end.
 */
let isInitialLoad = true;
let scrollScheduled = false;

const dom = {
    loginOverlay: document.getElementById('loginOverlay'),
    dashboardOverlay: document.getElementById('dashboardOverlay'),
    appContainer: document.getElementById('appContainer'),
    usernameInput: document.getElementById('usernameInput'),
    enterBtn: document.getElementById('enterBtn'),
    welcomeName: document.getElementById('welcomeName'),
    newRoomName: document.getElementById('newRoomName'),
    newRoomPass: document.getElementById('newRoomPass'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    joinRoomCode: document.getElementById('joinRoomCode'),
    joinRoomPass: document.getElementById('joinRoomPass'),
    joinRoomBtn: document.getElementById('joinRoomBtn'),
    msgViewport: document.getElementById('msgViewport'),
    mainInput: document.getElementById('mainInput'),
    sendBtn: document.getElementById('sendBtn'),
    displayRoomName: document.getElementById('displayRoomName'),
    displayRoomCode: document.getElementById('displayRoomCode'),
    memberList: document.getElementById('memberList'),
    memberCount: document.getElementById('memberCount'),
    myUsername: document.getElementById('myUsername'),
    copyCodeBtn: document.getElementById('copyCodeBtn'),
    leaveRoomBtn: document.getElementById('leaveRoomBtn'),
    mobileMenuBtn: document.getElementById('mobileMenuBtn'),
    sidebar: document.getElementById('sidebar'),
    fileUpload: document.getElementById('fileUpload'),
    emojiBtn: document.getElementById('emojiBtn'),
    typingBar: document.getElementById('typingBar')
};

// ==========================================
// 3. INITIALIZATION & AUTH
// ==========================================
console.log("[ChitChat] Attaching Event Listeners...");

document.addEventListener('DOMContentLoaded', () => {
    console.log("[ChitChat] DOM Ready.");

    if (!dom.enterBtn || !dom.mainInput) {
        console.error("[ChitChat] Critical DOM mismatch! Missing enterBtn or mainInput.");
        return;
    }

    // 1. Enter Chat Button
    dom.enterBtn.addEventListener('click', async () => {
        const name = dom.usernameInput.value.trim();
        if (!name) return alert("Please enter your name");

        dom.enterBtn.disabled = true;
        dom.enterBtn.innerText = "Connecting...";

        try {
            await setPersistence(auth, browserSessionPersistence);
            await signOut(auth);
            const cred = await signInAnonymously(auth);
            console.log("[ChitChat] Signed in as:", cred.user.uid);

            currentUser = { uid: cred.user.uid, name };
            dom.myUsername.innerText = name;

            await set(ref(db, "users/" + currentUser.uid), {
                name, online: true, lastSeen: serverTimestamp()
            });

            dom.loginOverlay.classList.remove('active');
            dom.dashboardOverlay.classList.add('active');
            dom.welcomeName.innerText = `Hi, ${name}!`;
        } catch (err) {
            console.error("[ChitChat] Auth Fail:", err);
            alert("Firebase Auth Restricted! Ensure 'Anonymous' is enabled in your Firebase Console.");
            dom.enterBtn.disabled = false;
            dom.enterBtn.innerText = "Continue";
        }
    });

    // 2. Messaging
    dom.sendBtn?.addEventListener('click', handleSend);
    dom.mainInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) handleSend();
    });

    // FIX #6: Typing listener moved inside DOMContentLoaded so it's attached only once.
    dom.mainInput?.addEventListener('input', () => {
        if (!isTyping && currentRoom.id) {
            isTyping = true;
            setTypingStatus(true);
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            isTyping = false;
            setTypingStatus(false);
        }, 2000);
    });

    // 3. Room Logic
    dom.createRoomBtn?.addEventListener('click', handleCreateRoom);
    dom.joinRoomBtn?.addEventListener('click', handleJoinRoom);

    // 4. File Sharing
    dom.fileUpload?.addEventListener('change', handleFileUpload);

    // 5. Sidebar / Utility
    dom.leaveRoomBtn?.addEventListener('click', leaveRoom);
    dom.copyCodeBtn?.addEventListener('click', () => {
        navigator.clipboard.writeText(currentRoom.code)
            .then(() => showToast("Room Code Copied!"))
            .catch(() => alert("Room Code: " + currentRoom.code));
    });

    if (dom.mobileMenuBtn) {
        dom.mobileMenuBtn.onclick = () => dom.sidebar.classList.toggle('open');
    }

    // 6. Safe EmojiMart Load
    try {
        if (typeof EmojiMart !== 'undefined') {
            const picker = new EmojiMart.Picker({
                onEmojiSelect: (e) => { dom.mainInput.value += e.native; dom.mainInput.focus(); },
                theme: 'dark'
            });
            const pickerWrap = document.createElement('div');
            pickerWrap.style.cssText = "position:absolute;bottom:100px;left:40px;display:none;z-index:1000";
            pickerWrap.appendChild(picker);
            document.body.appendChild(pickerWrap);

            dom.emojiBtn.addEventListener('click', () => {
                pickerWrap.style.display = (pickerWrap.style.display === 'none' ? 'block' : 'none');
            });
        } else {
            console.warn("[ChitChat] EmojiMart not found. Emoji picker disabled.");
        }
    } catch (e) {
        console.error("[ChitChat] EmojiMart Plugin Fail:", e);
    }

    // 7. Lifecycle Management
    window.addEventListener('beforeunload', () => {
        if (currentRoom.id) leaveRoom();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && isTyping) {
            setTypingStatus(false);
        }
    });

    // FIX #10: Connection state monitoring with user-visible banner
    monitorConnection();
});

// ==========================================
// 4. LISTENER MANAGEMENT
// ==========================================

/**
 * FIX #1 — Core Fix: Properly detach all room listeners.
 * We now store both the ref AND the callback, then call off(ref, callback).
 * The previous code called off(queryRef) without a callback, which is
 * documented to be a no-op for specific listener types on specific paths.
 */
function detachRoomListeners() {
    if (listeners.msgRef && listeners.msgCallback) {
        off(listeners.msgRef, 'child_added', listeners.msgCallback);
        console.log("[ChitChat] Detached msgQuery listener.");
    }
    if (listeners.memberRef && listeners.memberCallback) {
        off(listeners.memberRef, 'value', listeners.memberCallback);
        console.log("[ChitChat] Detached memberRef listener.");
    }
    if (listeners.typingRef && listeners.typingCallback) {
        off(listeners.typingRef, 'value', listeners.typingCallback);
        console.log("[ChitChat] Detached typingRef listener.");
    }
    listeners = { msgCallback: null, memberCallback: null, typingCallback: null, msgRef: null, memberRef: null, typingRef: null };
}

// ==========================================
// 5. CHAT CORE LOGIC
// ==========================================
async function handleCreateRoom() {
    const rName = dom.newRoomName.value.trim();
    const rPass = dom.newRoomPass.value.trim();
    if (!rName) return alert("Enter Room Name");

    dom.createRoomBtn.disabled = true;
    const rCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
        const roomRef = ref(db, "rooms/" + rCode);
        await set(roomRef, {
            name: rName, password: rPass, code: rCode, createdBy: currentUser.uid, createdAt: serverTimestamp()
        });
        enterRoom(rCode, rName, rCode);
    } catch (err) {
        console.error("[ChitChat] Create Room Fail:", err);
        alert("Failed to create room.");
    } finally {
        dom.createRoomBtn.disabled = false;
    }
}

async function handleJoinRoom() {
    const code = dom.joinRoomCode.value.trim().toUpperCase();
    const pass = dom.joinRoomPass.value.trim();
    if (!code) return alert("Enter 6-char Code");

    dom.joinRoomBtn.disabled = true;
    try {
        const snapshot = await get(ref(db, "rooms/" + code));
        if (!snapshot.exists()) return alert("Room not found");

        const roomData = snapshot.val();
        if (roomData.password && roomData.password !== pass) return alert("Incorrect Password");

        enterRoom(code, roomData.name, code);
    } catch (err) {
        console.error("[ChitChat] Join Room Fail:", err);
        alert("Failed to join room.");
    } finally {
        dom.joinRoomBtn.disabled = false;
    }
}

async function enterRoom(roomId, roomName, roomCode) {
    // FIX #1: Properly detach previous listeners before attaching new ones.
    detachRoomListeners();

    // FIX #7: Clear the deduplication set for the new room.
    renderedMsgIds.clear();

    // FIX #8: Reset initial load flag for the new room.
    isInitialLoad = true;

    currentRoom = { id: roomId, name: roomName, code: roomCode };
    dom.dashboardOverlay.classList.remove('active');
    dom.appContainer.classList.add('active');
    dom.displayRoomName.innerText = roomName;
    dom.displayRoomCode.innerText = roomCode;

    // FIX: Was a plain string, not a template literal — ${roomName} rendered literally.
    dom.msgViewport.innerHTML = `<div class="empty-state">Welcome to ${roomName}</div>`;

    await set(ref(db, `rooms/${roomId}/members/${currentUser.uid}`), {
        name: currentUser.name, joinedAt: serverTimestamp()
    });

    sendSystemMsg(`${currentUser.name} joined the room`);

    // --- Message Listener ---
    // FIX #1 + #8: Store callback ref so off() can properly remove it later.
    // FIX #8: Distinguish initial load messages (instant scroll) from new ones (smooth scroll).
    const msgQueryRef = query(ref(db, `messages/${roomId}`), limitToLast(60));
    listeners.msgRef = msgQueryRef;

    listeners.msgCallback = (snapshot) => {
        const msgId = snapshot.key;

        // FIX #7: Skip if we've already rendered this message ID.
        if (renderedMsgIds.has(msgId)) return;
        renderedMsgIds.add(msgId);

        const loadingState = dom.msgViewport.querySelector('.empty-state');
        if (loadingState) loadingState.remove();

        renderMsg(snapshot.val());
        pruneMessages();

        // FIX #2: Debounced scroll — don't fire 60 smooth scrolls on initial load.
        if (isInitialLoad) {
            scheduleScrollToBottom(false); // instant during batch
        } else {
            scheduleScrollToBottom(true); // smooth for new messages
        }
    };

    onChildAdded(msgQueryRef, listeners.msgCallback);

    // FIX #8: After one tick, all initial onChildAdded callbacks have fired.
    // Mark initial load as done so future messages get smooth scroll.
    setTimeout(() => {
        isInitialLoad = false;
        scrollToBottom(false); // Final instant scroll after all initial messages loaded
    }, 300);

    // --- Members Listener ---
    listeners.memberRef = ref(db, `rooms/${roomId}/members`);
    listeners.memberCallback = (snapshot) => {
        dom.memberCount.innerText = snapshot.size || 0;
        // FIX: Use DocumentFragment for batch DOM update instead of repeated innerHTML resets
        const fragment = document.createDocumentFragment();
        snapshot.forEach(childSnap => {
            const m = childSnap.val();
            const div = document.createElement('div');
            div.className = 'member-item';
            div.innerHTML = `
                <div class="user-avatar-wrap">
                    <div class="user-avatar">${escapeHtml(m.name.charAt(0))}</div>
                    <div class="status-dot online"></div>
                </div>
                <span class="member-name">${escapeHtml(m.name)} ${childSnap.key === currentUser.uid ? '(You)' : ''}</span>
            `;
            fragment.appendChild(div);
        });
        dom.memberList.innerHTML = '';
        dom.memberList.appendChild(fragment);
    };
    onValue(listeners.memberRef, listeners.memberCallback);

    // --- Typing Listener ---
    listeners.typingRef = ref(db, `rooms/${roomId}/typing`);
    listeners.typingCallback = (snapshot) => {
        const typers = [];
        snapshot.forEach(childSnap => {
            if (childSnap.key !== currentUser.uid && childSnap.val().isTyping) {
                typers.push(childSnap.val().name);
            }
        });
        dom.typingBar.innerText = typers.length > 0 ? `${typers.join(', ')} is typing...` : '';
    };
    onValue(listeners.typingRef, listeners.typingCallback);
}

// FIX #5: isSending guard prevents double-sends on rapid button clicks/Enter presses.
async function handleSend() {
    if (isSending) return;
    const text = dom.mainInput.value.trim();
    if (!text || !currentRoom.id) return;

    isSending = true;
    dom.sendBtn.disabled = true;
    const originalText = text;
    dom.mainInput.value = '';

    try {
        await push(ref(db, `messages/${currentRoom.id}`), {
            text: originalText,
            senderName: currentUser.name,
            senderId: currentUser.uid,
            type: 'text',
            timestamp: serverTimestamp()
        });
        setTypingStatus(false);

        if (currentUser.name !== "🤖 Bot") {
            setTimeout(() => botReply(originalText), 1000);
        }
    } catch (err) {
        console.error("[ChitChat] Send Msg Fail:", err);
        dom.mainInput.value = originalText; // Restore on failure
        showToast("Failed to send message. Check your connection.", true);
    } finally {
        isSending = false;
        dom.sendBtn.disabled = false;
        dom.mainInput.focus();
    }
}

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file || !currentRoom.id) return;

    const isImage = file.type.startsWith('image/');
    const type = isImage ? 'image' : 'file';
    const fileName = `${Date.now()}_${file.name}`;
    const storageRef = sRef(storage, `rooms/${currentRoom.id}/${fileName}`);

    try {
        sendSystemMsg(`Uploading ${isImage ? 'image' : 'file'}: ${file.name}...`);
        const snapshot = await uploadBytes(storageRef, file);
        const fileUrl = await getDownloadURL(snapshot.ref);

        await push(ref(db, `messages/${currentRoom.id}`), {
            text: file.name,
            fileUrl,
            senderName: currentUser.name,
            senderId: currentUser.uid,
            type,
            timestamp: serverTimestamp()
        });

        dom.fileUpload.value = '';
    } catch (err) {
        console.error("[ChitChat] Upload Fail:", err);
        showToast("Upload failed!", true);
        dom.fileUpload.value = '';
    }
}

// ==========================================
// 6. RENDERING
// ==========================================
function renderMsg(data) {
    if (!data) return;
    if (!data.senderId && data.type !== 'system') return;

    const isMe = data.senderId === currentUser.uid;
    const isSystem = data.type === 'system';
    const div = document.createElement('div');
    div.className = `msg-row ${isMe ? 'sent' : 'received'} ${isSystem ? 'system' : ''}`;

    let time = "Just now";
    if (data.timestamp) {
        const ts = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
        time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    if (isSystem) {
        div.innerHTML = `<div class="bubble">${escapeHtml(data.text)}</div>`;
    } else {
        let content = `<p>${escapeHtml(data.text || '')}</p>`;

        if (data.type === 'image' && data.fileUrl) {
            const safeUrl = encodeURI(data.fileUrl);
            content = `
                <div class="img-preview-container">
                    <img src="${safeUrl}" class="img-preview" alt="User Image" loading="lazy"
                         onclick="window.open('${safeUrl}', '_blank', 'noopener')">
                </div>
            `;
        } else if (data.type === 'file' && data.fileUrl) {
            const safeUrl = encodeURI(data.fileUrl);
            content = `
                <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="file-card">
                    <div class="file-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                            <path d="M13 2v7h7" />
                        </svg>
                    </div>
                    <div class="file-info">
                        <span class="file-name">${escapeHtml(data.text)}</span>
                        <span class="file-action">Click to Download</span>
                    </div>
                </a>
            `;
        }

        div.innerHTML = `
            ${!isMe ? `<span class="sender-name">${escapeHtml(data.senderName || 'Unknown')}</span>` : ''}
            <div class="bubble">${content}</div>
            <span class="timestamp">${time}</span>
        `;
    }

    dom.msgViewport.appendChild(div);
}

// ==========================================
// 7. SCROLL MANAGEMENT (FIX #2 + #8)
// ==========================================

/**
 * FIX #2: Debounced scroll scheduler.
 * Instead of calling scrollTo on every single message in a batch,
 * we schedule ONE scroll per animation frame. This prevents 60+
 * simultaneous smooth scroll animations on initial load.
 */
function scheduleScrollToBottom(smooth) {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
        scrollToBottom(smooth);
        scrollScheduled = false;
    });
}

function scrollToBottom(smooth = true) {
    dom.msgViewport.scrollTo({
        top: dom.msgViewport.scrollHeight,
        behavior: smooth ? 'smooth' : 'instant'
    });
}

// ==========================================
// 8. PRUNING (FIX #3)
// ==========================================

/**
 * FIX #3: O(1) check using childElementCount instead of querySelectorAll('.msg-row').
 * querySelectorAll is an O(n) DOM scan — previously called on EVERY message render,
 * causing exponential slowdown. childElementCount is a direct property read.
 * Pruning is deferred to a requestAnimationFrame so it doesn't block the render pipeline.
 */
const MAX_DOM_MESSAGES = 80;

function pruneMessages() {
    if (dom.msgViewport.childElementCount <= MAX_DOM_MESSAGES) return;

    requestAnimationFrame(() => {
        const children = dom.msgViewport.children;
        const excess = children.length - MAX_DOM_MESSAGES;
        if (excess <= 0) return;

        // Remove in batch using a document range for efficiency
        const range = document.createRange();
        range.setStartBefore(children[0]);
        range.setEndAfter(children[excess - 1]);
        range.deleteContents();

        console.log(`[ChitChat] Pruned ${excess} old messages from DOM.`);
    });
}

// ==========================================
// 9. LEAVE ROOM
// ==========================================
async function leaveRoom() {
    if (!currentRoom.id) return;
    const rid = currentRoom.id;
    const uid = currentUser.uid;

    try {
        await sendSystemMsg(`${currentUser.name} left the room`);
        await remove(ref(db, `rooms/${rid}/members/${uid}`));
        await remove(ref(db, `rooms/${rid}/typing/${uid}`));

        // FIX #1: Use the stored callback references for proper cleanup.
        detachRoomListeners();

        dom.appContainer.classList.remove('active');
        dom.dashboardOverlay.classList.add('active');
        currentRoom = { id: null, name: "", code: "" };
        dom.msgViewport.innerHTML = '';
        renderedMsgIds.clear();
    } catch (err) {
        console.error("[ChitChat] Leave Fail:", err);
    }
}

// ==========================================
// 10. TYPING SYNC
// ==========================================
function setTypingStatus(status) {
    if (currentRoom.id) {
        set(ref(db, `rooms/${currentRoom.id}/typing/${currentUser.uid}`), {
            isTyping: status,
            name: currentUser.name
        }).catch(err => console.warn("[ChitChat] Typing update failed:", err));
    }
}

// ==========================================
// 11. SYSTEM MESSAGES
// ==========================================
async function sendSystemMsg(text) {
    if (currentRoom.id) {
        try {
            await push(ref(db, `messages/${currentRoom.id}`), {
                text, type: 'system', timestamp: serverTimestamp()
            });
        } catch (e) {
            console.error("[ChitChat] System Msg Fail:", e);
        }
    }
}

// ==========================================
// 12. BOT ENGINE
// ==========================================
async function botReply(userMsg) {
    if (isBotResponding || !currentRoom.id) return;

    const msg = userMsg.toLowerCase();
    let reply = "";

    if (msg.includes("hello") || msg.includes("hi")) reply = `Hello ${currentUser.name}! How can I help you today? 👋`;
    else if (msg.includes("kaise ho")) reply = "Main ek Advanced AI hu, hamesha ki tarah badhiya! 😎";
    else if (msg.includes("time")) reply = `The current time is ${new Date().toLocaleTimeString()}. 🕒`;
    else if (msg.includes("room code")) reply = `The secret code for this room is: ${currentRoom.code}`;
    else if (msg.includes("bye")) reply = "Goodbye! Hope to see you again soon. ✨";

    if (!reply) return;

    isBotResponding = true;

    try {
        await push(ref(db, `messages/${currentRoom.id}`), {
            text: reply,
            senderName: "🤖 Bot",
            senderId: "system-bot",
            type: 'text',
            timestamp: serverTimestamp()
        });
    } catch (err) {
        console.error("[ChitChat] Bot Reply Fail:", err);
    } finally {
        setTimeout(() => { isBotResponding = false; }, 2000);
    }
}

// ==========================================
// 13. CONNECTION MONITORING (FIX #10)
// ==========================================
function monitorConnection() {
    const connRef = ref(db, '.info/connected');
    onValue(connRef, (snap) => {
        if (snap.val() === true) {
            console.log("[ChitChat] Firebase connection: ONLINE");
            hideConnectionBanner();
        } else {
            console.warn("[ChitChat] Firebase connection: OFFLINE");
            showConnectionBanner();
        }
    });
}

let connectionBanner = null;
function showConnectionBanner() {
    if (connectionBanner) return;
    connectionBanner = document.createElement('div');
    connectionBanner.id = 'connectionBanner';
    connectionBanner.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; z-index: 9999;
        background: #ef4444; color: white; text-align: center;
        padding: 8px 16px; font-size: 0.85rem; font-weight: 600;
        font-family: 'Inter', sans-serif;
        animation: slideDown 0.3s ease-out;
    `;
    connectionBanner.textContent = '⚠️ Connection lost — attempting to reconnect...';
    document.body.prepend(connectionBanner);
}

function hideConnectionBanner() {
    if (connectionBanner) {
        connectionBanner.remove();
        connectionBanner = null;
    }
}

// ==========================================
// 14. UTILITIES
// ==========================================

/** Sanitize user content to prevent XSS. */
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Non-blocking toast notification. */
let toastTimeout = null;
function showToast(message, isError = false) {
    const existing = document.getElementById('chitchat-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'chitchat-toast';
    toast.style.cssText = `
        position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
        background: ${isError ? '#ef4444' : '#10b981'}; color: white;
        padding: 10px 24px; border-radius: 50px; font-size: 0.9rem; font-weight: 600;
        font-family: 'Inter', sans-serif; z-index: 9999;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        animation: slideUp 0.3s ease-out;
        pointer-events: none;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.remove(), 2500);
}
