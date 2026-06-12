const state = {
  categories: [],
  workGroups: [],
  categoryId: null,
  images: [],
  selectedId: null,
  selectedIds: new Set(),
  searchTokens: [],
  mode: "images",
  view: "list",
  workPicker: null,
  lightbox: {
    image: null,
    zoom: 1,
    infoVisible: false,
  },
};

const PRIORITIES = ["", "高价值", "待验证", "可立即开发"];
const STATUSES = [
  ["new", "新截图"],
  ["reviewing", "已整理"],
  ["ready", "可开发"],
  ["developing", "开发中"],
  ["done", "已完成"],
];

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
    state.mode = "images";
    state.view = state.view === "image-board" ? "image-board" : "list";
    state.categoryId = null;
    renderCategories();
    updateViewButtons();
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
      state.mode = "images";
      state.view = state.view === "image-board" ? "image-board" : "list";
      state.categoryId = node.id;
      renderCategories();
      updateViewButtons();
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

async function loadWorkGroups() {
  state.workGroups = await api("/api/work-groups");
  renderWorkGroups();
}

function renderWorkGroups() {
  const root = $("workGroupList");
  root.innerHTML = "";
  if (!state.workGroups.length) {
    const empty = document.createElement("div");
    empty.className = "muted-line";
    empty.textContent = "暂无工作项目";
    root.appendChild(empty);
    return;
  }
  for (const group of state.workGroups) {
    const button = document.createElement("button");
    button.className = "tree-button";
    button.innerHTML = `${group.starred ? "★ " : ""}${escapeHtml(group.title)} ${renderPriorityBadges(group)}`;
    button.onclick = () => openWorkGroup(group.id);
    root.appendChild(button);
  }
}

function setView(view) {
  state.view = view;
  if (view === "work-board") {
    state.mode = "workBoard";
    state.categoryId = null;
    renderCategories();
    renderWorkBoard();
    setStatus(`${state.workGroups.length} 个工作项目`);
  } else {
    state.mode = "images";
    loadImages();
  }
  updateViewButtons();
}

function updateViewButtons() {
  $("listViewButton").classList.toggle("primary", state.view === "list");
  $("imageBoardButton").classList.toggle("primary", state.view === "image-board");
  $("workBoardButton").classList.toggle("primary", state.view === "work-board");
}

function renderWorkBoard(resetDetail = true) {
  const grid = $("imageGrid");
  grid.className = "kanban-board";
  grid.innerHTML = "";
  if (resetDetail) {
    $("detailPanel").className = "detail empty";
    $("detailPanel").innerHTML = '<div class="empty-state">选择一个工作项目查看详情</div>';
  }
  for (const [status, label] of STATUSES) {
    const groups = state.workGroups.filter((group) => (group.status || "new") === status);
    const column = document.createElement("section");
    column.className = "kanban-column";
    column.innerHTML = `<h3>${escapeHtml(label)} <span>${groups.length}</span></h3><div class="kanban-items"></div>`;
    const list = column.querySelector(".kanban-items");
    for (const group of groups) list.appendChild(createWorkCard(group));
    grid.appendChild(column);
  }
}

function createWorkCard(group) {
  const card = document.createElement("article");
  card.className = "work-card";
  card.innerHTML = `
    <div class="card-title">${group.starred ? "★ " : ""}${escapeHtml(group.title)}</div>
    <div class="muted-line">${escapeHtml(group.purpose || "无目的")}</div>
    <div class="tag-line">${escapeHtml((group.tags || []).join(", "))}</div>
    <div class="card-meta">
      <span>${escapeHtml(statusLabel(group.status || "new"))}</span>
      <span>${renderPriorityBadges(group)}</span>
    </div>
  `;
  card.onclick = () => openWorkGroup(group.id);
  return card;
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

function addSearchToken(value) {
  const token = value.trim();
  if (!token || state.searchTokens.includes(token)) return;
  state.searchTokens.push(token);
  renderSearchTokens();
}

function renderSearchTokens() {
  const box = $("searchTokens");
  box.innerHTML = "";
  for (const token of state.searchTokens) {
    const chip = document.createElement("button");
    chip.className = "search-token";
    chip.type = "button";
    chip.innerHTML = `${escapeHtml(token)} <span>×</span>`;
    chip.onclick = () => {
      state.searchTokens = state.searchTokens.filter((item) => item !== token);
      renderSearchTokens();
      loadImages();
    };
    box.appendChild(chip);
  }
}

function handleSearchInput(event) {
  const value = event.target.value;
  if (/\s{2,}/.test(value)) {
    const parts = value.split(/\s{2,}/);
    for (const part of parts.slice(0, -1)) addSearchToken(part);
    event.target.value = parts[parts.length - 1] || "";
    loadImages();
    return;
  }
  debounceLoadImages();
}

function handleSearchKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addSearchToken(event.target.value);
  event.target.value = "";
  loadImages();
}

const debounceLoadImages = debounce(loadImages);

async function loadImages() {
  if (state.mode !== "images") return;
  const params = new URLSearchParams();
  if (state.categoryId) params.set("category_id", state.categoryId);
  if ($("statusFilter").value) params.set("status", $("statusFilter").value);
  if ($("priorityFilter").value) params.set("priority", $("priorityFilter").value);
  if ($("starredFilter").checked) params.set("starred", "true");
  const queryTerms = [...state.searchTokens, $("searchInput").value.trim()].filter(Boolean);
  if (queryTerms.length) params.set("q", queryTerms.join("  "));
  if ($("timeSort").value) params.set("sort", $("timeSort").value);
  if ($("noContentFilter").checked) params.set("no_content", "true");
  const data = await api(`/api/images?${params.toString()}`);
  state.images = data.items;
  renderImageCollection();
  setStatus(`${data.total} 张截图`);
}

function renderImageCollection() {
  if (state.view === "image-board") renderImageBoard();
  else renderImages();
}

function renderImages() {
  const grid = $("imageGrid");
  grid.className = "image-grid";
  grid.innerHTML = "";
  for (const image of state.images) {
    grid.appendChild(createImageCard(image));
  }
}

function createImageCard(image) {
  const card = document.createElement("article");
  const isSelected = state.selectedIds.has(image.id);
  card.className = `image-card ${state.selectedId === image.id ? "active" : ""} ${isSelected ? "selected" : ""}`;
  card.onclick = (event) => {
    if (event.target.type === "checkbox") return;
    selectImage(image.id);
  };
  const checked = isSelected ? "checked" : "";
  card.innerHTML = `
    <img src="${image.thumb_url}" alt="${escapeHtml(image.title || image.original_name)}" loading="lazy" />
    <div class="card-body">
      <div class="card-title">${escapeHtml(image.title || image.original_name)}</div>
      <div class="card-meta">
        <span>${escapeHtml(statusLabel(image.status))}</span>
        <span>${renderPriorityBadges(image)}</span>
      </div>
      ${image.ai_status ? `<div class="muted-line">AI：${escapeHtml(image.ai_status)}</div>` : ""}
      <div class="card-select">
        <label><input type="checkbox" ${checked} /> 选择</label>
      </div>
    </div>
  `;
  card.querySelector("input").onchange = (event) => {
    if (event.target.checked) state.selectedIds.add(image.id);
    else state.selectedIds.delete(image.id);
    renderImageCollection();
  };
  card.querySelector("img").onclick = (event) => {
    event.stopPropagation();
    openLightbox(image);
  };
  return card;
}

function renderImageBoard() {
  const grid = $("imageGrid");
  grid.className = "kanban-board";
  grid.innerHTML = "";
  for (const [status, label] of STATUSES) {
    const items = state.images.filter((image) => image.status === status);
    const column = document.createElement("section");
    column.className = "kanban-column";
    column.innerHTML = `<h3>${escapeHtml(label)} <span>${items.length}</span></h3><div class="kanban-items"></div>`;
    const list = column.querySelector(".kanban-items");
    for (const image of items) list.appendChild(createImageCard(image));
    grid.appendChild(column);
  }
}

async function selectImage(id) {
  state.selectedId = id;
  const image = await api(`/api/images/${id}`);
  renderImageCollection();
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
    <img class="detail-image" src="${image.image_url}" alt="${escapeHtml(image.title)}" />
    <form id="detailForm">
      <label>标题<input id="detailTitle" class="control" value="${escapeAttr(image.title)}" /></label>
      <label>分类<select id="detailCategory" class="control">${categoryOptions}</select></label>
      <label>状态
        <select id="detailStatus" class="control">
          ${statusOptions(image.status)}
        </select>
      </label>
      <label>优先级<select id="detailPriority" class="control">${priorityOptions(image.priority)}</select></label>
      <label class="inline-check form-check">
        <input id="detailStarred" type="checkbox" ${image.starred ? "checked" : ""} />
        星标 / 收藏
      </label>
      <div class="muted-line">AI 状态：${escapeHtml(image.ai_status || "未识别")}${image.ai_error ? ` / ${escapeHtml(image.ai_error)}` : ""}</div>
      <label>TAG<input id="detailTags" class="control" value="${escapeAttr((image.tags || []).join(", "))}" /></label>
      <label>内容<textarea id="detailNote" class="control">${escapeHtml(image.note || "")}</textarea></label>
      <label>AI 扩写<textarea id="detailExpanded" class="control">${escapeHtml(image.expanded_note || "")}</textarea></label>
      <div class="actions">
        <button class="button primary" type="submit">保存</button>
        <button id="organizeButton" class="button" type="button">AI 识别</button>
        <button id="expandButton" class="button" type="button">AI 扩写</button>
      </div>
    </form>
  `;
  $("detailForm").onsubmit = async (event) => {
    event.preventDefault();
    await saveDetail(image.id);
  };
  panel.querySelector(".detail-image").onclick = () => openLightbox(image);
  $("organizeButton").onclick = async () => organizeImage(image.id);
  $("expandButton").onclick = async () => expandNote(image.id);
}

async function saveDetail(id) {
  const categoryValue = $("detailCategory").value;
  const payload = {
    title: $("detailTitle").value,
    category_id: categoryValue ? Number(categoryValue) : null,
    status: $("detailStatus").value,
    priority: $("detailPriority").value,
    starred: $("detailStarred").checked,
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

async function organizeImage(id) {
  setStatus("正在 AI 识别");
  try {
    const image = await api(`/api/images/${id}/organize`, { method: "POST", body: JSON.stringify({}) });
    renderDetail(image);
    await loadImages();
    setStatus("AI 识别完成");
  } catch (error) {
    setStatus(error.message);
    await loadImages();
  }
}

async function organizeSelectedImages() {
  if (!state.selectedIds.size) {
    setStatus("先选择图片");
    return;
  }
  const count = state.selectedIds.size;
  if (!confirm(`确定用 AI 整理 ${count} 张图片？`)) return;
  setStatus(`正在 AI 整理 ${count} 张`);
  try {
    const result = await api("/api/images-organize", {
      method: "POST",
      body: JSON.stringify({ ids: [...state.selectedIds] }),
    });
    await loadImages();
    setStatus(result.errors.length ? `完成 ${result.updated} 张，失败 ${result.errors.length} 张` : `AI 整理完成 ${result.updated} 张`);
  } catch (error) {
    setStatus(error.message);
    await loadImages();
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

function selectAllCurrentImages() {
  for (const image of state.images) state.selectedIds.add(image.id);
  renderImageCollection();
  setStatus(`已选择 ${state.selectedIds.size} 张`);
}

function clearImageSelection() {
  state.selectedIds.clear();
  renderImageCollection();
  setStatus("已取消选择");
}

async function deleteSelectedImages() {
  if (!state.selectedIds.size) {
    setStatus("先选择图片");
    return;
  }
  const count = state.selectedIds.size;
  if (!confirm(`确定删除 ${count} 张图片？`)) return;
  try {
    const result = await api("/api/images-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [...state.selectedIds] }),
    });
    state.selectedIds.clear();
    state.selectedId = null;
    await loadImages();
    $("detailPanel").className = "detail empty";
    $("detailPanel").innerHTML = '<div class="empty-state">选择一张截图开始整理</div>';
    setStatus(`已删除 ${result.deleted} 张`);
  } catch (error) {
    setStatus(error.message);
  }
}

function openBatchEditor() {
  if (!state.selectedIds.size) {
    setStatus("先选择图片");
    return;
  }
  const panel = $("detailPanel");
  const categoryOptions = ['<option value="">未分类</option>']
    .concat(
      flattenCategories(state.categories).map((category) => {
        const prefix = "　".repeat(category.depth - 1);
        return `<option value="${category.id}">${prefix}${escapeHtml(category.name)}</option>`;
      })
    )
    .join("");
  panel.className = "detail";
  panel.innerHTML = `
    <form id="batchForm" class="batch-form">
      <h2>批量编辑 ${state.selectedIds.size} 张</h2>
      <label class="inline-check"><input id="applyTitle" type="checkbox" /> 标题</label>
      <input id="batchTitle" class="control" placeholder="批量设置标题" />

      <label class="inline-check"><input id="applyCategory" type="checkbox" /> 分类</label>
      <select id="batchCategory" class="control">${categoryOptions}</select>

      <label class="inline-check"><input id="applyTags" type="checkbox" /> TAG</label>
      <input id="batchTags" class="control" placeholder="tag1, tag2" />
      <select id="batchTagMode" class="control">
        <option value="append">追加 TAG</option>
        <option value="replace">替换 TAG</option>
      </select>

      <label class="inline-check"><input id="applyNote" type="checkbox" /> 内容</label>
      <textarea id="batchNote" class="control" placeholder="批量设置或追加内容"></textarea>
      <select id="batchNoteMode" class="control">
        <option value="append">追加内容</option>
        <option value="replace">替换内容</option>
      </select>

      <button class="button primary" type="submit">应用到选中图片</button>
    </form>
  `;
  $("batchForm").onsubmit = submitBatchEdit;
}

async function submitBatchEdit(event) {
  event.preventDefault();
  const payload = { ids: [...state.selectedIds] };
  if ($("applyTitle").checked) payload.title = $("batchTitle").value;
  if ($("applyCategory").checked) payload.category_id = $("batchCategory").value ? Number($("batchCategory").value) : null;
  if ($("applyTags").checked) {
    payload.tags = $("batchTags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
    payload.tag_mode = $("batchTagMode").value;
  }
  if ($("applyNote").checked) {
    payload.note = $("batchNote").value;
    payload.note_mode = $("batchNoteMode").value;
  }
  try {
    const result = await api("/api/images-bulk", { method: "PATCH", body: JSON.stringify(payload) });
    await loadImages();
    setStatus(`批量更新 ${result.updated} 张`);
  } catch (error) {
    setStatus(error.message);
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

async function startNewWorkGroup() {
  state.mode = "workBuilder";
  state.workPicker = {
    images: [],
    selectedIds: new Set(),
    tags: [],
    dragMode: "add",
  };
  const tags = await api("/api/tags");
  renderWorkBuilder(tags);
  renderWorkPicker();
  setStatus("选择 TAG 后默认全选匹配照片");
}

function renderWorkBuilder(tags) {
  const panel = $("detailPanel");
  const tagOptions = tags.map((tag) => `<option value="${escapeAttr(tag)}">${escapeHtml(tag)}</option>`).join("");
  const groupOptions = state.workGroups
    .map((group) => `<option value="${group.id}">${escapeHtml(group.title)}</option>`)
    .join("");
  panel.className = "detail work-detail";
  panel.innerHTML = `
    <form id="workForm">
      <label>标题<input id="workTitle" class="control" placeholder="工作项目标题" required /></label>
      <label>工作目的<textarea id="workPurpose" class="control" placeholder="这组截图要解决什么问题"></textarea></label>
      <label>状态<select id="workStatus" class="control">${statusOptions("new")}</select></label>
      <label>优先级<select id="workPriority" class="control">${priorityOptions("")}</select></label>
      <label class="inline-check form-check">
        <input id="workStarred" type="checkbox" />
        星标 / 收藏
      </label>
      <label>TAG
        <select id="workTags" class="control" multiple size="${Math.min(Math.max(tags.length, 3), 8)}">${tagOptions}</select>
      </label>
      <label>组合工作组
        <select id="combinedGroups" class="control" multiple size="${Math.min(Math.max(state.workGroups.length, 2), 6)}">${groupOptions}</select>
      </label>
      <label>备注<textarea id="workNotes" class="control"></textarea></label>
      <div class="work-actions">
        <button id="dragAddButton" class="button primary" type="button">框选加入</button>
        <button id="dragRemoveButton" class="button" type="button">框选移除</button>
      </div>
      <div class="selected-count" id="workSelectedCount">已选 0 张</div>
      <button class="button primary" type="submit">确定加入工作组</button>
    </form>
  `;
  $("workTags").onchange = loadWorkPickerImages;
  $("dragAddButton").onclick = () => setDragMode("add");
  $("dragRemoveButton").onclick = () => setDragMode("remove");
  $("workForm").onsubmit = saveWorkGroup;
}

function setDragMode(mode) {
  state.workPicker.dragMode = mode;
  $("dragAddButton").classList.toggle("primary", mode === "add");
  $("dragRemoveButton").classList.toggle("primary", mode === "remove");
  setStatus(mode === "add" ? "框选会加入照片" : "框选会移除照片");
}

async function loadWorkPickerImages() {
  const selectedTags = [...$("workTags").selectedOptions].map((option) => option.value);
  state.workPicker.tags = selectedTags;
  if (!selectedTags.length) {
    state.workPicker.images = [];
    state.workPicker.selectedIds.clear();
    renderWorkPicker();
    setStatus("请选择 TAG");
    return;
  }
  const data = await api("/api/images?page_size=200");
  const images = data.items.filter((image) => image.tags?.some((tag) => selectedTags.includes(tag)));
  state.workPicker.images = images;
  state.workPicker.selectedIds = new Set(images.map((image) => image.id));
  renderWorkPicker();
  setStatus(`${images.length} 张匹配照片，已默认全选`);
}

function renderWorkPicker() {
  const grid = $("imageGrid");
  grid.className = "image-grid work-picker-grid";
  grid.innerHTML = "";
  const picker = state.workPicker;
  if (!picker || !picker.images.length) {
    grid.innerHTML = '<div class="empty-state">选择 TAG 后显示照片</div>';
    updateWorkSelectedCount();
    return;
  }
  for (const image of picker.images) {
    const selected = picker.selectedIds.has(image.id);
    const card = document.createElement("article");
    card.className = `image-card work-pick-card ${selected ? "selected" : ""}`;
    card.dataset.imageId = image.id;
    card.innerHTML = `
      <img src="${image.thumb_url}" alt="${escapeHtml(image.title || image.original_name)}" loading="lazy" />
      <div class="card-body">
        <div class="card-title">${escapeHtml(image.title || image.original_name)}</div>
        <div class="tag-line">${escapeHtml((image.tags || []).join(", "))}</div>
      </div>
    `;
    card.onclick = () => {
      toggleWorkImage(image.id);
      renderWorkPicker();
    };
    card.querySelector("img").onclick = (event) => {
      event.stopPropagation();
      openLightbox(image);
    };
    grid.appendChild(card);
  }
  setupDragSelection(grid);
  updateWorkSelectedCount();
}

function toggleWorkImage(imageId) {
  const selected = state.workPicker.selectedIds;
  if (selected.has(imageId)) selected.delete(imageId);
  else selected.add(imageId);
}

function setupDragSelection(grid) {
  let start = null;
  let box = null;
  grid.onmousedown = (event) => {
    if (event.button !== 0 || !event.target.closest(".image-grid")) return;
    start = { x: event.clientX, y: event.clientY };
    box = document.createElement("div");
    box.className = "selection-box";
    document.body.appendChild(box);
    event.preventDefault();
  };
  window.onmousemove = (event) => {
    if (!start || !box) return;
    const left = Math.min(start.x, event.clientX);
    const top = Math.min(start.y, event.clientY);
    const width = Math.abs(start.x - event.clientX);
    const height = Math.abs(start.y - event.clientY);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  };
  window.onmouseup = () => {
    if (!start || !box) return;
    const boxRect = box.getBoundingClientRect();
    for (const card of grid.querySelectorAll(".work-pick-card")) {
      const rect = card.getBoundingClientRect();
      const overlaps = !(rect.right < boxRect.left || rect.left > boxRect.right || rect.bottom < boxRect.top || rect.top > boxRect.bottom);
      if (!overlaps) continue;
      const imageId = Number(card.dataset.imageId);
      if (state.workPicker.dragMode === "remove") state.workPicker.selectedIds.delete(imageId);
      else state.workPicker.selectedIds.add(imageId);
    }
    box.remove();
    start = null;
    box = null;
    renderWorkPicker();
  };
}

function updateWorkSelectedCount() {
  const count = state.workPicker?.selectedIds?.size || 0;
  const target = $("workSelectedCount");
  if (target) target.textContent = `已选 ${count} 张`;
}

async function saveWorkGroup(event) {
  event.preventDefault();
  const payload = {
    title: $("workTitle").value,
    purpose: $("workPurpose").value,
    notes: $("workNotes").value,
    status: $("workStatus").value,
    priority: $("workPriority").value,
    starred: $("workStarred").checked,
    tags: state.workPicker.tags,
    image_ids: [...state.workPicker.selectedIds],
    combined_group_ids: [...$("combinedGroups").selectedOptions].map((option) => Number(option.value)),
  };
  const group = await api("/api/work-groups", { method: "POST", body: JSON.stringify(payload) });
  await loadWorkGroups();
  renderWorkGroupDetail(group);
  if (state.view === "work-board") renderWorkBoard(false);
  setStatus("工作项目已创建");
}

async function openWorkGroup(groupId) {
  state.mode = "workDetail";
  state.view = state.view === "work-board" ? "work-board" : state.view;
  updateViewButtons();
  const group = await api(`/api/work-groups/${groupId}`);
  renderWorkGroupDetail(group);
}

function renderWorkGroupDetail(group) {
  const grid = $("imageGrid");
  grid.className = "image-grid work-photo-list";
  grid.innerHTML = "";
  for (const image of group.images || []) {
    const card = document.createElement("article");
    card.className = "image-card";
    card.innerHTML = `
      <img src="${image.thumb_url}" alt="${escapeHtml(image.title || image.original_name)}" loading="lazy" />
      <div class="card-body">
        <div class="card-title">${escapeHtml(image.title || image.original_name)}</div>
        <div class="tag-line">${escapeHtml((image.tags || []).join(", "))}</div>
        <div class="note-line">${escapeHtml(image.note || image.expanded_note || "")}</div>
      </div>
    `;
    card.querySelector("img").onclick = () => openLightbox(image);
    grid.appendChild(card);
  }
  const first = group.images?.[0];
  const rest = (group.images || []).slice(1);
  const panel = $("detailPanel");
  panel.className = "detail work-detail";
  panel.innerHTML = `
    <h2>${escapeHtml(group.title)}</h2>
    <div class="priority-row">
      <span class="priority-badge">${escapeHtml(statusLabel(group.status || "new"))}</span>
      ${group.starred ? '<span class="priority-badge starred">★ 星标</span>' : ""}
      ${group.priority ? `<span class="priority-badge">${escapeHtml(group.priority)}</span>` : '<span class="muted-line">未设置优先级</span>'}
    </div>
    <section class="work-section"><strong>目的</strong><p>${escapeHtml(group.purpose || "")}</p></section>
    <section class="work-section"><strong>组合工作组</strong><p>${escapeHtml((group.combined_groups || []).map((item) => item.title).join(", ") || "无")}</p></section>
    <section class="work-section"><strong>TAG</strong><p>${escapeHtml((group.tags || []).join(", "))}</p></section>
    <label>状态<select id="workDetailStatus" class="control">${statusOptions(group.status || "new")}</select></label>
    <label>优先级<select id="workDetailPriority" class="control">${priorityOptions(group.priority)}</select></label>
    <label class="inline-check form-check">
      <input id="workDetailStarred" type="checkbox" ${group.starred ? "checked" : ""} />
      星标 / 收藏
    </label>
    <label>备注<textarea id="workDetailNotes" class="control">${escapeHtml(group.notes || "")}</textarea></label>
    <label>AI 开发方案<textarea id="workAiPlan" class="control plan-textarea">${escapeHtml(group.ai_plan || "")}</textarea></label>
    <button id="generateWorkPlan" class="button" type="button">AI生成开发方案</button>
    <button id="saveWorkNotes" class="button primary">保存工作组</button>
    <section class="work-display">
      ${first ? `<img class="work-large" src="${first.image_url}" alt="${escapeHtml(first.title || first.original_name)}" />` : '<div class="empty-state">没有照片</div>'}
      <div class="work-thumbs">
        ${rest.map((image) => `<img src="${image.thumb_url}" alt="${escapeHtml(image.title || image.original_name)}" />`).join("")}
      </div>
    </section>
  `;
  if (first) panel.querySelector(".work-large").onclick = () => openLightbox(first);
  for (const [index, thumb] of panel.querySelectorAll(".work-thumbs img").entries()) {
    thumb.onclick = () => openLightbox(rest[index]);
  }
  $("saveWorkNotes").onclick = async () => {
    const updated = await api(`/api/work-groups/${group.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        notes: $("workDetailNotes").value,
        ai_plan: $("workAiPlan").value,
        status: $("workDetailStatus").value,
        priority: $("workDetailPriority").value,
        starred: $("workDetailStarred").checked,
      }),
    });
    renderWorkGroupDetail(updated);
    await loadWorkGroups();
    if (state.view === "work-board") renderWorkBoard(false);
    setStatus("备注已保存");
  };
  $("generateWorkPlan").onclick = async () => generateWorkPlan(group.id);
  setStatus(`工作项目：${group.title}`);
}

async function generateWorkPlan(groupId) {
  setStatus("正在生成开发方案");
  try {
    const group = await api(`/api/work-groups/${groupId}/plan`, { method: "POST", body: JSON.stringify({}) });
    renderWorkGroupDetail(group);
    await loadWorkGroups();
    if (state.view === "work-board") renderWorkBoard(false);
    setStatus("开发方案已生成");
  } catch (error) {
    setStatus(error.message);
  }
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

function openLightbox(image) {
  state.lightbox.image = image;
  state.lightbox.zoom = 1;
  state.lightbox.infoVisible = false;

  const title = image.title || image.original_name || "截图";
  const lightbox = $("imageLightbox");
  const img = $("lightboxImage");
  img.src = image.image_url;
  img.alt = title;
  img.style.transform = "scale(1)";
  img.style.cursor = "zoom-in";

  $("lightboxDownload").href = image.image_url;
  $("lightboxDownload").download = downloadName(image);
  $("lightboxOriginal").href = image.image_url;
  renderLightboxInfo();
  $("lightboxInfo").hidden = true;
  lightbox.hidden = false;
  document.body.classList.add("lightbox-open");
}

function closeLightbox() {
  $("imageLightbox").hidden = true;
  $("lightboxImage").src = "";
  $("lightboxInfo").hidden = true;
  state.lightbox.image = null;
  state.lightbox.zoom = 1;
  state.lightbox.infoVisible = false;
  document.body.classList.remove("lightbox-open");
}

function toggleLightboxInfo() {
  if (!state.lightbox.image) return;
  state.lightbox.infoVisible = !state.lightbox.infoVisible;
  $("lightboxInfo").hidden = !state.lightbox.infoVisible;
}

function renderLightboxInfo() {
  const image = state.lightbox.image;
  if (!image) return;
  const tags = (image.tags || []).join(", ") || "无";
  const dimensions = image.width && image.height ? `${image.width} × ${image.height}` : "未知";
  $("lightboxInfo").innerHTML = `
    <h2>${escapeHtml(image.title || image.original_name || "截图")}</h2>
    <dl>
      <dt>文件名</dt><dd>${escapeHtml(image.original_name || image.filename || "")}</dd>
      <dt>状态</dt><dd>${escapeHtml(image.status || "")}</dd>
      <dt>星标</dt><dd>${image.starred ? "是" : "否"}</dd>
      <dt>优先级</dt><dd>${escapeHtml(image.priority || "未设置")}</dd>
      <dt>尺寸</dt><dd>${escapeHtml(dimensions)}</dd>
      <dt>大小</dt><dd>${escapeHtml(formatBytes(image.size || 0))}</dd>
      <dt>原始大小</dt><dd>${escapeHtml(formatBytes(image.source_size || 0))}</dd>
      <dt>TAG</dt><dd>${escapeHtml(tags)}</dd>
    </dl>
    <p>${escapeHtml(image.note || image.expanded_note || "没有内容标注")}</p>
  `;
}

function zoomLightbox(event) {
  if (!state.lightbox.image) return;
  event.preventDefault();
  const delta = event.deltaY < 0 ? 0.15 : -0.15;
  state.lightbox.zoom = Math.min(5, Math.max(0.4, state.lightbox.zoom + delta));
  $("lightboxImage").style.transform = `scale(${state.lightbox.zoom})`;
  $("lightboxImage").style.cursor = state.lightbox.zoom > 1 ? "zoom-out" : "zoom-in";
}

function handleLightboxKeydown(event) {
  if (event.key === "Escape" && !$("imageLightbox").hidden) {
    closeLightbox();
  }
}

function downloadName(image) {
  const name = image.title || image.original_name || image.filename || "screenwork-image";
  return `${name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\.(png|jpg|jpeg|webp)$/i, "")}.jpg`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function priorityOptions(value = "") {
  return PRIORITIES.map((priority) => {
    const label = priority || "未设置";
    return `<option value="${escapeAttr(priority)}" ${value === priority ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function statusOptions(value = "new") {
  return STATUSES.map(([status, label]) => (
    `<option value="${escapeAttr(status)}" ${value === status ? "selected" : ""}>${escapeHtml(label)}</option>`
  )).join("");
}

function statusLabel(value = "new") {
  return STATUSES.find(([status]) => status === value)?.[1] || value;
}

function renderPriorityBadges(item) {
  const badges = [];
  if (item.starred) badges.push('<span class="priority-badge starred">★</span>');
  if (item.priority) badges.push(`<span class="priority-badge">${escapeHtml(item.priority)}</span>`);
  return badges.join("");
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
$("newWorkButton").onclick = startNewWorkGroup;
$("refreshButton").onclick = loadImages;
$("cancelSelectionButton").onclick = clearImageSelection;
$("deleteSelectedButton").onclick = deleteSelectedImages;
$("organizeSelectedButton").onclick = organizeSelectedImages;
$("exportButton").onclick = exportSelected;
$("listViewButton").onclick = () => setView("list");
$("imageBoardButton").onclick = () => setView("image-board");
$("workBoardButton").onclick = () => setView("work-board");
$("settingsButton").onclick = openSettings;
$("saveSettingsButton").onclick = saveSettings;
$("statusFilter").onchange = loadImages;
$("timeSort").onchange = loadImages;
$("priorityFilter").onchange = loadImages;
$("starredFilter").onchange = loadImages;
$("noContentFilter").onchange = loadImages;
$("searchInput").oninput = handleSearchInput;
$("searchInput").onkeydown = handleSearchKeydown;
$("lightboxClose").onclick = closeLightbox;
$("lightboxInfoButton").onclick = toggleLightboxInfo;
$("lightboxImage").onwheel = zoomLightbox;
$("lightboxImage").onclick = (event) => event.stopPropagation();
$("lightboxStage").onclick = closeLightbox;
document.addEventListener("keydown", handleLightboxKeydown);
updateViewButtons();

Promise.all([loadCategories(), loadWorkGroups(), loadImages()]).catch((error) => setStatus(error.message));
