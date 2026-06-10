const state = {
  categories: [],
  workGroups: [],
  categoryId: null,
  images: [],
  selectedId: null,
  selectedIds: new Set(),
  mode: "images",
  workPicker: null,
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
    state.mode = "images";
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
      state.mode = "images";
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
    button.textContent = group.title;
    button.onclick = () => openWorkGroup(group.id);
    root.appendChild(button);
  }
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
  if (state.mode !== "images") return;
  const params = new URLSearchParams();
  if (state.categoryId) params.set("category_id", state.categoryId);
  if ($("statusFilter").value) params.set("status", $("statusFilter").value);
  if ($("searchInput").value.trim()) params.set("q", $("searchInput").value.trim());
  if ($("tagFilter").value.trim()) params.set("tag", $("tagFilter").value.trim().toLowerCase());
  if ($("timeSort").value) params.set("sort", $("timeSort").value);
  if ($("noContentFilter").checked) params.set("no_content", "true");
  const data = await api(`/api/images?${params.toString()}`);
  state.images = data.items;
  renderImages();
  setStatus(`${data.total} 张截图`);
}

function renderImages() {
  const grid = $("imageGrid");
  grid.className = "image-grid";
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

function selectAllCurrentImages() {
  for (const image of state.images) state.selectedIds.add(image.id);
  renderImages();
  setStatus(`已选择 ${state.selectedIds.size} 张`);
}

function clearImageSelection() {
  state.selectedIds.clear();
  renderImages();
  setStatus("已取消选择");
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
    tags: state.workPicker.tags,
    image_ids: [...state.workPicker.selectedIds],
    combined_group_ids: [...$("combinedGroups").selectedOptions].map((option) => Number(option.value)),
  };
  const group = await api("/api/work-groups", { method: "POST", body: JSON.stringify(payload) });
  await loadWorkGroups();
  renderWorkGroupDetail(group);
  setStatus("工作项目已创建");
}

async function openWorkGroup(groupId) {
  state.mode = "workDetail";
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
    grid.appendChild(card);
  }
  const first = group.images?.[0];
  const rest = (group.images || []).slice(1);
  const panel = $("detailPanel");
  panel.className = "detail work-detail";
  panel.innerHTML = `
    <h2>${escapeHtml(group.title)}</h2>
    <section class="work-section"><strong>目的</strong><p>${escapeHtml(group.purpose || "")}</p></section>
    <section class="work-section"><strong>组合工作组</strong><p>${escapeHtml((group.combined_groups || []).map((item) => item.title).join(", ") || "无")}</p></section>
    <section class="work-section"><strong>TAG</strong><p>${escapeHtml((group.tags || []).join(", "))}</p></section>
    <label>备注<textarea id="workDetailNotes" class="control">${escapeHtml(group.notes || "")}</textarea></label>
    <button id="saveWorkNotes" class="button primary">保存备注</button>
    <section class="work-display">
      ${first ? `<img class="work-large" src="${first.image_url}" alt="${escapeHtml(first.title || first.original_name)}" />` : '<div class="empty-state">没有照片</div>'}
      <div class="work-thumbs">
        ${rest.map((image) => `<img src="${image.thumb_url}" alt="${escapeHtml(image.title || image.original_name)}" />`).join("")}
      </div>
    </section>
  `;
  $("saveWorkNotes").onclick = async () => {
    const updated = await api(`/api/work-groups/${group.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notes: $("workDetailNotes").value }),
    });
    renderWorkGroupDetail(updated);
    await loadWorkGroups();
    setStatus("备注已保存");
  };
  setStatus(`工作项目：${group.title}`);
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
$("newWorkButton").onclick = startNewWorkGroup;
$("refreshButton").onclick = loadImages;
$("selectAllButton").onclick = selectAllCurrentImages;
$("clearSelectionButton").onclick = clearImageSelection;
$("batchEditButton").onclick = openBatchEditor;
$("exportButton").onclick = exportSelected;
$("settingsButton").onclick = openSettings;
$("saveSettingsButton").onclick = saveSettings;
$("statusFilter").onchange = loadImages;
$("timeSort").onchange = loadImages;
$("noContentFilter").onchange = loadImages;
$("searchInput").oninput = debounce(loadImages);
$("tagFilter").oninput = debounce(loadImages);

Promise.all([loadCategories(), loadWorkGroups(), loadImages()]).catch((error) => setStatus(error.message));
