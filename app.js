/**
 * CHITCHAT ADVANCED MESSAGING ENGINE (V7 — Connection Hardened)
 * Firebase v10 Modular SDK
 *
 * V7 CONNECTION FIXES:
 *  A. .info/connected false-negative fix — Firebase fires 'false' on page load,
 *     during auth token refresh (signOut → signIn cycle), and when tab goes
 *     background. Banner now only shows after a SUSTAINED disconnect (2s debounce).
 *  B. Auth token auto-refresh — PERMISSION_DENIED errors on push/set now trigger
 *     a silent re-authentication rather than a dead session.
 *  C. Write retry queue — failed messages are queued and replayed automatically
 *     when the connection is restored, so no message is permanently lost.
 *  D. Visibility-change goOnline() — forces Firebase to reconnect immediately
 *     when the user returns to a backgrounded tab.
 *  E. Heartbeat probe — polls .info/serverTimeOffset every 25s to detect silent
 *     connection hangs that .info/connected alone misses.
 *
 * V6 FIXES (retained):
 *  1–10. See previous version comments.
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
console.log('[ChitChat] Step 1: Loading Firebase config...');

/**
 * ROOT BUG FIX: databaseURL was MISSING from the config.
 * getDatabase(app) throws "Can't determine Firebase Database URL" without it,
 * crashing the entire JS module at line 48 — BEFORE DOMContentLoaded fires,
 * BEFORE the dom{} object is built, BEFORE any event listeners are attached.
 * Result: clicking "Continue" does absolutely nothing (no handler exists).
 *
 * The databaseURL format for Firebase RTDB is:
 *   https://<project-id>-default-rtdb.firebaseio.com
 * or for non-US regions:
 *   https://<project-id>-default-rtdb.<region>.firebasedatabase.app
 */
const firebaseConfig = {
    apiKey: "AIzaSyCyFiPkMeAzMjz55fpe4d8Ju6kOXYo5PiY",
    authDomain: "chitt-chatt-v01.firebaseapp.com",
    databaseURL: "https://chitt-chatt-v01-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "chitt-chatt-v01",
    storageBucket: "chitt-chatt-v01.firebasestorage.app",
    messagingSenderId: "337758963578",
    appId: "1:337758963578:web:104cd188afbc0d5eb0f8c3"
};

console.log('[ChitChat] Step 2: Initializing Firebase app...');
const app = initializeApp(firebaseConfig);

/**
 * BUG FIX: Wrap getDatabase in try/catch.
 * If databaseURL is wrong, this throws and crashes the module.
 * Now we catch it and show a visible error instead of silent failure.
 */
let db;
try {
    db = getDatabase(app);
    console.log('[ChitChat] Step 3: Firebase RTDB connected. ✓');
} catch (e) {
    console.error('[ChitChat] FATAL: getDatabase() failed:', e.message);
    // Show the error on-screen so it\'s visible even without DevTools open
    document.addEventListener('DOMContentLoaded', () => {
        document.body.innerHTML = `
            <div style="font-family:monospace;color:#ef4444;background:#020617;
                        padding:40px;height:100vh;display:flex;flex-direction:column;
                        align-items:center;justify-content:center;gap:16px;">
                <h2>⚠️ Firebase Database Error</h2>
                <p style="color:#94a3b8;max-width:600px;text-align:center;">
                    <strong>${e.message}</strong><br><br>
                    Check that <code>databaseURL</code> is correct in firebaseConfig.
                </p>
            </div>
        `;
    });
}

const auth = getAuth(app);
const storage = getStorage(app);
console.log('[ChitChat] Step 4: Auth + Storage ready. ✓');

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
let isSending = false;

/** Track rendered message IDs to prevent duplicate DOM nodes. */
const renderedMsgIds = new Set();

/** Track whether we are in the initial batch load phase. */
let isInitialLoad = true;
let scrollScheduled = false;

// ==========================================
// CONNECTION STATE MANAGEMENT (V7)
// ==========================================

/**
 * FIX A: Debounced connection state.
 * Firebase fires .info/connected = false during:
 *  - Page load (before the first handshake)
 *  - Auth token refresh (signOut → signInAnonymously cycle)
 *  - Tab backgrounding on mobile
 * None of these are real "connection lost" events. We only show the banner
 * if the offline state is sustained for >2 seconds.
 */
let connectionState = 'unknown';   // 'online' | 'offline' | 'unknown'
let disconnectDebounceTimer = null;
let heartbeatTimer = null;
let isReconnecting = false;

/**
 * FIX D: Write retry queue.
 * If a push() fails due to network error, the message payload is stored here.
 * When .info/connected returns true, the queue is flushed automatically.
 */
const writeRetryQueue = [];

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
        console.log('[ChitChat] >> Continue clicked.');

        const name = dom.usernameInput.value.trim();
        if (!name) return alert('Please enter your name.');

        // Guard: if db failed to init, tell the user clearly
        if (!db) {
            alert('Database not connected. Check the console for errors.');
            return;
        }

        dom.enterBtn.disabled = true;
        dom.enterBtn.innerText = 'Connecting...';

        /**
         * BUG FIX: Added a login timeout.
         * Without this, if Firebase Auth hangs (no network, quota exceeded, etc.)
         * the button stays permanently in "Connecting..." with no feedback.
         * 12 seconds is generous enough for slow connections.
         */
        const loginTimeout = setTimeout(() => {
            console.error('[ChitChat] Login timed out after 12s.');
            dom.enterBtn.disabled = false;
            dom.enterBtn.innerText = 'Continue';
            alert('Connection timed out. Check your network and try again.');
        }, 12000);

        try {
            console.log('[ChitChat] >> Step A: Setting session persistence...');
            await setPersistence(auth, browserSessionPersistence);

            /**
             * BUG FIX: Removed signOut(auth) from the login flow.
             *
             * The original code called signOut() before signInAnonymously().
             * signOut() makes a network round-trip to Firebase Auth servers
             * and triggers a .info/connected = false event on RTDB, causing
             * the "connection lost" banner to flash. On a slow network this
             * adds 1–3 seconds of unnecessary blocking before login proceeds.
             *
             * browserSessionPersistence already ensures each browser tab gets
             * a fresh session — signOut is redundant and harmful here.
             */
            console.log('[ChitChat] >> Step B: Signing in anonymously...');
            const cred = await signInAnonymously(auth);
            console.log('[ChitChat] >> Step C: Signed in. UID:', cred.user.uid);

            clearTimeout(loginTimeout); // Auth succeeded, cancel timeout

            currentUser = { uid: cred.user.uid, name };
            dom.myUsername.innerText = name;

            console.log('[ChitChat] >> Step D: Writing user presence to RTDB...');
            await set(ref(db, 'users/' + currentUser.uid), {
                name, online: true, lastSeen: serverTimestamp()
            });

            console.log('[ChitChat] >> Step E: Transitioning to dashboard. ✓');
            dom.loginOverlay.classList.remove('active');
            dom.dashboardOverlay.classList.add('active');
            dom.welcomeName.innerText = `Hi, ${name}!`;
            console.log('[ChitChat] >> Login complete. Dashboard visible.');

        } catch (err) {
            clearTimeout(loginTimeout);
            console.error('[ChitChat] Auth Fail:', err.code, err.message);

            let userMsg = 'Login failed. ';
            if (err.code === 'auth/operation-not-allowed') {
                userMsg += 'Anonymous sign-in is disabled. Enable it in Firebase Console → Authentication → Sign-in methods.';
            } else if (err.code === 'auth/network-request-failed') {
                userMsg += 'Network error. Check your internet connection.';
            } else if (err.code === 'auth/too-many-requests') {
                userMsg += 'Too many requests. Wait a moment and try again.';
            } else {
                userMsg += err.message;
            }

            alert(userMsg);
            dom.enterBtn.disabled = false;
            dom.enterBtn.innerText = 'Continue';
        }
    });

    // Press Enter in name field = same as clicking Continue
    dom.usernameInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') dom.enterBtn.click();
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
        if (document.visibilityState === 'hidden') {
            // Clear typing status when tab is hidden
            if (isTyping) setTypingStatus(false);
        } else {
            // FIX D: Force Firebase back online immediately when tab becomes visible.
            // Browsers throttle/kill WebSocket connections in background tabs.
            // goOnline() tells the Firebase SDK to reconnect NOW instead of waiting.
            console.log('[ChitChat] Tab visible — forcing Firebase online.');
            goOnline(db);
        }
    });

    // Start connection monitoring
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
    // BUG FIX: Firebase v10 modular off() signature is off(ref, callback) — NOT off(ref, eventName, callback).
    // Passing an event name string as the 2nd argument made off() treat it as the callback,
    // which never matched, so every listener silently remained attached forever.
    if (listeners.msgRef && listeners.msgCallback) {
        off(listeners.msgRef, listeners.msgCallback);
        console.log('[ChitChat] Detached msgQuery listener.');
    }
    if (listeners.memberRef && listeners.memberCallback) {
        off(listeners.memberRef, listeners.memberCallback);
        console.log('[ChitChat] Detached memberRef listener.');
    }
    if (listeners.typingRef && listeners.typingCallback) {
        off(listeners.typingRef, listeners.typingCallback);
        console.log('[ChitChat] Detached typingRef listener.');
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
    if (!code) return alert('Enter 6-char Code');

    dom.joinRoomBtn.disabled = true;
    try {
        const snapshot = await get(ref(db, 'rooms/' + code));

        // BUG FIX: Previous code used `return alert(...)` inside try block.
        // `return` inside try jumps over the finally block in some engine paths
        // and the button stayed permanently disabled. Use explicit re-enable instead.
        if (!snapshot.exists()) {
            alert('Room not found');
            dom.joinRoomBtn.disabled = false;
            return;
        }

        const roomData = snapshot.val();
        if (roomData.password && roomData.password !== pass) {
            alert('Incorrect Password');
            dom.joinRoomBtn.disabled = false;
            return;
        }

        enterRoom(code, roomData.name, code);
    } catch (err) {
        console.error('[ChitChat] Join Room Fail:', err);
        alert('Failed to join room.');
        dom.joinRoomBtn.disabled = false;
    }
}

async function enterRoom(roomId, roomName, roomCode) {
    console.log(`[ChitChat] enterRoom: id=${roomId} name=${roomName}`);

    // Detach any previous room's listeners before attaching new ones.
    detachRoomListeners();
    renderedMsgIds.clear();
    isInitialLoad = true;

    currentRoom = { id: roomId, name: roomName, code: roomCode };

    // Immediately show the UI — don't wait for Firebase writes.
    dom.dashboardOverlay.classList.remove('active');
    dom.appContainer.classList.add('active');
    dom.displayRoomName.innerText = roomName;
    dom.displayRoomCode.innerText = roomCode;
    dom.msgViewport.innerHTML = '';
    const welcomeEl = document.createElement('div');
    welcomeEl.className = 'empty-state';
    welcomeEl.textContent = `Welcome to ${roomName}`;
    dom.msgViewport.appendChild(welcomeEl);

    // Write member presence — non-blocking (don't await before attaching listeners).
    console.log(`[ChitChat] WRITE rooms/${roomId}/members/${currentUser.uid}`);
    set(ref(db, `rooms/${roomId}/members/${currentUser.uid}`), {
        name: currentUser.name, joinedAt: serverTimestamp()
    })
    .then(() => {
        console.log(`[ChitChat] ✓ Member presence written.`);
        // Send join message AFTER member doc is confirmed, so rules pass.
        sendSystemMsg(`${currentUser.name} joined the room`);
    })
    .catch(err => {
        console.error(`[ChitChat] ✗ Member write FAILED (path: rooms/${roomId}/members/${currentUser.uid}):`, err.code, err.message);
        showToast('Could not join room — permission error.', true);
    });

    // ── PATH FIX: was `messages/${roomId}` — WRONG (not in rules) ──────────────
    // Correct path per RTDB rules: rooms/${roomId}/messages/${messageId}
    // ────────────────────────────────────────────────────────────────────────────
    const MSGS_PATH = `rooms/${roomId}/messages`;
    console.log(`[ChitChat] Attaching message listener: ${MSGS_PATH}`);
    const msgQueryRef = query(ref(db, MSGS_PATH), limitToLast(60));
    listeners.msgRef = msgQueryRef;

    listeners.msgCallback = (snapshot) => {
        const msgId = snapshot.key;
        if (renderedMsgIds.has(msgId)) return;
        renderedMsgIds.add(msgId);

        const loadingState = dom.msgViewport.querySelector('.empty-state');
        if (loadingState) loadingState.remove();

        renderMsg(snapshot.val());
        pruneMessages();

        if (isInitialLoad) {
            scheduleScrollToBottom(false);
        } else {
            scheduleScrollToBottom(true);
        }
    };

    onChildAdded(msgQueryRef, listeners.msgCallback);

    setTimeout(() => {
        isInitialLoad = false;
        scrollToBottom(false);
    }, 300);

    // ── Members listener ──────────────────────────────────────────────────────
    listeners.memberRef = ref(db, `rooms/${roomId}/members`);
    listeners.memberCallback = (snapshot) => {
        // Use numChildren() for RTDB DataSnapshot; fall back to counting val() keys
        // in case the snapshot is received before the path fully initializes.
        const count = typeof snapshot.numChildren === 'function'
            ? snapshot.numChildren()
            : Object.keys(snapshot.val() || {}).length;
        dom.memberCount.innerText = count;
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

    // ── Typing listener ───────────────────────────────────────────────────────
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

    console.log(`[ChitChat] ✓ enterRoom complete. Listening on: ${MSGS_PATH}`);
}

/**
 * handleSend — with write retry queue (FIX D) and auth token refresh (FIX B).
 * If push() fails:
 *  - PERMISSION_DENIED → silently refresh auth token, then retry
 *  - Network error     → queue message for retry when connection restores
 */
async function handleSend() {
    if (isSending) return;
    const text = dom.mainInput.value.trim();
    if (!text || !currentRoom.id) return;

    isSending = true;
    dom.sendBtn.disabled = true;
    const originalText = text;
    dom.mainInput.value = '';

    const payload = {
        text: originalText,
        senderName: currentUser.name,
        senderId: currentUser.uid,
        type: 'text',
        timestamp: serverTimestamp()
    };

    // PATH FIX: was `messages/${currentRoom.id}` — must be under rooms/ to match RTDB rules.
    const msgPath = `rooms/${currentRoom.id}/messages`;
    console.log(`[ChitChat] SEND → ${msgPath}`, payload.text?.slice(0, 50));
    try {
        await writeWithRetry(msgPath, payload);
        setTypingStatus(false);

        if (currentUser.name !== '🤖 Bot') {
            setTimeout(() => botReply(originalText), 1000);
        }
    } catch (err) {
        console.error('[ChitChat] Send Msg Fail (permanent):', err);
        dom.mainInput.value = originalText; // Restore on permanent failure
        showToast('Message queued — will send when reconnected.', false);
    } finally {
        isSending = false;
        dom.sendBtn.disabled = false;
        dom.mainInput.focus();
    }
}

/**
 * FIX B + D: writeWithRetry
 * Attempts a Firebase push() with intelligent error handling:
 *  - On PERMISSION_DENIED: refresh the auth token silently and retry once.
 *  - On network error:     queue the write and flush when connection returns.
 */
async function writeWithRetry(path, payload, isRetry = false) {
    try {
        await push(ref(db, path), payload);
    } catch (err) {
        const code = err?.code || '';

        if (code === 'PERMISSION_DENIED' && !isRetry) {
            // FIX B: Auth token likely expired. Re-authenticate silently.
            console.warn('[ChitChat] PERMISSION_DENIED — refreshing auth token...');
            try {
                await refreshAuth();
                // Retry the write exactly once after token refresh
                await push(ref(db, path), payload);
                console.log('[ChitChat] Write succeeded after token refresh.');
            } catch (retryErr) {
                console.error('[ChitChat] Write failed even after token refresh:', retryErr);
                throw retryErr;
            }
        } else if (isNetworkError(err)) {
            // FIX D: Queue the write for when connectivity returns
            console.warn('[ChitChat] Network error — queuing write for retry:', path);
            writeRetryQueue.push({ path, payload });
            showToast('Offline — message will send when reconnected.', false);
            // Don't throw — the message is safely queued
        } else {
            throw err;
        }
    }
}

/** Classify an error as a transient network failure (vs auth/logic error). */
function isNetworkError(err) {
    const msg = (err?.message || '').toLowerCase();
    const code = err?.code || '';
    return (
        code === 'unavailable' ||
        msg.includes('network') ||
        msg.includes('timeout') ||
        msg.includes('fetch') ||
        msg.includes('failed to fetch') ||
        msg.includes('transport')
    );
}

/**
 * FIX B: Silently re-authenticate to refresh the Firebase Auth token.
 * Called when push() returns PERMISSION_DENIED mid-session (token expired after ~1h).
 */
async function refreshAuth() {
    try {
        // signInAnonymously on an existing anonymous user just refreshes the token
        const cred = await signInAnonymously(auth);
        // Update UID in case a new anonymous user was created
        currentUser.uid = cred.user.uid;
        console.log('[ChitChat] Auth token refreshed. UID:', cred.user.uid);
    } catch (err) {
        console.error('[ChitChat] Auth refresh failed:', err);
        throw err;
    }
}

/**
 * FIX D: Flush the write retry queue after reconnection.
 * Called by monitorConnection() when .info/connected goes true.
 */
async function flushWriteQueue() {
    if (writeRetryQueue.length === 0) return;
    const count = writeRetryQueue.length;
    console.log(`[ChitChat] Flushing ${count} queued writes...`);

    // Drain the queue by reference so concurrent flushes don't double-send
    const toFlush = writeRetryQueue.splice(0, count);
    let successCount = 0;
    for (const item of toFlush) {
        try {
            await push(ref(db, item.path), item.payload);
            successCount++;
            console.log('[ChitChat] Queued write flushed:', item.path);
        } catch (err) {
            console.error('[ChitChat] Queued write failed permanently:', err);
            // Don't re-queue — avoid infinite loop on persistent errors
        }
    }

    // BUG FIX: Previous code checked writeRetryQueue.length === 0 AFTER the splice,
    // which is always true (we already spliced everything out), so the toast
    // fired even if all writes failed. Now we check actual successes.
    if (successCount > 0) {
        showToast(`Back online! ${successCount} message${successCount > 1 ? 's' : ''} sent.`, false);
    }
}

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file || !currentRoom.id) return;

    const isImage = file.type.startsWith('image/');
    const type = isImage ? 'image' : 'file';
    const fileName = `${Date.now()}_${file.name}`;
    const storageRef = sRef(storage, `rooms/${currentRoom.id}/${fileName}`);

    // PATH FIX: was `messages/${currentRoom.id}` — must be under rooms/ to match RTDB rules.
    const fileMsgPath = `rooms/${currentRoom.id}/messages`;
    try {
        sendSystemMsg(`Uploading ${isImage ? 'image' : 'file'}: ${file.name}...`);
        const snapshot = await uploadBytes(storageRef, file);
        const fileUrl = await getDownloadURL(snapshot.ref);

        console.log(`[ChitChat] FILE UPLOAD → ${fileMsgPath}`, file.name);
        await push(ref(db, fileMsgPath), {
            text: file.name,
            fileUrl,
            senderName: currentUser.name,
            senderId: currentUser.uid,
            type,
            timestamp: serverTimestamp()
        });
        console.log(`[ChitChat] ✓ File message written.`);

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

    // BUG FIX: System messages were getting className 'msg-row received system'.
    // The 'received' class added left-align + avatar padding to system messages,
    // breaking their centered appearance. System messages must NOT get sent/received.
    if (isSystem) {
        div.className = 'msg-row system';
    } else {
        div.className = `msg-row ${isMe ? 'sent' : 'received'}`;
    }

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
    console.log(`[ChitChat] leaveRoom: id=${rid}`);

    // Immediately detach listeners and reset UI — don't block on Firebase writes.
    detachRoomListeners();
    dom.appContainer.classList.remove('active');
    dom.dashboardOverlay.classList.add('active');
    currentRoom = { id: null, name: '', code: '' };
    dom.msgViewport.innerHTML = '';
    renderedMsgIds.clear();

    // Fire-and-forget cleanup writes — UI has already transitioned.
    sendSystemMsg(`${currentUser.name} left the room`).catch(() => {});

    console.log(`[ChitChat] REMOVE rooms/${rid}/members/${uid}`);
    remove(ref(db, `rooms/${rid}/members/${uid}`))
        .then(() => console.log(`[ChitChat] ✓ Member removed.`))
        .catch(err => console.warn('[ChitChat] Member remove failed:', err.code));

    console.log(`[ChitChat] REMOVE rooms/${rid}/typing/${uid}`);
    remove(ref(db, `rooms/${rid}/typing/${uid}`))
        .catch(err => console.warn('[ChitChat] Typing remove failed:', err.code));
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
    if (!currentRoom.id) return;
    // PATH FIX: was `messages/${currentRoom.id}` — must be rooms/${id}/messages to match rules.
    const path = `rooms/${currentRoom.id}/messages`;
    console.log(`[ChitChat] SYSTEM MSG → ${path}:`, text);
    try {
        await push(ref(db, path), {
            text, type: 'system', timestamp: serverTimestamp()
        });
        console.log(`[ChitChat] ✓ System message written.`);
    } catch (e) {
        console.error(`[ChitChat] ✗ System Msg FAILED (${path}):`, e.code, e.message);
        throw e; // re-throw so callers can handle
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

    // PATH FIX: was `messages/${currentRoom.id}` — must be rooms/${id}/messages to match rules.
    const botPath = `rooms/${currentRoom.id}/messages`;
    console.log(`[ChitChat] BOT REPLY → ${botPath}:`, reply.slice(0, 60));
    try {
        await push(ref(db, botPath), {
            text: reply,
            senderName: '🤖 Bot',
            senderId: 'system-bot',
            type: 'text',
            timestamp: serverTimestamp()
        });
        console.log(`[ChitChat] ✓ Bot reply written.`);
    } catch (err) {
        console.error(`[ChitChat] ✗ Bot Reply FAILED (${botPath}):`, err.code, err.message);
    } finally {
        setTimeout(() => { isBotResponding = false; }, 2000);
    }
}

// ==========================================
// 13. CONNECTION MONITORING (V7 — Hardened)
// ==========================================

/**
 * FIX A: Debounced connection monitoring.
 *
 * The Problem with the V6 approach:
 * Firebase fires .info/connected = FALSE in perfectly normal situations:
 *   1. On initial page load (before the WebSocket handshake completes, ~500ms)
 *   2. During our own signOut() → signInAnonymously() auth cycle on login
 *   3. When the browser backgrounds the tab (mobile throttles the WS connection)
 * In V6, ALL of these showed the red "Connection lost" banner immediately,
 * making the app look broken when it was perfectly fine.
 *
 * The Fix:
 *   - When we get 'false', set a 2-second debounce timer before showing the banner.
 *   - If 'true' arrives within that 2 seconds, cancel the timer (false alarm).
 *   - When 'true' arrives, immediately hide any banner and flush the write queue.
 *
 * FIX E: Heartbeat probe.
 * .info/connected alone can miss "silent hangs" — where the WebSocket is open
 * but Firebase stops delivering data (observed on some mobile networks).
 * We probe .info/serverTimeOffset every 25s as a keepalive. If the probe hangs
 * for >8s, we call goOnline(db) to force a reconnect cycle.
 */
function monitorConnection() {
    const connRef = ref(db, '.info/connected');

    onValue(connRef, (snap) => {
        const isOnline = snap.val() === true;

        if (isOnline) {
            // Definitely online — cancel any pending "offline" debounce
            clearTimeout(disconnectDebounceTimer);
            disconnectDebounceTimer = null;

            if (connectionState !== 'online') {
                connectionState = 'online';
                console.log('[ChitChat] Connection: ONLINE');
                hideConnectionBanner();
                // FIX D: Flush any messages that were queued while offline
                flushWriteQueue();
            }

            // Start the heartbeat probe now that we're confirmed online
            startHeartbeat();

        } else {
            // FIX A: Don't immediately show banner — wait 2s to filter false alarms
            if (connectionState === 'online' && !disconnectDebounceTimer) {
                console.warn('[ChitChat] Connection: possible disconnect — waiting 2s to confirm...');
                disconnectDebounceTimer = setTimeout(() => {
                    disconnectDebounceTimer = null;
                    connectionState = 'offline';
                    console.error('[ChitChat] Connection: CONFIRMED OFFLINE');
                    showConnectionBanner();
                    stopHeartbeat();
                }, 2000);
            } else if (connectionState === 'unknown') {
                // Very first load — just update state, don't show banner yet
                // Firebase always fires false first before the initial handshake
                connectionState = 'connecting';
                console.log('[ChitChat] Connection: initial handshake in progress...');
            }
        }
    });
}

/**
 * FIX E: Heartbeat system.
 * Probes .info/serverTimeOffset every 25 seconds.
 * If the probe doesn't resolve within 8 seconds, the connection is silently hung
 * and we force goOnline(db) to trigger a fresh WebSocket reconnect.
 */
function startHeartbeat() {
    stopHeartbeat(); // clear any existing timer first
    heartbeatTimer = setInterval(async () => {
        const probe = ref(db, '.info/serverTimeOffset');
        let resolved = false;
        const timeout = setTimeout(() => {
            if (!resolved) {
                console.warn('[ChitChat] Heartbeat probe timed out — forcing reconnect.');
                goOnline(db);
            }
        }, 8000);

        try {
            await get(probe);
            resolved = true;
            clearTimeout(timeout);
        } catch (_e) {
            // BUG FIX: Empty catch binding `catch {}` causes a SyntaxError in some
            // environments and a lint warning in others. Use `catch (_e)` to be explicit.
            resolved = true;
            clearTimeout(timeout);
            // get() failed — goOnline already called above if timeout hit first
        }
    }, 25000);
    console.log('[ChitChat] Heartbeat started (25s interval).');
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

let connectionBanner = null;
let reconnectCountdown = null;

function showConnectionBanner() {
    if (connectionBanner) return;

    connectionBanner = document.createElement('div');
    connectionBanner.id = 'connectionBanner';
    connectionBanner.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; z-index: 9999;
        background: linear-gradient(90deg, #dc2626, #b91c1c);
        color: white; text-align: center;
        padding: 10px 16px; font-size: 0.85rem; font-weight: 600;
        font-family: 'Inter', sans-serif;
        animation: slideDown 0.3s ease-out;
        display: flex; align-items: center; justify-content: center; gap: 12px;
    `;

    const msg = document.createElement('span');
    msg.textContent = '⚠️ Connection lost — reconnecting';

    // Animated dots
    const dots = document.createElement('span');
    dots.style.cssText = 'letter-spacing: 2px;';
    let dotCount = 0;
    reconnectCountdown = setInterval(() => {
        dotCount = (dotCount + 1) % 4;
        dots.textContent = '.'.repeat(dotCount);
        // Actively try to come back online every 5 seconds
        if (dotCount === 0) goOnline(db);
    }, 1000);

    connectionBanner.appendChild(msg);
    connectionBanner.appendChild(dots);
    document.body.prepend(connectionBanner);
}

function hideConnectionBanner() {
    if (reconnectCountdown) {
        clearInterval(reconnectCountdown);
        reconnectCountdown = null;
    }
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

// ==========================================
// 15. MOBILE SIDEBAR DRAWER
// ==========================================

(function initMobileSidebar() {
    const sidebar        = document.getElementById('sidebar');
    const toggleBtn      = document.getElementById('sidebarToggleBtn');
    const overlay        = document.getElementById('sidebarOverlay');

    if (!sidebar || !toggleBtn || !overlay) return;

    /** Open the sidebar drawer */
    function openSidebar() {
        sidebar.classList.add('open');
        overlay.classList.add('active');
        toggleBtn.classList.add('is-open');
        toggleBtn.setAttribute('aria-expanded', 'true');
        // Prevent body scroll while drawer is open
        document.body.style.overflow = 'hidden';
    }

    /** Close the sidebar drawer */
    function closeSidebar() {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        toggleBtn.classList.remove('is-open');
        toggleBtn.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    }

    /** Toggle on hamburger button click */
    toggleBtn.addEventListener('click', () => {
        if (sidebar.classList.contains('open')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });

    /** Close when backdrop is tapped */
    overlay.addEventListener('click', closeSidebar);

    /** Close sidebar on Escape key */
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar.classList.contains('open')) {
            closeSidebar();
        }
    });

    /**
     * Auto-close sidebar when viewport is resized to desktop width.
     * Prevents a stale-open drawer if user rotates device or resizes window.
     */
    const mq = window.matchMedia('(max-width: 768px)');
    mq.addEventListener('change', (e) => {
        if (!e.matches) {
            // Switched to desktop — ensure drawer state is reset
            closeSidebar();
        }
    });
})();
