"use strict";
/**
 * iPad access, shell side (remote-access wave, 2026-11-11). The server owns
 * the record (src/server/remote-access.ts); the shell only reads it to
 *  - pin the server's loopback port, so `tailscale serve <port>` keeps
 *    pointing at it across launches (the port is chosen before the server
 *    starts, so a port change applies on the next launch), and
 *  - keep the Mac from sleeping while access is on, if the user asked.
 * The server still listens on 127.0.0.1 only. A broken or absent record
 * means "off".
 */
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

function remoteAccessFile(dataDir) {
	return path.join(dataDir, "remote-access.json");
}

function readRemoteAccessLaunch(dataDir) {
	try {
		const raw = JSON.parse(fs.readFileSync(remoteAccessFile(dataDir), "utf8"));
		const port = raw?.port;
		return {
			enabled: raw?.enabled === true,
			port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null,
			keepAwake: raw?.keepAwake !== false,
		};
	} catch {
		return { enabled: false, port: null, keepAwake: false };
	}
}

/** Resolves true when 127.0.0.1:<port> can be bound right now. */
function portAvailable(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
	});
}

/** The pinned port when access is on and that port is free, else null (the
 * caller then picks a random port as before; Settings shows the mismatch). */
async function pinnedRemotePort(dataDir, log) {
	const launch = readRemoteAccessLaunch(dataDir);
	if (!launch.enabled || !launch.port) return null;
	// A quick relaunch can find the previous server still releasing the port.
	for (let attempt = 0; attempt < 10; attempt++) {
		if (await portAvailable(launch.port)) return launch.port;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	log(`iPad access: port ${launch.port} is busy; using a random port. Choose another port in Settings.`);
	return null;
}

/** Keeps the system awake while access is on with keepAwake. Polls the
 * record (cheap stat) so toggling in Settings applies without a restart. */
function watchKeepAwake(dataDir, powerSaveBlocker, log) {
	let blocker = null;
	const apply = () => {
		const { enabled, keepAwake } = readRemoteAccessLaunch(dataDir);
		const want = enabled && keepAwake;
		if (want && blocker === null) {
			blocker = powerSaveBlocker.start("prevent-app-suspension");
			log("iPad access: keeping the Mac awake");
		} else if (!want && blocker !== null) {
			powerSaveBlocker.stop(blocker);
			blocker = null;
			log("iPad access: no longer keeping the Mac awake");
		}
	};
	apply();
	const file = remoteAccessFile(dataDir);
	fs.watchFile(file, { interval: 3000 }, apply);
	return () => {
		fs.unwatchFile(file, apply);
		if (blocker !== null) powerSaveBlocker.stop(blocker);
		blocker = null;
	};
}

module.exports = { readRemoteAccessLaunch, pinnedRemotePort, watchKeepAwake, portAvailable };
