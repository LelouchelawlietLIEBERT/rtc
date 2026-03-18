# 🎥 Real-Time Video Conferencing System (WebRTC)

A scalable **peer-to-peer video conferencing application** built using **WebRTC, Node.js, and Socket.io**, enabling users to create and join rooms with seamless real-time communication.

🌐 **Live Demo**: https://rtc-nexv.onrender.com/

---

## 🚀 Features

* 🔗 Create and join video conferencing rooms
* 📡 Peer-to-peer communication using WebRTC
* 🔄 Real-time signaling via Socket.io
* 🌐 ICE candidate exchange for connection setup
* 🛰️ STUN/TURN support for NAT traversal
* 📞 Call lifecycle management (join, leave)
* ⚡ Low-latency audio & video streaming

---

## 🏗️ Tech Stack

* **Frontend**: HTML, CSS, JavaScript, Nunjucks
* **Backend**: Node.js, Express
* **Real-Time Communication**: WebRTC
* **Signaling Server**: Socket.io

---

## 📁 Project Structure

```
rtc/
├── public/        # Frontend logic (WebRTC, UI scripts)
├── views/         # Nunjucks templates
├── server.js      # Signaling server (Node.js + Socket.io)
├── package.json   # Dependencies & scripts
```

---

## ⚙️ Installation & Setup

### 1️⃣ Clone the repository

```bash
git clone https://github.com/LelouchelawlietLIEBERT/rtc.git
cd rtc
```

### 2️⃣ Install dependencies

```bash
npm install
```

### 3️⃣ Run the application

```bash
npm start
```

> Optional (for development with auto-restart):

```bash
npm install -g nodemon
nodemon server.js
```

---

## 🌐 How It Works

1. Users create or join a room
2. Socket.io establishes a signaling channel
3. WebRTC handles:

   * SDP (Session Description Protocol) exchange
   * ICE candidate exchange
4. Peer-to-peer connection is established
5. Media streams are shared in real-time

WebRTC enables direct browser-to-browser communication for **low latency and efficient streaming** ([webrtc.github.io][1])

---

## 🔧 Configuration

### STUN Server (default)

```js
stun:stun.l.google.com:19302
```

### TURN Server (recommended for production)

Use:

* Coturn (self-hosted)
* Twilio / Xirsys (managed)

---

## 📸 Screenshots

*Add screenshots here (UI, video call screen, room join page)*

---

## 🚀 Future Improvements

* 👥 Multi-user conferencing (Mesh / SFU architecture)
* 🖥️ Screen sharing
* 💬 In-call chat
* 🔐 Authentication & private rooms
* 📊 Call analytics

---

## 🧠 Learnings

* Deep understanding of WebRTC internals (SDP, ICE, NAT traversal)
* Real-time communication using Socket.io
* Peer connection lifecycle handling
* Building low-latency distributed systems

---

## 🤝 Contributing

Contributions are welcome! Feel free to fork and submit a pull request.

---

## 📄 License

MIT License

---

## 👤 Author

**Ashwin Gowda**
🔗 GitHub: https://github.com/LelouchelawlietLIEBERT

---

[1]: https://webrtc.github.io/samples/?utm_source=chatgpt.com "WebRTC samples"
