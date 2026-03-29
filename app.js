/**
 * CHITCHAT ADVANCED MESSAGING ENGINE (V5 Final)
 * Firebase v10 Modular SDK Only
 * Fixed: Robust Auth Flow, Safe Plugin Loading, Cache-Busting
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { 
    getFirestore, collection, doc, addDoc, setDoc, getDocs, 
    deleteDoc, onSnapshot, query, orderBy, limit, serverTimestamp, 
    where, writeBatch 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { 
    getAuth, signInAnonymously, setPersistence, browserSessionPersistence, signOut 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { 
    getStorage, ref, uploadBytes, getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ==========================================
// 1. FIREBASE CONFIGURATION
// ==========================================
console.log("Initializing Firebase App...");
const firebaseConfig = {
    apiKey: "AIzaSyCyFiPkMeAzMjz55fpe4d8Ju6kOXYo5PiY",
    authDomain: "chitt-chatt-v01.firebaseapp.com",
    projectId: "chitt-chatt-v01",
    storageBucket: "chitt-chatt-v01.firebasestorage.app",
    messagingSenderId: "337758963578",
    appId: "1:337758963578:web:104cd188afbc0d5eb0f8c3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
console.log("Firebase initialized successfully.");

// ==========================================
// 2. STATE & SELECTORS
// ==========================================
let currentUser = { uid: null, name: "" };
let currentRoom = { id: null, name: "", code: "" };
let unsubMessages, unsubMembers, unsubTyping;
let isTyping = false;
let typingTimeout = null;

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
console.log("Attaching Event Listeners...");

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Ready. Checking IDs...");
    
    // Safety check for critical DOM elements
    if (!dom.enterBtn || !dom.mainInput) {
        console.error("Critical DOM mismatch! Missing enterBtn or mainInput.");
        return;
    }

    // 1. Enter Chat Button (Continue)
    dom.enterBtn.addEventListener('click', async () => {
        console.log("Continue button clicked.");
        const name = dom.usernameInput.value.trim();
        if (!name) return alert("Please enter your name");
        
        dom.enterBtn.disabled = true;
        dom.enterBtn.innerText = "Connecting...";

        try {
            console.log("Setting persistence to session...");
            await setPersistence(auth, browserSessionPersistence);
            
            // Force sign out to ensure a FRESH anonymous user for this tab
            await signOut(auth);

            console.log("Signing in anonymously...");
            const cred = await signInAnonymously(auth);
            console.log("Signed in as:", cred.user.uid);
            
            currentUser = { uid: cred.user.uid, name: name };
            dom.myUsername.innerText = name;
            
            await setDoc(doc(db, "users", currentUser.uid), {
                name: name, online: true, lastSeen: serverTimestamp(),
                tabId: Math.random().toString(36).substring(7) // Debug helper
            });
            
            dom.loginOverlay.classList.remove('active');
            dom.dashboardOverlay.classList.add('active');
            dom.welcomeName.innerText = `Hi, ${name}!`;
            console.log("Dashboard loaded.");
        } catch (err) {
            console.error("Auth Fail:", err);
            alert("Firebase Auth Restricted! Ensure 'Anonymous' is enabled in your Firebase Console.");
            dom.enterBtn.disabled = false;
            dom.enterBtn.innerText = "Continue";
        }
    });

    // 2. Messaging logic
    dom.sendBtn?.addEventListener('click', handleSend);
    dom.mainInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSend();
    });

    // 3. Room Logic
    dom.createRoomBtn?.addEventListener('click', handleCreateRoom);
    dom.joinRoomBtn?.addEventListener('click', handleJoinRoom);

    // 4. File Sharing
    dom.fileUpload?.addEventListener('change', handleFileUpload);

    // 5. Sidebar / Utility
    dom.leaveRoomBtn?.addEventListener('click', leaveRoom);
    dom.copyCodeBtn?.addEventListener('click', () => {
        navigator.clipboard.writeText(currentRoom.code);
        alert("Room Code Copied!");
    });
    
    if (dom.mobileMenuBtn) {
        dom.mobileMenuBtn.onclick = () => dom.sidebar.classList.toggle('open');
    }

    // 5. Safe EmojiMart Load
    console.log("Attempting to load EmojiMart...");
    try {
        if (typeof EmojiMart !== 'undefined') {
            const picker = new EmojiMart.Picker({ 
                onEmojiSelect: (e) => { dom.mainInput.value += e.native; dom.mainInput.focus(); },
                theme: 'dark' 
            });
            const pickerWrap = document.createElement('div');
            pickerWrap.style.cssText = "position:absolute;bottom:100px;left:40px;display:none;z-index:1000";
            dom.emojiBtn.addEventListener('click', () => {
                pickerWrap.style.display = (pickerWrap.style.display === 'none' ? 'block' : 'none');
            });
            console.log("EmojiMart loaded successfully.");
        } else {
            console.warn("EmojiMart not found. Emoji picker disabled.");
        }
    } catch (e) {
        console.error("EmojiMart Plugin Fail:", e);
    }

    // 6. Lifecycle Management (Senior Refactor)
    window.addEventListener('beforeunload', () => {
        if (currentRoom.id) leaveRoom();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && isTyping) {
            setTypingStatus(false);
        }
    });
});

// ==========================================
// 4. CHAT CORE LOGIC
// ==========================================
async function handleCreateRoom() {
    const rName = dom.newRoomName.value.trim();
    const rPass = dom.newRoomPass.value.trim();
    if (!rName) return alert("Enter Room Name");
    
    const rCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
        const roomRef = await addDoc(collection(db, "rooms"), {
            name: rName, password: rPass, code: rCode, createdBy: currentUser.uid, createdAt: serverTimestamp()
        });
        enterRoom(roomRef.id, rName, rCode);
    } catch (err) { console.error("Create Room Fail:", err); }
}

async function handleJoinRoom() {
    const code = dom.joinRoomCode.value.trim().toUpperCase();
    const pass = dom.joinRoomPass.value.trim();
    if (!code) return alert("Enter 6-char Code");
    
    try {
        const q = query(collection(db, "rooms"), where("code", "==", code));
        const snap = await getDocs(q);
        if (snap.empty) return alert("Room not found");
        
        const roomData = snap.docs[0].data();
        if (roomData.password && roomData.password !== pass) return alert("Incorrect Password");
        
        enterRoom(snap.docs[0].id, roomData.name, code);
    } catch (err) { console.error("Join Room Fail:", err); }
}

async function enterRoom(roomId, roomName, roomCode) {
    if (unsubMessages) unsubMessages();
    if (unsubMembers) unsubMembers();
    if (unsubTyping) unsubTyping();

    currentRoom = { id: roomId, name: roomName, code: roomCode };
    dom.dashboardOverlay.classList.remove('active');
    dom.appContainer.classList.add('active');
    dom.displayRoomName.innerText = roomName;
    dom.displayRoomCode.innerText = roomCode;
    dom.msgViewport.innerHTML = '<div class="empty-state">Loading Chat...</div>';

    await setDoc(doc(db, "rooms", roomId, "members", currentUser.uid), {
        name: currentUser.name, joinedAt: serverTimestamp()
    });
    
    sendSystemMsg(`${currentUser.name} joined the room`);

    // Listen to Messages
    const msgQ = query(collection(db, "rooms", roomId, "messages"), orderBy("timestamp", "asc"), limit(100));
    unsubMessages = onSnapshot(msgQ, (snap) => {
        dom.msgViewport.innerHTML = '';
        if (snap.empty) {
            dom.msgViewport.innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
        } else {
            snap.forEach(d => renderMsg(d.data()));
        }
        scrollToBottom();
    }, (err) => console.error("Snapshot Error:", err));

    // Listen to Members
    unsubMembers = onSnapshot(collection(db, "rooms", roomId, "members"), (snap) => {
        dom.memberCount.innerText = snap.size;
        dom.memberList.innerHTML = '';
        snap.forEach(d => {
            const m = d.data();
            const div = document.createElement('div');
            div.className = 'member-item';
            div.innerHTML = `
                <div class="user-avatar-wrap">
                    <div class="user-avatar">${m.name.charAt(0)}</div>
                    <div class="status-dot online"></div>
                </div>
                <span class="member-name">${m.name} ${d.id === currentUser.uid ? '(You)' : ''}</span>
            `;
            dom.memberList.appendChild(div);
        });
    });

    // Listen to Typing
    unsubTyping = onSnapshot(collection(db, "rooms", roomId, "typing"), (snap) => {
        const typers = [];
        snap.forEach(d => {
            if (d.id !== currentUser.uid && d.data().isTyping) typers.push(d.data().name);
        });
        dom.typingBar.innerText = typers.length > 0 ? `${typers.join(', ')} is typing...` : '';
    });
}

function handleSend() {
    const text = dom.mainInput.value.trim();
    if (!text || !currentRoom.id) return;
    
    dom.mainInput.value = '';
    addDoc(collection(db, "rooms", currentRoom.id, "messages"), {
        text, senderName: currentUser.name, senderId: currentUser.uid, type: 'text', timestamp: serverTimestamp()
    });
    setTypingStatus(false);
}

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file || !currentRoom.id) return;

    const isImage = file.type.startsWith('image/');
    const type = isImage ? 'image' : 'file';
    const fileName = `${Date.now()}_${file.name}`;
    const storageRef = ref(storage, `rooms/${currentRoom.id}/${fileName}`);

    try {
        console.log(`Uploading ${file.name}...`);
        sendSystemMsg(`Uploading ${isImage ? 'image' : 'file'}: ${file.name}...`);
        
        const snapshot = await uploadBytes(storageRef, file);
        const fileUrl = await getDownloadURL(snapshot.ref);

        await addDoc(collection(db, "rooms", currentRoom.id, "messages"), {
            text: file.name,
            fileUrl,
            senderName: currentUser.name,
            senderId: currentUser.uid,
            type,
            timestamp: serverTimestamp()
        });
        
        console.log("File uploaded successfully.");
        dom.fileUpload.value = ''; // Reset input
    } catch (err) {
        console.error("Upload Fail:", err);
        alert("Upload failed! Check your Firebase Storage rules.");
    }
}

function renderMsg(data) {
    if (!data.senderId && data.type !== 'system') return; // Defensive check
    
    const isMe = data.senderId === currentUser.uid;
    const isSystem = data.type === 'system';
    const div = document.createElement('div');
    div.className = `msg-row ${isMe ? 'sent' : 'received'} ${isSystem ? 'system' : ''}`;
    
    // Add data attribute for easier debugging
    div.setAttribute('data-sender-id', data.senderId);
    
    // Safety check for timestamp
    const time = data.timestamp ? new Date(data.timestamp.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Just now";
    
    if (isSystem) {
        div.innerHTML = `<div class="bubble">${data.text}</div>`;
    } else {
        let content = `<p>${data.text}</p>`;
        
        if (data.type === 'image') {
            content = `
                <div class="img-preview-container">
                    <img src="${data.fileUrl}" class="img-preview" alt="User Image" onclick="window.open('${data.fileUrl}')">
                </div>
            `;
        } else if (data.type === 'file') {
            content = `
                <a href="${data.fileUrl}" target="_blank" class="file-card">
                    <div class="file-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                            <path d="M13 2v7h7" />
                        </svg>
                    </div>
                    <div class="file-info">
                        <span class="file-name">${data.text}</span>
                        <span class="file-action">Click to Download</span>
                    </div>
                </a>
            `;
        }
        
        div.innerHTML = `
            ${!isMe ? `<span class="sender-name">${data.senderName}</span>` : ''}
            <div class="bubble">${content}</div>
            <span class="timestamp">${time}</span>
        `;
    }
    dom.msgViewport.appendChild(div);
}

function scrollToBottom() {
    dom.msgViewport.scrollTo({ top: dom.msgViewport.scrollHeight, behavior: 'smooth' });
}

async function leaveRoom() {
    if (!currentRoom.id) return;
    const rid = currentRoom.id;
    const uid = currentUser.uid;

    try {
        await sendSystemMsg(`${currentUser.name} left the room`);
        await deleteDoc(doc(db, "rooms", rid, "members", uid));
        await deleteDoc(doc(db, "rooms", rid, "typing", uid));

        if (unsubMessages) unsubMessages();
        if (unsubMembers) unsubMembers();
        if (unsubTyping) unsubTyping();

        dom.appContainer.classList.remove('active');
        dom.dashboardOverlay.classList.add('active');
        currentRoom = { id: null };
        dom.msgViewport.innerHTML = '';
    } catch (err) { console.error("Leave Fail:", err); }
}

// Room cleanup now handled by Firebase Cloud Function for security.

// 6. Typing Sync
dom.mainInput.addEventListener('input', () => {
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

function setTypingStatus(status) {
    if (currentRoom.id) setDoc(doc(db, "rooms", currentRoom.id, "typing", currentUser.uid), { isTyping: status, name: currentUser.name });
}

async function sendSystemMsg(text) {
    if (currentRoom.id) addDoc(collection(db, "rooms", currentRoom.id, "messages"), { text, type: 'system', timestamp: serverTimestamp() });
}
