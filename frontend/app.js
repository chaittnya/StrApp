const socket = io();

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

function currentShareTracks() {
  return tabStream ? tabStream.getTracks() : [];
}

function currentMicTracks() {
  return micStream ? micStream.getAudioTracks() : [];
}

function addLocalTracksToPeer(peer) {
  currentMicTracks().forEach((track) => peer.addTrack(track, micStream));
  currentShareTracks().forEach((track) => peer.addTrack(track, tabStream));
}

function replaceTrackOnPeers(kind, newTrack, streamRef) {
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === kind);
    if (sender) {
      sender.replaceTrack(newTrack || null);
    } else if (newTrack) {
      pc.addTrack(newTrack, streamRef);
    }
  });
}

async function createPeerConnection(remoteId, shouldCreateOffer) {
  if (peers.has(remoteId)) {
    return peers.get(remoteId).pc;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  const remoteStream = new MediaStream();

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

    const hasVideo = remoteStream.getVideoTracks().length > 0;
    if (hasVideo) {
      partyVideo.srcObject = remoteStream;
      activeShareOwnerId = remoteId;
      renderParticipants();
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      peers.delete(remoteId);
    }
  };

  addLocalTracksToPeer(pc);
  peers.set(remoteId, { pc, remoteStream });

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
  socket.emit('sync-event', {
    action,
    value,
  });
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
    socket.emit('join-room', { username: selfUsername });
  } catch (error) {
    joinError.textContent = `Mic permission failed: ${error.message}`;
  }
});

shareTabBtn.addEventListener('click', async () => {
  try {
    tabStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      preferCurrentTab: true,
    });

    partyVideo.srcObject = tabStream;
    partyVideo.muted = true;
    activeShareOwnerId = selfId;
    renderParticipants();

    const [videoTrack] = tabStream.getVideoTracks();
    const [audioTrack] = tabStream.getAudioTracks();

    replaceTrackOnPeers('video', videoTrack || null, tabStream);
    replaceTrackOnPeers('audio', audioTrack || null, tabStream);

    tabStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      activeShareOwnerId = null;
      renderParticipants();
      replaceTrackOnPeers('video', null, tabStream);
      replaceTrackOnPeers('audio', null, tabStream);
      tabStream = null;
    });
  } catch (error) {
    joinError.textContent = `Tab share failed: ${error.message}`;
  }
});

muteMicBtn.addEventListener('click', () => {
  isMicMuted = !isMicMuted;
  currentMicTracks().forEach((track) => {
    track.enabled = !isMicMuted;
  });
  muteMicBtn.textContent = isMicMuted ? 'Unmute mic' : 'Mute mic';
});

muteRemoteBtn.addEventListener('click', () => {
  isRemoteMuted = !isRemoteMuted;
  partyVideo.muted = isRemoteMuted || activeShareOwnerId === selfId;
  muteRemoteBtn.textContent = isRemoteMuted ? 'Unmute remote audio' : 'Mute remote audio';
});

playPauseBtn.addEventListener('click', () => {
  if (!partyVideo.srcObject) {
    return;
  }

  if (partyVideo.paused) {
    partyVideo.play();
    broadcastSync('play');
  } else {
    partyVideo.pause();
    broadcastSync('pause');
  }
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
  setStatus('Connected');

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

socket.on('sync-event', ({ action, value }) => {
  if (!partyVideo.srcObject) {
    return;
  }

  if (action === 'play') {
    partyVideo.play();
  }

  if (action === 'pause') {
    partyVideo.pause();
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
  setStatus('Socket connected');
});

socket.on('disconnect', () => {
  setStatus('Disconnected, reconnecting...');
});
