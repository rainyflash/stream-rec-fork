const state = {
	config: null,
	items: [],
	filter: "all",
	search: "",
	selected: new Set(),
	activeJobId: null,
}

const elements = {
	remoteLabel: document.querySelector("#remoteLabel"),
	refreshButton: document.querySelector("#refreshButton"),
	downloadButton: document.querySelector("#downloadButton"),
	motrixButton: document.querySelector("#motrixButton"),
	openFolderButton: document.querySelector("#openFolderButton"),
	destinationInput: document.querySelector("#destinationInput"),
	searchInput: document.querySelector("#searchInput"),
	groupList: document.querySelector("#groupList"),
	fileTable: document.querySelector("#fileTable"),
	selectAllInput: document.querySelector("#selectAllInput"),
	summaryLabel: document.querySelector("#summaryLabel"),
	clearSelectionButton: document.querySelector("#clearSelectionButton"),
	jobLabel: document.querySelector("#jobLabel"),
	cancelButton: document.querySelector("#cancelButton"),
	logOutput: document.querySelector("#logOutput"),
}

function formatBytes(value) {
	if (!Number.isFinite(value) || value <= 0) return "0 B"
	const units = ["B", "KB", "MB", "GB", "TB"]
	let size = value
	let unit = 0
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024
		unit += 1
	}
	return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatTime(value) {
	if (!value) return "-"
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return "-"
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date)
}

function getGroupKey(item) {
	return `${item.streamer || "未归类"}/${item.date || "未归档"}`
}

function getFilteredItems() {
	const query = state.search.trim().toLowerCase()
	return state.items.filter(item => {
		const groupMatched = state.filter === "all" || getGroupKey(item) === state.filter
		if (!groupMatched) return false
		if (!query) return true
		return item.path.toLowerCase().includes(query)
	})
}

function updateSelectionState() {
	const filtered = getFilteredItems()
	const selectedInView = filtered.filter(item => state.selected.has(item.path)).length
	const selectedTotal = state.selected.size
	const selectedBytes = state.items
		.filter(item => state.selected.has(item.path))
		.reduce((total, item) => total + item.size, 0)

	elements.summaryLabel.textContent = `${filtered.length} 个文件，已选 ${selectedTotal} 个（${formatBytes(selectedBytes)}）`
	elements.downloadButton.disabled = selectedTotal === 0 || state.activeJobId !== null
	elements.motrixButton.disabled = selectedTotal === 0
	elements.selectAllInput.checked = filtered.length > 0 && selectedInView === filtered.length
	elements.selectAllInput.indeterminate = selectedInView > 0 && selectedInView < filtered.length
}

function renderGroups() {
	const groups = new Map()
	for (const item of state.items) {
		const key = getGroupKey(item)
		const current = groups.get(key) || { count: 0, size: 0 }
		current.count += 1
		current.size += item.size
		groups.set(key, current)
	}

	const rows = [
		{ key: "all", label: "全部文件", count: state.items.length, size: state.items.reduce((sum, item) => sum + item.size, 0) },
		...[...groups.entries()]
			.sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))
			.map(([key, value]) => ({ key, label: key, ...value })),
	]

	elements.groupList.innerHTML = rows
		.map(group => `
			<button class="group-button ${state.filter === group.key ? "active" : ""}" data-group="${escapeHtml(group.key)}" type="button">
				<strong>${escapeHtml(group.label)}</strong>
				<span>${group.count} / ${formatBytes(group.size)}</span>
			</button>
		`)
		.join("")
}

function renderTable() {
	const items = getFilteredItems()
	if (items.length === 0) {
		elements.fileTable.innerHTML = `<tr><td class="empty" colspan="6">没有匹配的文件</td></tr>`
		updateSelectionState()
		return
	}

	elements.fileTable.innerHTML = items
		.map(item => `
			<tr>
				<td class="check-cell">
					<input type="checkbox" data-path="${escapeHtml(item.path)}" ${state.selected.has(item.path) ? "checked" : ""} />
				</td>
				<td>
					<span class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
					<span class="file-path">${escapeHtml(item.path)}</span>
				</td>
				<td>${escapeHtml(item.streamer || "-")}</td>
				<td>${escapeHtml(item.date || "-")}</td>
				<td class="size-cell">${formatBytes(item.size)}</td>
				<td class="time-cell">${formatTime(item.modTime)}</td>
			</tr>
		`)
		.join("")

	updateSelectionState()
}

function render() {
	renderGroups()
	renderTable()
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;")
}

async function requestJson(url, options) {
	const response = await fetch(url, options)
	const data = await response.json()
	if (!response.ok) {
		throw new Error(data.error || `请求失败：${response.status}`)
	}
	return data
}

async function loadConfig() {
	state.config = await requestJson("/api/config")
	elements.destinationInput.value = state.config.defaultDestination
	elements.remoteLabel.textContent = `Remote：${state.config.remote}`
}

async function refreshList() {
	elements.refreshButton.disabled = true
	elements.refreshButton.textContent = "刷新中..."
	try {
		const data = await requestJson("/api/list")
		state.items = data.items
		state.selected.clear()
		render()
	} catch (error) {
		elements.logOutput.textContent = error.message
	} finally {
		elements.refreshButton.disabled = false
		elements.refreshButton.textContent = "刷新列表"
	}
}

async function startDownload() {
	const paths = [...state.selected]
	if (paths.length === 0) return

	const result = await requestJson("/api/download", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			paths,
			destination: elements.destinationInput.value,
		}),
	})

	state.activeJobId = result.jobId
	elements.cancelButton.disabled = false
	updateSelectionState()
	pollJob()
}

async function sendSelectedToMotrix() {
	const paths = [...state.selected]
	if (paths.length === 0) return

	elements.motrixButton.disabled = true
	elements.motrixButton.textContent = "发送中..."
	elements.jobLabel.textContent = "正在生成 R2 临时链接"
	elements.logOutput.textContent = "正在发送任务到 Motrix..."

	try {
		const result = await requestJson("/api/motrix/download", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				paths,
				destination: elements.destinationInput.value,
			}),
		})

		elements.jobLabel.textContent = `已发送到 Motrix：${result.tasks.length} 个文件`
		elements.logOutput.textContent = result.tasks
			.map(task => `${task.gid}  ${task.path}`)
			.join("\n")
	} catch (error) {
		elements.jobLabel.textContent = "发送 Motrix 失败"
		elements.logOutput.textContent = error.message
	} finally {
		elements.motrixButton.textContent = "发送到 Motrix"
		updateSelectionState()
	}
}

async function pollJob() {
	if (!state.activeJobId) return

	try {
		const job = await requestJson(`/api/jobs/${state.activeJobId}`)
		elements.jobLabel.textContent = job.status === "running" ? `下载中：${job.paths.length} 个文件` : `任务状态：${job.status}`
		elements.logOutput.textContent = job.logs.join("\n")
		elements.logOutput.scrollTop = elements.logOutput.scrollHeight

		if (job.status === "running") {
			setTimeout(pollJob, 1000)
			return
		}

		state.activeJobId = null
		elements.cancelButton.disabled = true
		updateSelectionState()
	} catch (error) {
		elements.logOutput.textContent = error.message
		state.activeJobId = null
		elements.cancelButton.disabled = true
		updateSelectionState()
	}
}

async function cancelJob() {
	if (!state.activeJobId) return
	await requestJson(`/api/jobs/${state.activeJobId}/cancel`, { method: "POST" })
}

async function openFolder() {
	await requestJson(`/api/open-folder?path=${encodeURIComponent(elements.destinationInput.value)}`, { method: "POST" })
}

elements.refreshButton.addEventListener("click", refreshList)
elements.downloadButton.addEventListener("click", () => {
	startDownload().catch(error => {
		elements.logOutput.textContent = error.message
	})
})
elements.motrixButton.addEventListener("click", () => {
	sendSelectedToMotrix()
})
elements.openFolderButton.addEventListener("click", () => {
	openFolder().catch(error => {
		elements.logOutput.textContent = error.message
	})
})
elements.cancelButton.addEventListener("click", () => {
	cancelJob().catch(error => {
		elements.logOutput.textContent = error.message
	})
})
elements.searchInput.addEventListener("input", event => {
	state.search = event.target.value
	renderTable()
})
elements.groupList.addEventListener("click", event => {
	const button = event.target.closest("[data-group]")
	if (!button) return
	state.filter = button.dataset.group
	render()
})
elements.fileTable.addEventListener("change", event => {
	if (!(event.target instanceof HTMLInputElement)) return
	const filePath = event.target.dataset.path
	if (!filePath) return
	if (event.target.checked) {
		state.selected.add(filePath)
	} else {
		state.selected.delete(filePath)
	}
	updateSelectionState()
})
elements.selectAllInput.addEventListener("change", event => {
	const checked = event.target.checked
	for (const item of getFilteredItems()) {
		if (checked) {
			state.selected.add(item.path)
		} else {
			state.selected.delete(item.path)
		}
	}
	renderTable()
})
elements.clearSelectionButton.addEventListener("click", () => {
	state.selected.clear()
	renderTable()
})

loadConfig()
	.then(refreshList)
	.catch(error => {
		elements.remoteLabel.textContent = "连接失败"
		elements.logOutput.textContent = error.message
	})
