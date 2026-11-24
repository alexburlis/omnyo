process.argv.push("--bundled", "--no-in-app-updates");

await import("omnyo-app/dist/omnyo-app.js");
