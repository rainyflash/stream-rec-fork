const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const esbuild = require("esbuild")

const rootDir = __dirname
const buildDir = path.join(rootDir, "build")
const distDir = path.join(rootDir, "dist")
const mainBundle = path.join(buildDir, "sea-main.cjs")
const seaConfigPath = path.join(buildDir, "sea-config.json")
const seaBlobPath = path.join(buildDir, "sea-prep.blob")
const exePath = path.join(distDir, "stream-rec-r2-downloader.exe")
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

function run(command, args, options = {}) {
	execFileSync(command, args, {
		cwd: rootDir,
		stdio: "inherit",
		...options,
	})
}

function listPublicAssets() {
	const publicDir = path.join(rootDir, "public")
	const assets = {}

	function walk(currentDir) {
		for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
			const absolutePath = path.join(currentDir, entry.name)
			if (entry.isDirectory()) {
				walk(absolutePath)
				continue
			}

			const relativePath = path.relative(publicDir, absolutePath).replace(/\\/g, "/")
			assets[`public/${relativePath}`] = absolutePath
		}
	}

	walk(publicDir)
	return assets
}

async function main() {
	await fsp.rm(buildDir, { recursive: true, force: true })
	await fsp.rm(distDir, { recursive: true, force: true })
	await fsp.mkdir(buildDir, { recursive: true })
	await fsp.mkdir(distDir, { recursive: true })

	await esbuild.build({
		entryPoints: [path.join(rootDir, "launcher.js")],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "cjs",
		outfile: mainBundle,
	})

	const seaConfig = {
		main: mainBundle,
		output: seaBlobPath,
		disableExperimentalSEAWarning: true,
		useCodeCache: false,
		useSnapshot: false,
		assets: listPublicAssets(),
	}
	await fsp.writeFile(seaConfigPath, `${JSON.stringify(seaConfig, null, "\t")}\n`, "utf8")

	run(process.execPath, ["--experimental-sea-config", seaConfigPath])
	fs.copyFileSync(process.execPath, exePath)

	run(process.execPath, [
		path.join(rootDir, "node_modules", "postject", "dist", "cli.js"),
		exePath,
		"NODE_SEA_BLOB",
		seaBlobPath,
		"--sentinel-fuse",
		sentinelFuse,
	])

	console.log(`Generated: ${exePath}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
