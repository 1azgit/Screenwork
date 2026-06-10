const state = {
  categories: [],
  categoryId: null,
  images: [],
  selectedId: null,
  selectedIds: new Set(),
};

const $ = (id) => document.getElementById(id);

function setStatus(message) {
  $("statusText").textContent = message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const data = await response.json();
      detail = data.detail || detail;
    } catch (_) {
      // Keep response status text when no JSON body exists.
    }
    throw new Error(detail);
  }
  return response.json();
}

function flattenCategories(nodes, depth = 1, list = []) {
  for (const node of nodes) {
    list.push({ ...node, depth });
    flattenCategories(node.children || [], depth + 1, list);
  }
  return list;
}

async function loadCategories() {
  state.categories = await api("/api/categories");
  renderCategories();
}

function renderCategories() {
  const root = $("categoryTree");
  root.innerHTML = "";
  const all = document.createElement("button");
  all.className = `tree-button ${state.categoryId === null ? "active" : ""}`;
  all.textContent = "全部截图";
  all.onclick = () => {
    state.categoryId = null;
    renderCategories();
    loadImages();
  };
  root.appendChild(all);

  const renderNode = (node, depth) => {
    const item = document.createElement("div");
    item.className = "tree-item";
    const row = document.createElement("div");
    row.className = "tree-row";
    const button = document.createElement("button");
    button.className = `tree-button ${state.categoryId === node.id ? "active" : ""}`;
    button.style.paddingLeft = `${8 + (depth - 1) * 8}px`;
    button.textContent = node.name;
    button.onclick = () => {
      state.categoryId = node.id;
      renderCategories();
      loadImages();
    };
    const add = document.createElement("button");
    add.className = "small-button";
    add.textContent = "+";
    add.disabled = depth >= 3;
    add.onclick = () => createCategory(node.id);
    row.append(button, add);
    item.appendChild(row);
    if (node.children?.length) {
      const children = document.createElement("div");
      children.className = "children";
      for (const child of node.children) children.appendChild(renderNode(child, depth + 1));
      item.appendChild(children);
    }
    return item;
  };

  for (const node of state.categories) root.appendChild(renderNode(node, 1));
}

async function createCategory(parentId = null) {
  const name = prompt("分类名称");
  if (!name) return;
  try {
    await api("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name, parent_id: parentId }),
    });
    await loadCategories();
    setStatus("分类已创建");
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadImages() {
  const params = new URLSearchParams();
  if (state.categoryId) params.set("category_id", state.categoryId);
  if ($("statusFilter").value) params.set("status", $("statusFilter").value);
  if ($("searchInput").value.trim()) params.set("q", $("searchInput").value.trim());
  if ($("tagFilter").value.trim()) params.set("tag", $("tagFilter").value.trim().toLowerCase());
  const data = await api(`/api/images?${params.toString()}`);
  state.images = data.items;
  renderImages();
  setStatus(`${data.total} 张截图`);
}

function renderImages() {
  const grid = $("imageGrid");
  grid.innerHTML = "";
  for (const image of state.images) {
    const card = document.createElement("article");
    card.className = `image-card ${state.selectedId === image.id ? "active" : ""}`;
    card.onclick = (event) => {
      if (event.target.type === "checkbox") return;
      selectImage(image.id);
    };
    const checked = state.selectedIds.has(image.id) ? "checked" : "";
    card.innerHTML = `
      <img src="${image.thumb_url}" alt="${escapeHtml(image.title || image.original_name)}" loading="lazy" />
      <div class="card-body">
        <div class="card-title">${escapeHtml(image.title || image.original_name)}</div>
        <div class="card-meta">
          <label><input type="checkbox" ${checked} /> 选择</label>
          <span>${escapeHtml(image.status)}</span>
        </div>
      </div>
    `;
    card.querySelector("input").onchange = (event) => {
      if (event.target.checked) state.selectedIds.add(image.id);
      else state.selectedIds.delete(image.id);
    };
    grid.appendChild(card);
  }
}

async function selectImage(id) {
  state.selectedId = id;
  const image = await api(`/api/images/${id}`);
  renderImages();
  renderDetail(image);
}

function renderDetail(image) {
  const panel = $("detailPanel");
  const categoryOptions = ['<option value="">未分类</option>']
    .concat(
      flattenCategories(state.categories).map((category) => {
        const selected = image.category_id === category.id ? "selected" : "";
        const prefix = "　".repeat(category.depth - 1);
        return `<option value="${category.id}" ${selected}>${prefix}${escapeHtml(category.name)}</option>`;
      })
    )
    .join("");
  panel.className = "detail";
  panel.innerHTML = `
    <img src="${image.image_url}" alt="${escapeHtml(image.title)}" />
    <form id="detailForm">
      <label>标题<input id="detailTitle" class="control" value="${escapeAttr(image.title)}" /></label>
      <label>分类<select id="detailCategory" class="control">${categoryOptions}</select></label>
      <label>状态
        <select id="detailStatus" class="control">
          ${["new", "reviewing", "ready", "done"].map((status) => `<option value="${status}" ${image.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </label>
      <label>TAG<input id="detailTags" class="control" value="${escapeAttr((image.tags || []).join(", "))}" /></label>
      <label>内容<textarea id="detailNote" class="control">${escapeHtml(image.note || "")}</textarea></label>
      <label>AI 扩写<textarea id="detailExpanded" class="control">${escapeHtml(image.expanded_note || "")}</textarea></label>
      <div class="actions">
        <button class="button primary" type="submit">保存</button>
        <button id="expandButton" class="button" type="button">AI 扩写</button>
      </div>
    </form>
  `;
  $("detailForm").onsubmit = async (event) => {
    event.preventDefault();
    await saveDetail(image.id);
  };
  $("expandButton").onclick = async () => expandNote(image.id);
}

async function saveDetail(id) {
  const categoryValue = $("detailCategory").value;
  const payload = {
    title: $("detailTitle").value,
    category_id: categoryValue ? Number(categoryValue) : null,
    status: $("detailStatus").value,
    tags: $("detailTags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
    note: $("detailNote").value,
    expanded_note: $("detailExpanded").value,
  };
  try {
    const image = await api(`/api/images/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    renderDetail(image);
    await loadImages();
    setStatus("已保存");
  } catch (error) {
    setStatus(error.message);
  }
}

async function expandNote(id) {
  setStatus("正在调用 AI");
  try {
    const data = await api(`/api/images/${id}/expand`, { method: "POST", body: JSON.stringify({}) });
    $("detailExpanded").value = data.expanded_note;
    setStatus("AI 扩写完成");
  } catch (error) {
    setStatus(error.message);
  }
}

async function uploadSelected(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("files", file);
  if (state.categoryId) form.append("category_id", state.categoryId);
  setStatus("上传中");
  try {
    await api("/api/images/upload", { method: "POST", body: form });
    await loadImages();
    setStatus("上传完成");
  } catch (error) {
    setStatus(error.message);
  } finally {
    $("uploadInput").value = "";
  }
}

async function exportSelected() {
  if (!state.selectedIds.size) {
    setStatus("先选择图片");
    return;
  }
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [...state.selectedIds] }),
  });
  if (!response.ok) {
    setStatus("导出失败");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `screenwork-export-${Date.now()}.zip`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("导出完成");
}

async function openSettings() {
  const settings = await api("/api/settings");
  $("metapiBaseUrl").value = settings.metapi_base_url || "";
  $("metapiModel").value = settings.metapi_model || "";
  $("metapiProvider").value = settings.metapi_provider || "openai";
  $("metapiApiKey").value = "";
  $("settingsDialog").showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        metapi_base_url: $("metapiBaseUrl").value,
        metapi_model: $("metapiModel").value,
        metapi_provider: $("metapiProvider").value,
        metapi_api_key: $("metapiApiKey").value,
      }),
    });
    $("settingsDialog").close();
    setStatus("设置已保存");
  } catch (error) {
    setStatus(error.message);
  }
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

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

$("uploadInput").onchange = (event) => uploadSelected(event.target.files);
$("newRootButton").onclick = () => createCategory(null);
$("refreshButton").onclick = loadImages;
$("exportButton").onclick = exportSelected;
$("settingsButton").onclick = openSettings;
$("saveSettingsButton").onclick = saveSettings;
$("statusFilter").onchange = loadImages;
$("searchInput").oninput = debounce(loadImages);
$("tagFilter").oninput = debounce(loadImages);

Promise.all([loadCategories(), loadImages()]).catch((error) => setStatus(error.message));
