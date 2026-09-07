const express = require("express");
const path = require("path");

const app = express();
const PORT = 3001;

// Serve the same page and artwork as GitHub Pages, without exposing source files.
app.use("/images", express.static(path.join(__dirname, "images")));
for (const file of ["index.html", "style.css", "favicon.png", "angry-cat-eyes.png"]) {
  app.get(file === "index.html" ? ["/", "/index.html"] : "/" + file,
    (req, res) => res.sendFile(path.join(__dirname, file)));
}
app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log("الموقع شغال على http://localhost:3001");
});

server.on("error", (error) => {
  console.log("حصل خطأ:", error.message);
});