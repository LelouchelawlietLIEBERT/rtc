const express = require("express");
const app = express();
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const nunjucks = require("nunjucks");

nunjucks.configure("views", {
  autoescape: true,
  express: app,
});

app.use(express.static("public"));
app.set("view engine", "njk");

app.get("/", (req, res) => {
  res.render("home");
});

app.get("/room", (req, res) => {
  const id = req.query.id;
  res.redirect(`/room/${id}`);
});

app.get("/room/:room", (req, res) => {
  res.render("room", { rid: req.params.room });
});

io.on("connection", (socket) => {
  socket.on("join-room", (roomId, userId) => {
    socket.join(roomId)
    socket.to(roomId).emit("user-connected",userId)
    socket.on("disconnect",()=>{
      socket.to(roomId).emit("user-disconnected",userId)
    })
  });
});


server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
