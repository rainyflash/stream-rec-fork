const net = require("node:net")
const { spawn } = require("node:child_process")

const HOST = "127.0.0.1"
const PORT = Number(process.env.PORT || 15721)

function getLocalUrl() {
	return `http://${HOST}:${PORT}`
}

function shouldOpenBrowser() {
	return process.env.OPEN_BROWSER !== "0"
}

function openBrowser(url) {
	const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open"
	spawn(command, [url], { detached: true, stdio: "ignore", windowsHide: true }).unref()
}

function startServer() {
	require("./server")
	if (shouldOpenBrowser()) {
		setTimeout(() => openBrowser(getLocalUrl()), 800)
	}
}

const probe = net.createServer()

probe.once("error", error => {
	if (error && error.code === "EADDRINUSE") {
		const url = getLocalUrl()
		console.error(`Port ${PORT} is already in use. Opening existing page: ${url}`)
		if (shouldOpenBrowser()) openBrowser(url)
		return
	}

	throw error
})

probe.once("listening", () => {
	probe.close(startServer)
})

probe.listen(PORT, HOST)
