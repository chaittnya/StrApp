const SIGNALING_URL = window.SIGNALING_SERVER_URL || 'https://seee.onrender.com';
const socket = io(SIGNALING_URL, {
  transports: ['websocket', 'polling'],
  withCredentials: false,
});

const joinCard = document.getElementById('joinCard');
const appGrid = document.getElementById('appGrid');
const joinBtn = document.getElementById('joinBtn');
const usernameInput = document.getElementById('usernameInput');
const joinError = document.getElementById('joinError');
const statusText = document.getElementById('statusText');
const participantsCount = document.getElementById('participantsCount');
const participantsList = document.getElementById('participantsList');
const userBadge = document.getElementById('userBadge');

const shareTabBtn = document.getElementById('shareTabBtn');
const muteMicBtn = document.getElementById('muteMicBtn');
const muteRemoteBtn = document.getElementById('muteRemoteBtn');
const playPauseBtn = document.getElementById('playPauseBtn');
const partyVideo = document.getElementById('partyVideo');
const seekRange = document.getElementById('seekRange');

const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

const peers = new Map();
const participants = new Map();

let selfId = null;
let selfUsername = null;
let maxParticipants = 4;
let micStream = null;
let tabStream = null;
let isMicMuted = false;
let isRemoteMuted = false;
let activeShareOwnerId = null;
let ignoreNextSeekBroadcast = false;

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function setStatus(text) {
  statusText.textContent = text;
}

function renderParticipants() {
  participantsList.innerHTML = '';
  [...participants.values()].forEach((person) => {
    const li = document.createElement('li');
    li.textContent = `${person.username}${person.id === activeShareOwnerId ? ' (sharing)' : ''}`;
    participantsList.appendChild(li);
  });

  participantsCount.textContent = `${participants.size} / ${maxParticipants} participants`;
}

function addMessage({ from, text }) {
  const row = document.createElement('div');
  row.className = 'msg';
  row.innerHTML = `<strong>${from}:</strong> ${text}`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function ensureMic() {
  if (micStream) {
    return micStream;
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  return micStream;
}

function upsertTrackSender(peerState, key, track) {
  const sender = peerState.senders[key];
  if (!sender) {
    return;
  }

  sender.replaceTrack(track || null);
}

function attachLocalTracks(peerState) {
  const micTrack = micStream?.getAudioTracks()[0] || null;
  const tabVideoTrack = tabStream?.getVideoTracks()[0] || null;
  const tabAudioTrack = tabStream?.getAudioTracks()[0] || null;

  upsertTrackSender(peerState, 'micAudio', micTrack);
  upsertTrackSender(peerState, 'tabVideo', tabVideoTrack);
  upsertTrackSender(peerState, 'tabAudio', tabAudioTrack);
}

function refreshAllPeerTracks() {
  peers.forEach((peerState) => {
    attachLocalTracks(peerState);
  });
}

async function createPeerConnection(remoteId, shouldCreateOffer) {
  if (peers.has(remoteId)) {
    return peers.get(remoteId).pc;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  const remoteStream = new MediaStream();
  const micAudioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const tabAudioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const tabVideoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
  const peerState = {
    pc,
    remoteStream,
    senders: {
      micAudio: micAudioTransceiver.sender,
      tabAudio: tabAudioTransceiver.sender,
      tabVideo: tabVideoTransceiver.sender,
    },
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        to: remoteId,
        data: { candidate: event.candidate },
      });
    }
  };

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });

    if (remoteStream.getVideoTracks().length > 0) {
      partyVideo.srcObject = remoteStream;
      activeShareOwnerId = remoteId;
      partyVideo.muted = isRemoteMuted || activeShareOwnerId === selfId;
      renderParticipants();
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      peers.delete(remoteId);
    }
  };

  peers.set(remoteId, peerState);
  attachLocalTracks(peerState);

  if (shouldCreateOffer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', {
      to: remoteId,
      data: { description: pc.localDescription },
    });
  }

  return pc;
}

async function handleSignal({ from, data }) {
  const pc = await createPeerConnection(from, false);

  if (data.description) {
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', {
        to: from,
        data: { description: pc.localDescription },
      });
    }
  }

  if (data.candidate) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (error) {
      console.warn('Failed to add ICE candidate', error);
    }
  }
}

function broadcastSync(action, value) {
  socket.emit('sync-event', { action, value });
}

joinBtn.addEventListener('click', async () => {
  joinError.textContent = '';
  selfUsername = usernameInput.value.trim().toLowerCase();

  if (!selfUsername) {
    joinError.textContent = 'Please enter a username.';
    return;
  }

  try {
    await ensureMic();
    refreshAllPeerTracks();
    socket.emit('join-room', { username: selfUsername });
  } catch (error) {
    joinError.textContent = `Mic permission failed: ${error.message}`;
  }
});

shareTabBtn.addEventListener('click', async () => {
  try {
    tabStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 30,
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      // Important: avoid forcing current tab so Chrome shows all shareable tabs.
      preferCurrentTab: false,
      // Hint Chrome to keep tab switching available during an active share.
      surfaceSwitching: 'include',
    });

    partyVideo.srcObject = tabStream;
    activeShareOwnerId = selfId;
    partyVideo.muted = true;
    renderParticipants();

    refreshAllPeerTracks();

    tabStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      activeShareOwnerId = null;
      tabStream = null;
      renderParticipants();
      refreshAllPeerTracks();
    });
  } catch (error) {
    joinError.textContent = `Tab share failed: ${error.message}`;
  }
});

muteMicBtn.addEventListener('click', () => {
  isMicMuted = !isMicMuted;
  micStream?.getAudioTracks().forEach((track) => {
    track.enabled = !isMicMuted;
  });
  muteMicBtn.textContent = isMicMuted ? 'Unmute mic' : 'Mute mic';
});

muteRemoteBtn.addEventListener('click', () => {
  isRemoteMuted = !isRemoteMuted;
  partyVideo.muted = isRemoteMuted || activeShareOwnerId === selfId;
  muteRemoteBtn.textContent = isRemoteMuted ? 'Unmute remote audio' : 'Mute remote audio';
});

playPauseBtn.addEventListener('click', async () => {
  if (!partyVideo.srcObject) {
    return;
  }

  if (partyVideo.paused) {
    await partyVideo.play();
    broadcastSync('play');
    return;
  }

  partyVideo.pause();
  broadcastSync('pause');
});

partyVideo.addEventListener('timeupdate', () => {
  if (!partyVideo.duration) {
    return;
  }
  seekRange.value = ((partyVideo.currentTime / partyVideo.duration) * 100).toString();
});

seekRange.addEventListener('input', () => {
  if (!partyVideo.duration) {
    return;
  }

  const target = (Number(seekRange.value) / 100) * partyVideo.duration;
  partyVideo.currentTime = target;

  if (!ignoreNextSeekBroadcast) {
    broadcastSync('seek', target);
  }
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  socket.emit('chat-message', { text });
  chatInput.value = '';
});

socket.on('joined-room', async ({ selfId: id, participants: initialUsers, limits }) => {
  selfId = id;
  maxParticipants = limits.maxParticipants;

  joinCard.classList.add('hidden');
  appGrid.classList.remove('hidden');
  userBadge.textContent = `You: ${selfUsername}`;
  setStatus(`Connected to ${SIGNALING_URL}`);

  initialUsers.forEach((user) => participants.set(user.id, user));
  renderParticipants();

  for (const user of initialUsers) {
    if (user.id !== selfId) {
      await createPeerConnection(user.id, true);
    }
  }
});

socket.on('join-error', ({ message }) => {
  joinError.textContent = message;
});

socket.on('participant-joined', async (user) => {
  participants.set(user.id, user);
  renderParticipants();

  if (user.id !== selfId) {
    await createPeerConnection(user.id, true);
    addMessage({ from: 'system', text: `${user.username} joined.` });
  }
});

socket.on('participant-left', ({ id, username }) => {
  participants.delete(id);
  renderParticipants();

  const peer = peers.get(id);
  if (peer) {
    peer.pc.close();
    peers.delete(id);
  }

  if (activeShareOwnerId === id) {
    activeShareOwnerId = null;
    partyVideo.srcObject = null;
  }

  addMessage({ from: 'system', text: `${username} left.` });
});

socket.on('signal', handleSignal);

socket.on('chat-message', ({ from, text }) => {
  addMessage({ from, text });
});

socket.on('sync-event', async ({ action, value }) => {
  if (!partyVideo.srcObject) {
    return;
  }

  if (action === 'play') {
    await partyVideo.play();
    return;
  }

  if (action === 'pause') {
    partyVideo.pause();
    return;
  }

  if (action === 'seek') {
    ignoreNextSeekBroadcast = true;
    partyVideo.currentTime = Number(value) || 0;
    setTimeout(() => {
      ignoreNextSeekBroadcast = false;
    }, 100);
  }
});

socket.on('connect', () => {
  setStatus(`Socket connected: ${SIGNALING_URL}`);
});

socket.on('connect_error', (error) => {
  setStatus('Connection error');
  joinError.textContent = `Backend unreachable (${SIGNALING_URL}): ${error.message}`;
});

socket.on('disconnect', () => {
  setStatus('Disconnected, reconnecting...');
});
