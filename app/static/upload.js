const filesState = [];

const $ = (id) => document.getElementById(id);

function setStatus(message) {
  $("statusText").textContent = message;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const data = await response.json();
      detail = data.detail || detail;
    } catch (_) {
      // Keep status text.
    }
    throw new Error(detail);
  }
  return response.json();
}

async function chooseFiles(fileList) {
  filesState.length = 0;
  for (const file of fileList) {
    if (file.type.startsWith("image/")) {
      filesState.push({
        id: crypto.randomUUID(),
        file,
        status: "waiting",
        loaded: 0,
        percent: 0,
        speed: 0,
        duplicate: null,
        error: "",
      });
    }
  }
  renderList();
  await checkDuplicates();
}

async function checkDuplicates() {
  if (!filesState.length) {
    setStatus("等待选择文件");
    return;
  }
  setStatus("正在检查重复");
  try {
    const data = await api("/api/images/check-duplicates", {
      method: "POST",
      body: JSON.stringify({
        files: filesState.map((item) => ({ name: item.file.name, size: item.file.size })),
      }),
    });
    const byKey = new Map(data.items.map((item) => [`${item.name}\u0000${item.size}`, item.duplicate]));
    for (const item of filesState) {
      item.duplicate = byKey.get(`${item.file.name}\u0000${item.file.size}`) || null;
      item.status = item.duplicate ? "duplicate" : "waiting";
    }
    renderList();
    const duplicates = filesState.filter((item) => item.duplicate).length;
    setStatus(duplicates ? `发现 ${duplicates} 个重复文件` : "未发现重复文件");
  } catch (error) {
    setStatus(error.message);
  }
}

function renderList() {
  $("fileCount").textContent = `${filesState.length} 个文件`;
  $("totalSize").textContent = formatBytes(filesState.reduce((sum, item) => sum + item.file.size, 0));
  const list = $("uploadList");
  list.innerHTML = "";
  if (!filesState.length) {
    list.innerHTML = '<div class="empty-upload">还没有选择文件</div>';
    return;
  }

  for (const item of filesState) {
    const row = document.createElement("article");
    row.className = `upload-row ${item.status}`;
    row.innerHTML = `
      <div class="upload-main">
        <div class="upload-file-name">${escapeHtml(item.file.name)}</div>
        <div class="upload-meta">
          <span>${formatBytes(item.file.size)}</span>
          <span>${labelStatus(item)}</span>
          <span>${item.speed ? formatSpeed(item.speed) : ""}</span>
          <span>${Math.round(item.percent)}%</span>
        </div>
        <div class="progress"><div style="width:${item.percent}%"></div></div>
        ${renderDuplicate(item)}
        ${item.error ? `<div class="upload-error">${escapeHtml(item.error)}</div>` : ""}
      </div>
    `;
    list.appendChild(row);
  }
}

function labelStatus(item) {
  if (item.status === "duplicate") return "可能重复";
  if (item.status === "uploading") return "上传中";
  if (item.status === "done") return "完成";
  if (item.status === "skipped") return "已跳过";
  if (item.status === "error") return "失败";
  return "等待上传";
}

function renderDuplicate(item) {
  if (!item.duplicate) return "";
  const image = item.duplicate;
  return `
    <div class="duplicate-box">
      <img src="${image.thumb_url}" alt="" />
      <div>
        <strong>重复：${escapeHtml(image.title || image.original_name)}</strong>
        <span>${escapeHtml(image.original_name)} · ${formatBytes(image.size)} · ${escapeHtml(image.status)}</span>
        <a href="/?q=${encodeURIComponent(image.title || image.original_name)}">在管理页查看</a>
      </div>
    </div>
  `;
}

async function startUpload() {
  if (!filesState.length) {
    setStatus("先选择文件");
    return;
  }
  $("startButton").disabled = true;
  const skipDuplicates = $("skipDuplicates").checked;
  let finished = 0;
  for (const item of filesState) {
    if (skipDuplicates && item.duplicate) {
      item.status = "skipped";
      item.percent = 100;
      finished += 1;
      renderList();
      continue;
    }
    await uploadOne(item);
    finished += 1;
    setStatus(`已处理 ${finished}/${filesState.length}`);
  }
  $("startButton").disabled = false;
  setStatus("上传任务完成");
}

function uploadOne(item) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    const startedAt = performance.now();
    form.append("files", item.file);
    item.status = "uploading";
    item.error = "";
    renderList();

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.1);
      item.loaded = event.loaded;
      item.percent = (event.loaded / event.total) * 100;
      item.speed = event.loaded / elapsed;
      renderList();
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        item.status = "done";
        item.percent = 100;
      } else {
        item.status = "error";
        item.error = parseError(xhr.responseText) || xhr.statusText;
      }
      renderList();
      resolve();
    };

    xhr.onerror = () => {
      item.status = "error";
      item.error = "网络错误";
      renderList();
      resolve();
    };

    xhr.open("POST", "/api/images/upload");
    xhr.send(form);
  });
}

function parseError(text) {
  try {
    const data = JSON.parse(text);
    return data.detail;
  } catch (_) {
    return text;
  }
}

$("uploadInput").onchange = (event) => chooseFiles(event.target.files);
$("startButton").onclick = startUpload;

const dropZone = $("dropZone");
dropZone.onclick = () => $("uploadInput").click();
dropZone.ondragover = (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
};
dropZone.ondragleave = () => dropZone.classList.remove("dragging");
dropZone.ondrop = (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  chooseFiles(event.dataTransfer.files);
};

renderList();
