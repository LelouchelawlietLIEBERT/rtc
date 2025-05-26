const socket = io("/")
const videoGrid = document.getElementById("video-grid");
const peers = {}
const myPeer = new Peer(undefined, {
  host: window.location.hostname,
  port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80),
  path: '/peerjs',
  secure: window.location.protocol === 'https:'
});


const myVideo = document.createElement("video")
myVideo.muted = true
myVideo.disablePictureInPicture = true
myVideo.addEventListener('contextmenu', (e) => e.preventDefault());

navigator.mediaDevices.getUserMedia({
  video:true,
  audio:false
}).then(stream=>{
  addVideoStream(myVideo, stream)

  myPeer.on("call",call=>{
    call.answer(stream)
    const video = document.createElement("video")
    video.disablePictureInPicture = true
    video.addEventListener('contextmenu', (e) => e.preventDefault());
    call.on("stream",userVideoStream=>{
      addVideoStream(video,userVideoStream)
    })
  })

  socket.on("user-connected",userId=>{
    connectToNewUser(userId,stream)
})
})

socket.on("user-disconnected",userId=>{
  if(peers[userId]) peers[userId].close()
})

myPeer.on("open",id=>{
  socket.emit("join-room",ROOM_ID,id)
})

function connectToNewUser(userId,stream){
  const call = myPeer.call(userId,stream)
  const video = document.createElement("video")
  video.disablePictureInPicture = true
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  call.on("stream",userVideoStream=>{
    addVideoStream(video,userVideoStream)
  })
  call.on("close",()=>{
    video.remove()
  })
  peers[userId] = call
}

function addVideoStream(video,stream){
  video.srcObject = stream
  video.addEventListener("loadedmetadata",()=>{
    video.play()
  })
  videoGrid.append(video)
}
