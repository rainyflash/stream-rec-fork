const http = require("node:http")
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { spawn, execFileSync } = require("node:child_process")

const HOST = "127.0.0.1"
const PORT = Number(process.env.PORT || 15721)
const REMOTE = process.env.R2_REMOTE || "stream-rec-r2:stream-rec-recordings"
const DEFAULT_DESTINATION = path.join(os.homedir(), "Videos")
const STATIC_DIR = path.join(__dirname, "public")
const MAX_LOG_LINES = 400

const jobs = new Map()

function findRclone() {
	const candidates = [
		process.env.RCLONE_PATH,
		path.join(os.homedir(), "Desktop", "interest", "tools", "rclone", "rclone-v1.74.3-windows-amd64", "rclone.exe"),
	].filter(Boolean)

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}

	try {
		const result = execFileSync("where", ["rclone"], { encoding: "utf8" })
		const first = result.split(/\r?\n/).find(Boolean)
		if (first) return first
	} catch {
		// 没有 PATH 里的 rclone 时走下面的显式错误。
	}

	throw new Error("找不到 rclone。请设置 RCLONE_PATH，或先安装/配置 rclone。")
}

const RCLONE = findRclone()

function sendJson(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
	})
	res.end(payload)
}

function sendText(res, status, text) {
	res.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
	})
	res.end(text)
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let raw = ""
		req.setEncoding("utf8")
		req.on("data", chunk => {
			raw += chunk
			if (raw.length > 2 * 1024 * 1024) {
				req.destroy()
				reject(new Error("请求体过大"))
			}
		})
		req.on("end", () => resolve(raw))
		req.on("error", reject)
	})
}

function runBuffered(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(RCLONE, args, {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		})

		const stdout = []
		const stderr = []

		child.stdout.on("data", chunk => stdout.push(chunk))
		child.stderr.on("data", chunk => stderr.push(chunk))
		child.on("error", reject)
		child.on("close", code => {
			const out = Buffer.concat(stdout).toString("utf8")
			const err = Buffer.concat(stderr).toString("utf8")
			if (code === 0) {
				resolve(out)
				return
			}
			reject(new Error(err || `rclone 退出码 ${code}`))
		})
	})
}

function getMotrixConfig() {
	const configPath = path.join(os.homedir(), "AppData", "Roaming", "com.motrix.next", "config.json")
	const raw = fs.readFileSync(configPath, "utf8")
	const parsed = JSON.parse(raw)
	const preferences = parsed.preferences || {}
	return {
		port: Number(preferences.rpcListenPort || 16800),
		secret: String(preferences.rpcSecret || ""),
	}
}

async function callMotrix(method, params) {
	const config = getMotrixConfig()
	const response = await fetch(`http://127.0.0.1:${config.port}/jsonrpc`, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			method,
			params: [`token:${config.secret}`, ...params],
		}),
	})
	const data = await response.json()
	if (!response.ok || data.error) {
		throw new Error(data.error?.message || `Motrix RPC 调用失败：${response.status}`)
	}
	return data.result
}

async function createPresignedUrl(remotePath) {
	const output = await runBuffered(["link", `${REMOTE}/${remotePath}`])
	const url = output.split(/\r?\n/).find(line => line.startsWith("http"))
	if (!url) {
		throw new Error(`无法生成临时链接：${remotePath}`)
	}
	return url.trim()
}

function sanitizeRemotePath(value) {
	if (typeof value !== "string") return ""
	return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\0/g, "")
}

function normalizeDestination(value) {
	if (typeof value !== "string" || value.trim() === "") return DEFAULT_DESTINATION
	return path.resolve(value.trim())
}

function appendJobLog(job, chunk) {
	const lines = chunk
		.toString("utf8")
		.replace(/\r/g, "\n")
		.split("\n")
		.map(line => line.trimEnd())
		.filter(Boolean)

	job.logs.push(...lines)
	if (job.logs.length > MAX_LOG_LINES) {
		job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
	}
}

async function listObjects(res) {
	const output = await runBuffered(["lsjson", REMOTE, "--recursive", "--files-only"])
	const rawItems = JSON.parse(output || "[]")
	const items = rawItems
		.filter(item => item && !item.IsDir && typeof item.Path === "string" && !item.Path.endsWith("/"))
		.map(item => {
			const parts = item.Path.split("/")
			return {
				path: item.Path,
				name: item.Name || parts.at(-1) || item.Path,
				streamer: parts[0] || "",
				date: parts[1] || "",
				size: Number(item.Size || 0),
				modTime: item.ModTime || null,
			}
		})
		.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"))

	sendJson(res, 200, { remote: REMOTE, items })
}

async function createDownloadJob(req, res) {
	const body = JSON.parse((await readBody(req)) || "{}")
	const paths = Array.isArray(body.paths) ? body.paths.map(sanitizeRemotePath).filter(Boolean) : []
	const destination = normalizeDestination(body.destination)

	if (paths.length === 0) {
		sendJson(res, 400, { error: "至少选择一个文件" })
		return
	}

	await fsp.mkdir(destination, { recursive: true })

	const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
	const filesFrom = path.join(os.tmpdir(), `stream-rec-r2-${id}.txt`)
	await fsp.writeFile(filesFrom, `${paths.join("\n")}\n`, "utf8")

	const job = {
		id,
		status: "running",
		startedAt: new Date().toISOString(),
		completedAt: null,
		destination,
		paths,
		logs: [`开始下载 ${paths.length} 个文件到 ${destination}`],
		exitCode: null,
		error: null,
	}
	jobs.set(id, job)

	const child = spawn(RCLONE, [
		"copy",
		REMOTE,
		destination,
		"--files-from",
		filesFrom,
		"--progress",
		"--stats",
		"1s",
		"--stats-one-line",
	], {
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	})

	job.process = child
	child.stdout.on("data", chunk => appendJobLog(job, chunk))
	child.stderr.on("data", chunk => appendJobLog(job, chunk))
	child.on("error", error => {
		job.status = "failed"
		job.error = error.message
		job.completedAt = new Date().toISOString()
	})
	child.on("close", async code => {
		job.exitCode = code
		job.completedAt = new Date().toISOString()
		job.status = code === 0 ? "completed" : "failed"
		job.logs.push(code === 0 ? "下载完成" : `下载失败，退出码 ${code}`)
		job.process = null
		await fsp.rm(filesFrom, { force: true }).catch(() => {})
	})

	sendJson(res, 202, { jobId: id })
}

async function sendToMotrix(req, res) {
	const body = JSON.parse((await readBody(req)) || "{}")
	const paths = Array.isArray(body.paths) ? body.paths.map(sanitizeRemotePath).filter(Boolean) : []
	const destination = normalizeDestination(body.destination)

	if (paths.length === 0) {
		sendJson(res, 400, { error: "至少选择一个文件" })
		return
	}

	const tasks = []
	for (const remotePath of paths) {
		const relativeDir = path.posix.dirname(remotePath)
		const fileName = path.posix.basename(remotePath)
		const targetDir = relativeDir === "." ? destination : path.join(destination, relativeDir)
		await fsp.mkdir(targetDir, { recursive: true })

		const url = await createPresignedUrl(remotePath)
		const gid = await callMotrix("aria2.addUri", [
			[url],
			{
				dir: targetDir,
				out: fileName,
				split: "16",
				"max-connection-per-server": "16",
				"min-split-size": "1M",
				continue: "true",
			},
		])
		tasks.push({ path: remotePath, gid })
	}

	sendJson(res, 200, { tasks })
}

async function getMotrixStatus(res) {
	try {
		const version = await callMotrix("aria2.getVersion", [])
		sendJson(res, 200, { available: true, version })
	} catch (error) {
		sendJson(res, 200, { available: false, error: error instanceof Error ? error.message : "Motrix 不可用" })
	}
}

function getJob(res, id) {
	const job = jobs.get(id)
	if (!job) {
		sendJson(res, 404, { error: "任务不存在" })
		return
	}

	const { process: _process, ...safeJob } = job
	sendJson(res, 200, safeJob)
}

function cancelJob(res, id) {
	const job = jobs.get(id)
	if (!job) {
		sendJson(res, 404, { error: "任务不存在" })
		return
	}
	if (job.process && job.status === "running") {
		job.logs.push("正在取消任务")
		job.process.kill()
	}
	sendJson(res, 200, { ok: true })
}

function openFolder(res, reqUrl) {
	const destination = normalizeDestination(reqUrl.searchParams.get("path"))
	fs.mkdirSync(destination, { recursive: true })
	spawn("explorer.exe", [destination], { detached: true, stdio: "ignore", windowsHide: true }).unref()
	sendJson(res, 200, { ok: true })
}

function serveStatic(reqUrl, res) {
	const requested = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname
	const target = path.normalize(path.join(STATIC_DIR, decodeURIComponent(requested)))
	if (!target.startsWith(STATIC_DIR)) {
		sendText(res, 403, "Forbidden")
		return
	}

	fs.readFile(target, (error, data) => {
		if (error) {
			sendText(res, 404, "Not found")
			return
		}

		const ext = path.extname(target)
		const types = {
			".html": "text/html; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".svg": "image/svg+xml",
		}
		res.writeHead(200, {
			"Content-Type": types[ext] || "application/octet-stream",
			"Cache-Control": "no-store",
		})
		res.end(data)
	})
}

async function handleRequest(req, res) {
	const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`)

	try {
		if (req.method === "GET" && reqUrl.pathname === "/api/config") {
			sendJson(res, 200, {
				remote: REMOTE,
				rclonePath: RCLONE,
				defaultDestination: DEFAULT_DESTINATION,
			})
			return
		}

		if (req.method === "GET" && reqUrl.pathname === "/api/list") {
			await listObjects(res)
			return
		}

		if (req.method === "POST" && reqUrl.pathname === "/api/download") {
			await createDownloadJob(req, res)
			return
		}

		if (req.method === "GET" && reqUrl.pathname === "/api/motrix/status") {
			await getMotrixStatus(res)
			return
		}

		if (req.method === "POST" && reqUrl.pathname === "/api/motrix/download") {
			await sendToMotrix(req, res)
			return
		}

		const jobMatch = reqUrl.pathname.match(/^\/api\/jobs\/([^/]+)$/)
		if (req.method === "GET" && jobMatch) {
			getJob(res, jobMatch[1])
			return
		}

		const cancelMatch = reqUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/)
		if (req.method === "POST" && cancelMatch) {
			cancelJob(res, cancelMatch[1])
			return
		}

		if (req.method === "POST" && reqUrl.pathname === "/api/open-folder") {
			openFolder(res, reqUrl)
			return
		}

		serveStatic(reqUrl, res)
	} catch (error) {
		sendJson(res, 500, { error: error instanceof Error ? error.message : "未知错误" })
	}
}

const server = http.createServer(handleRequest)

server.listen(PORT, HOST, () => {
	console.log(`R2 下载器已启动：http://${HOST}:${PORT}`)
	console.log(`Remote：${REMOTE}`)
	console.log(`rclone：${RCLONE}`)
})
