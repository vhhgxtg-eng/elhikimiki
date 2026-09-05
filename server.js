const express = require("express");
const path = require("path");

const app = express();
const PORT = 3001;

app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log("الموقع شغال على http://localhost:3001");
});

server.on("error", (error) => {
  console.log("حصل خطأ:", error.message);
});