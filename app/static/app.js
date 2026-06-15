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
  annotation: {
    image: null,
    items: [],
    tool: "box",
    color: "#f97316",
    drawing: null,
  },
  compareImageId: null,
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
    state.view = ["image-board", "timeline"].includes(state.view) ? state.view : "list";
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
      state.view = ["image-board", "timeline"].includes(state.view) ? state.view : "list";
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
  $("timelineViewButton").classList.toggle("primary", state.view === "timeline");
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
  if (state.view === "timeline") {
    params.set("timeline", "true");
    params.set("page_size", "200");
  }
  if ($("noContentFilter").checked) params.set("no_content", "true");
  const data = await api(`/api/images?${params.toString()}`);
  state.images = data.items;
  renderImageCollection();
  setStatus(`${data.total} 张截图`);
}

function renderImageCollection() {
  if (state.view === "image-board") renderImageBoard();
  else if (state.view === "timeline") renderTimeline();
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

function renderTimeline() {
  const grid = $("imageGrid");
  grid.className = "timeline";
  grid.innerHTML = "";
  const images = [...state.images].sort((a, b) => {
    const left = new Date(timelineTime(a)).getTime() || 0;
    const right = new Date(timelineTime(b)).getTime() || 0;
    return $("timeSort").value === "oldest" ? left - right : right - left;
  });
  if (!images.length) {
    grid.innerHTML = '<div class="empty-state">没有时间线内容</div>';
    return;
  }
  const groups = new Map();
  for (const image of images) {
    const key = timelineDateLabel(image);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(image);
  }
  for (const [label, items] of groups) {
    const section = document.createElement("section");
    section.className = "timeline-day";
    section.innerHTML = `
      <div class="timeline-head">
        <h3>${escapeHtml(label)}</h3>
        <span>${items.length} 张</span>
      </div>
      <div class="timeline-items"></div>
    `;
    const list = section.querySelector(".timeline-items");
    for (const image of items) {
      const item = document.createElement("div");
      item.className = "timeline-item";
      item.innerHTML = `
        <div class="timeline-time">
          <strong>${escapeHtml(timelineClockLabel(image))}</strong>
          <span>${image.source_time ? "来源时间" : "上传时间"}</span>
        </div>
      `;
      item.appendChild(createImageCard(image));
      list.appendChild(item);
    }
    grid.appendChild(section);
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
    <form id="detailForm">
      <div class="detail-editor">
        <section class="detail-preview-panel">
          <div class="detail-image-wrap">
            <img class="detail-image" src="${image.image_url}" alt="${escapeHtml(image.title)}" />
            <svg class="detail-annotation-svg annotation-overlay"></svg>
          </div>
        </section>
        <section class="detail-main-panel">
          <label>标题<input id="detailTitle" class="control" value="${escapeAttr(image.title)}" /></label>
          <div class="detail-main-grid">
            <label>分类<select id="detailCategory" class="control">${categoryOptions}</select></label>
            <label>优先级<select id="detailPriority" class="control">${priorityOptions(image.priority)}</select></label>
            <label>状态
              <select id="detailStatus" class="control">
                ${statusOptions(image.status)}
              </select>
            </label>
          </div>
          <label>TAG
            <div id="detailTags" class="tag-input" data-placeholder="输入 TAG 后按两个空格确认"></div>
          </label>
          <div class="detail-section">
            <h3>来源记录</h3>
            <div class="source-record-grid">
              <label>来源时间<input id="detailSourceTime" class="control" type="datetime-local" value="${escapeAttr(toDateTimeLocalValue(image.source_time))}" /></label>
              <label>视频链接<input id="detailSourceUrl" class="control" type="url" value="${escapeAttr(image.source_url || "")}" placeholder="https://..." /></label>
              <label>平台<input id="detailSourcePlatform" class="control" value="${escapeAttr(image.source_platform || "")}" placeholder="抖音 / 小红书 / B站" /></label>
              <label>作者<input id="detailSourceAuthor" class="control" value="${escapeAttr(image.source_author || "")}" /></label>
              <label>关键词<input id="detailSourceKeywords" class="control" value="${escapeAttr(image.source_keywords || "")}" placeholder="逗号或空格分隔" /></label>
              <label class="inline-check form-check">
                <input id="detailStarred" type="checkbox" ${image.starred ? "checked" : ""} />
                星标 / 收藏
              </label>
            </div>
          </div>
          <div class="detail-meta-line">
            <span>AI：${escapeHtml(image.ai_status || "未识别")}${image.ai_error ? ` / ${escapeHtml(image.ai_error)}` : ""}</span>
            <span>局部标注：${(image.annotations || []).length} 个</span>
          </div>
          <label>内容<textarea id="detailNote" class="control detail-note">${escapeHtml(image.note || "")}</textarea></label>
          <label>AI 扩写<textarea id="detailExpanded" class="control detail-expanded">${escapeHtml(image.expanded_note || "")}</textarea></label>
          <div class="actions detail-actions">
            <button class="button primary" type="submit">保存</button>
            <button id="organizeButton" class="button" type="button">AI 识别</button>
            <button id="compareModelsButton" class="button" type="button">多模型对比</button>
            <button id="expandButton" class="button" type="button">AI 扩写</button>
            <button id="annotateButton" class="button" type="button">图片标注</button>
          </div>
        </section>
      </div>
    </form>
  `;
  $("detailForm").onsubmit = async (event) => {
    event.preventDefault();
    await saveDetail(image.id);
  };
  const detailImage = panel.querySelector(".detail-image");
  const detailSvg = panel.querySelector(".detail-annotation-svg");
  detailImage.onclick = () => openLightbox(image);
  detailImage.onload = () => renderAnnotationOverlay(detailSvg, image.annotations || []);
  renderAnnotationOverlay(detailSvg, image.annotations || []);
  initTagInput($("detailTags"), image.tags || []);
  $("organizeButton").onclick = async () => organizeImage(image.id);
  $("compareModelsButton").onclick = async () => compareImageModels(image.id);
  $("expandButton").onclick = async () => expandNote(image.id);
  $("annotateButton").onclick = () => openAnnotationEditor(image);
}

async function saveDetail(id) {
  const categoryValue = $("detailCategory").value;
  const payload = {
    title: $("detailTitle").value,
    category_id: categoryValue ? Number(categoryValue) : null,
    source_time: $("detailSourceTime").value,
    source_url: $("detailSourceUrl").value,
    source_platform: $("detailSourcePlatform").value,
    source_author: $("detailSourceAuthor").value,
    source_keywords: $("detailSourceKeywords").value,
    status: $("detailStatus").value,
    priority: $("detailPriority").value,
    starred: $("detailStarred").checked,
    tags: getTagInputValues($("detailTags")),
    note: $("detailNote").value,
    expanded_note: $("detailExpanded").value,
    annotations: state.annotation.image?.id === id ? state.annotation.items : undefined,
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

async function compareImageModels(id) {
  state.compareImageId = id;
  $("modelCompareStatus").textContent = "正在调用多个模型";
  $("modelCompareList").innerHTML = "";
  $("modelCompareDialog").showModal();
  setStatus("正在多模型对比");
  try {
    const result = await api(`/api/images/${id}/compare`, { method: "POST", body: JSON.stringify({}) });
    renderModelCompareResults(result.candidates || []);
    const failures = (result.candidates || []).filter((item) => item.error).length;
    setStatus(failures ? `多模型对比完成，失败 ${failures} 个` : "多模型对比完成");
  } catch (error) {
    $("modelCompareStatus").textContent = error.message;
    setStatus(error.message);
  }
}

function renderModelCompareResults(candidates) {
  $("modelCompareStatus").textContent = candidates.length ? `${candidates.length} 个模型结果` : "没有候选结果";
  $("modelCompareList").innerHTML = candidates
    .map((candidate) => {
      if (candidate.error) {
        return `
          <article class="compare-card failed">
            <h3>${escapeHtml(candidate.model || "未知模型")}</h3>
            <p>${escapeHtml(candidate.error)}</p>
          </article>
        `;
      }
      return `
        <article class="compare-card">
          <header>
            <h3>${escapeHtml(candidate.model)}</h3>
            <button class="button primary apply-candidate-button" type="button" data-id="${candidate.id}">采用</button>
          </header>
          <dl>
            <dt>标题</dt><dd>${escapeHtml(candidate.title || "")}</dd>
            <dt>优先级</dt><dd>${escapeHtml(candidate.priority || "未设置")}</dd>
            <dt>TAG</dt><dd>${escapeHtml((candidate.tags || []).join(", "))}</dd>
          </dl>
          <section><strong>摘要</strong><p>${escapeHtml(candidate.summary || "")}</p></section>
          <section><strong>可开发点子</strong><p>${escapeHtml(candidate.idea || "")}</p></section>
        </article>
      `;
    })
    .join("");
  document.querySelectorAll(".apply-candidate-button").forEach((button) => {
    button.onclick = () => applyModelCandidate(Number(button.dataset.id));
  });
}

async function applyModelCandidate(candidateId) {
  if (!state.compareImageId) return;
  setStatus("正在采用模型结果");
  try {
    const image = await api(`/api/images/${state.compareImageId}/candidates/${candidateId}/apply`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    renderDetail(image);
    await loadImages();
    $("modelCompareDialog").close();
    setStatus("已采用模型结果");
  } catch (error) {
    $("modelCompareStatus").textContent = error.message;
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
      <div id="batchTags" class="tag-input" data-placeholder="输入 TAG 后按两个空格确认"></div>
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
  initTagInput($("batchTags"), []);
  $("batchForm").onsubmit = submitBatchEdit;
}

async function submitBatchEdit(event) {
  event.preventDefault();
  const payload = { ids: [...state.selectedIds] };
  if ($("applyTitle").checked) payload.title = $("batchTitle").value;
  if ($("applyCategory").checked) payload.category_id = $("batchCategory").value ? Number($("batchCategory").value) : null;
  if ($("applyTags").checked) {
    payload.tags = getTagInputValues($("batchTags"));
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
  const format = $("exportFormat").value;
  setStatus("正在生成导出文件");
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [...state.selectedIds], format }),
  });
  if (!response.ok) {
    let message = "导出失败";
    try {
      const data = await response.json();
      message = data.detail || message;
    } catch (_) {
      // Keep fallback message.
    }
    setStatus(message);
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = responseFilename(response) || `screenwork-export-${Date.now()}.${exportExtension(format)}`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`${exportFormatLabel(format)} 导出完成`);
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
  $("metapiModels").value = settings.metapi_models || (settings.recommended_image_models || []).join("\n");
  $("metapiCompareModels").value = settings.metapi_compare_models || (settings.recommended_image_models || []).slice(0, 3).join("\n");
  $("metapiProvider").value = settings.metapi_provider || "openai";
  $("metapiApiKey").value = "";
  $("settingsDialog").showModal();
  await loadBackups();
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        metapi_base_url: $("metapiBaseUrl").value,
        metapi_model: $("metapiModel").value,
        metapi_models: $("metapiModels").value,
        metapi_compare_models: $("metapiCompareModels").value,
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

async function loadBackups() {
  try {
    const data = await api("/api/backups");
    renderBackups(data.backups || []);
  } catch (error) {
    $("backupStatus").textContent = error.message;
  }
}

function renderBackups(backups) {
  const list = $("backupList");
  if (!backups.length) {
    list.innerHTML = `<div class="empty-line">还没有备份</div>`;
    return;
  }
  list.innerHTML = backups
    .map(
      (backup) => `
        <div class="backup-row">
          <div>
            <strong>${escapeHtml(backup.name)}</strong>
            <span>${escapeHtml(formatBytes(backup.size || 0))} · ${escapeHtml(formatDateTime(backup.created_at))}</span>
          </div>
          <a class="small-button" href="${escapeAttr(backup.download_url)}">下载</a>
        </div>
      `,
    )
    .join("");
}

async function createLocalBackup() {
  $("backupStatus").textContent = "正在创建备份";
  try {
    const backup = await api("/api/backups", { method: "POST", body: JSON.stringify({}) });
    $("backupStatus").textContent = `已创建 ${backup.name}`;
    await loadBackups();
    setStatus("备份已创建");
  } catch (error) {
    $("backupStatus").textContent = error.message;
    setStatus(error.message);
  }
}

async function restoreLocalBackup() {
  const file = $("restoreInput").files[0];
  if (!file) {
    $("backupStatus").textContent = "请选择 ZIP 备份文件";
    return;
  }
  if (!confirm("恢复会用备份覆盖当前数据库和图片文件。系统会先自动创建一份安全备份，确定继续？")) {
    return;
  }
  const form = new FormData();
  form.append("file", file);
  $("backupStatus").textContent = "正在恢复备份";
  try {
    const result = await api("/api/restore", { method: "POST", body: form });
    $("backupStatus").textContent = `恢复完成，安全备份：${result.safety_backup}`;
    $("restoreInput").value = "";
    await Promise.all([loadCategories(), loadWorkGroups(), loadImages(), loadBackups()]);
    setStatus("备份已恢复");
  } catch (error) {
    $("backupStatus").textContent = error.message;
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
  const wrap = $("lightboxImageWrap");
  img.src = image.image_url;
  img.alt = title;
  wrap.style.transform = "scale(1)";
  img.style.cursor = "zoom-in";
  img.onload = () => renderAnnotationOverlay($("lightboxAnnotationSvg"), image.annotations || []);
  renderAnnotationOverlay($("lightboxAnnotationSvg"), image.annotations || []);

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
  $("lightboxAnnotationSvg").innerHTML = "";
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
      <dt>状态</dt><dd>${escapeHtml(statusLabel(image.status || "new"))}</dd>
      <dt>上传时间</dt><dd>${escapeHtml(formatDateTime(image.created_at))}</dd>
      <dt>来源时间</dt><dd>${escapeHtml(image.source_time ? formatDateTime(image.source_time) : "未填写")}</dd>
      <dt>来源链接</dt><dd>${sourceLinkHtml(image.source_url)}</dd>
      <dt>平台</dt><dd>${escapeHtml(image.source_platform || "未填写")}</dd>
      <dt>作者</dt><dd>${escapeHtml(image.source_author || "未填写")}</dd>
      <dt>关键词</dt><dd>${escapeHtml(image.source_keywords || "未填写")}</dd>
      <dt>局部标注</dt><dd>${(image.annotations || []).length} 个</dd>
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

function openAnnotationEditor(image) {
  state.annotation.image = image;
  state.annotation.items = JSON.parse(JSON.stringify(image.annotations || []));
  state.annotation.tool = "box";
  state.annotation.color = "#f97316";
  state.annotation.drawing = null;
  $("annotationImage").src = image.image_url;
  $("annotationTextInput").value = "";
  $("annotationColor").value = state.annotation.color;
  $("annotationEditor").hidden = false;
  setAnnotationTool("box");
  renderAnnotationList();
  $("annotationImage").onload = renderAnnotationSvg;
  setTimeout(renderAnnotationSvg, 0);
}

function closeAnnotationEditor() {
  $("annotationEditor").hidden = true;
  state.annotation.image = null;
  state.annotation.items = [];
  state.annotation.drawing = null;
}

function setAnnotationTool(tool) {
  state.annotation.tool = tool;
  $("annotationBoxTool").classList.toggle("primary", tool === "box");
  $("annotationArrowTool").classList.toggle("primary", tool === "arrow");
  $("annotationTextTool").classList.toggle("primary", tool === "text");
}

function setAnnotationColor(value) {
  state.annotation.color = annotationColor({ color: value });
}

function annotationPoint(event) {
  const rect = $("annotationSvg").getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function startAnnotation(event) {
  if (!state.annotation.image) return;
  const point = annotationPoint(event);
  const text = $("annotationTextInput").value.trim();
  const color = $("annotationColor").value || state.annotation.color;
  if (state.annotation.tool === "text") {
    state.annotation.items.push({ type: "text", x: point.x, y: point.y, text: text || "文字备注", color });
    $("annotationTextInput").value = "";
    renderAnnotationEditor();
    return;
  }
  state.annotation.drawing = {
    type: state.annotation.tool,
    start: point,
    current: point,
    text,
    color,
  };
}

function moveAnnotation(event) {
  if (!state.annotation.drawing) return;
  state.annotation.drawing.current = annotationPoint(event);
  renderAnnotationSvg();
}

function finishAnnotation() {
  const drawing = state.annotation.drawing;
  if (!drawing) return;
  state.annotation.drawing = null;
  const { start, current } = drawing;
  if (Math.abs(start.x - current.x) < 0.01 && Math.abs(start.y - current.y) < 0.01) {
    renderAnnotationSvg();
    return;
  }
  if (drawing.type === "box") {
    state.annotation.items.push({
      type: "box",
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      w: Math.abs(start.x - current.x),
      h: Math.abs(start.y - current.y),
      text: drawing.text,
      color: drawing.color,
    });
  } else {
    state.annotation.items.push({
      type: "arrow",
      x1: start.x,
      y1: start.y,
      x2: current.x,
      y2: current.y,
      text: drawing.text,
      color: drawing.color,
    });
  }
  $("annotationTextInput").value = "";
  renderAnnotationEditor();
}

function renderAnnotationEditor() {
  renderAnnotationSvg();
  renderAnnotationList();
}

function renderAnnotationSvg() {
  const svg = $("annotationSvg");
  positionAnnotationSvg();
  const rect = svg.getBoundingClientRect();
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  const items = [...state.annotation.items];
  if (state.annotation.drawing) items.push(annotationDraft(state.annotation.drawing));
  renderAnnotationOverlay(svg, items, { editable: true });
}

function positionAnnotationSvg() {
  const image = $("annotationImage");
  const svg = $("annotationSvg");
  const rect = image.getBoundingClientRect();
  const parentRect = image.parentElement.getBoundingClientRect();
  Object.assign(svg.style, {
    left: `${rect.left - parentRect.left}px`,
    top: `${rect.top - parentRect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function annotationDraft(drawing) {
  const { start, current, text, type, color } = drawing;
  if (type === "box") {
    return {
      type,
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      w: Math.abs(start.x - current.x),
      h: Math.abs(start.y - current.y),
      text,
      color,
    };
  }
  return { type, x1: start.x, y1: start.y, x2: current.x, y2: current.y, text, color };
}

function annotationElement(item, width, height) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.classList.add("annotation-shape");
  const color = annotationColor(item);
  group.style.setProperty("--annotation-color", color);
  group.style.setProperty("--annotation-fill", annotationFill(color));
  if (item.type === "box") {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", item.x * width);
    rect.setAttribute("y", item.y * height);
    rect.setAttribute("width", item.w * width);
    rect.setAttribute("height", item.h * height);
    group.appendChild(rect);
    addAnnotationText(group, item.text, item.x * width + 8, item.y * height + 18);
  } else if (item.type === "arrow") {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", item.x1 * width);
    line.setAttribute("y1", item.y1 * height);
    line.setAttribute("x2", item.x2 * width);
    line.setAttribute("y2", item.y2 * height);
    line.setAttribute("marker-end", "url(#arrowHead)");
    group.appendChild(line);
    addAnnotationText(group, item.text, item.x2 * width + 8, item.y2 * height - 8);
  } else {
    addAnnotationText(group, item.text || "文字备注", item.x * width, item.y * height);
  }
  return group;
}

function renderAnnotationOverlay(svg, items, options = {}) {
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  const markerId = options.editable ? "annotationArrowHead" : `annotationArrowHead-${Math.random().toString(36).slice(2)}`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <marker id="${markerId}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill="context-stroke"></path>
      </marker>
    </defs>
  `;
  for (const item of items || []) {
    const element = annotationElement(item, width, height);
    const line = element.querySelector("line");
    if (line) line.setAttribute("marker-end", `url(#${markerId})`);
    svg.appendChild(element);
  }
}

function annotationColor(item) {
  const value = item?.color || "#f97316";
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#f97316";
}

function annotationFill(color) {
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

function addAnnotationText(group, value, x, y) {
  if (!value) return;
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", x);
  text.setAttribute("y", y);
  text.textContent = value;
  group.appendChild(text);
}

function renderAnnotationList() {
  const list = $("annotationList");
  list.innerHTML = "";
  if (!state.annotation.items.length) {
    list.innerHTML = '<div class="muted-line">还没有标注</div>';
    return;
  }
  state.annotation.items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "annotation-row";
    row.innerHTML = `
      <span class="annotation-dot" style="background:${escapeAttr(annotationColor(item))}"></span>
      <span>${index + 1}. ${escapeHtml(annotationTypeLabel(item))}</span>
      <input class="control annotation-row-input" value="${escapeAttr(item.text || "")}" placeholder="备注" />
      <button class="small-button" type="button">×</button>
    `;
    row.querySelector("input").oninput = (event) => {
      item.text = event.target.value;
      renderAnnotationSvg();
    };
    row.querySelector("button").onclick = () => {
      state.annotation.items.splice(index, 1);
      renderAnnotationEditor();
    };
    list.appendChild(row);
  });
}

function annotationTypeLabel(item) {
  return { box: "框", arrow: "箭头", text: "文字" }[item.type] || "标注";
}

function annotationLabel(item) {
  const type = annotationTypeLabel(item);
  return `${type}${item.text ? `：${item.text}` : ""}`;
}

async function saveAnnotations() {
  const image = state.annotation.image;
  if (!image) return;
  try {
    const updated = await api(`/api/images/${image.id}`, {
      method: "PATCH",
      body: JSON.stringify({ annotations: state.annotation.items }),
    });
    closeAnnotationEditor();
    renderDetail(updated);
    await loadImages();
    setStatus("标注已保存");
  } catch (error) {
    setStatus(error.message);
  }
}

function zoomLightbox(event) {
  if (!state.lightbox.image) return;
  event.preventDefault();
  const delta = event.deltaY < 0 ? 0.15 : -0.15;
  state.lightbox.zoom = Math.min(5, Math.max(0.4, state.lightbox.zoom + delta));
  $("lightboxImageWrap").style.transform = `scale(${state.lightbox.zoom})`;
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

function responseFilename(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : "";
}

function exportExtension(format) {
  return { zip: "zip", markdown: "md", excel: "xls", notion: "csv" }[format] || "zip";
}

function exportFormatLabel(format) {
  return { zip: "ZIP", markdown: "Markdown", excel: "Excel", notion: "Notion CSV" }[format] || "文件";
}

function timelineTime(image) {
  return image.source_time || image.created_at || "";
}

function timelineDateLabel(image) {
  const date = parseDate(timelineTime(image));
  if (!date) return "未知时间";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
}

function timelineClockLabel(image) {
  const date = parseDate(timelineTime(image));
  if (!date) return "--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(value) {
  const date = parseDate(value);
  if (!date) return "";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateTimeLocalValue(value) {
  if (!value) return "";
  const date = parseDate(value);
  if (!date) return String(value).slice(0, 16);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
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

function initTagInput(container, values = []) {
  container.dataset.tags = JSON.stringify(uniqueTags(values));
  container.innerHTML = `
    <div class="tag-input-tokens"></div>
    <input class="tag-input-field" autocomplete="off" />
  `;
  const input = container.querySelector(".tag-input-field");
  input.placeholder = container.dataset.placeholder || "";
  input.oninput = () => {
    if (/\s{2,}$/.test(input.value) || input.value.includes(",") || input.value.includes("，")) {
      commitTagInput(container);
    }
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitTagInput(container);
    } else if (event.key === "Backspace" && !input.value) {
      const tags = getTagInputValues(container);
      tags.pop();
      setTagInputValues(container, tags);
    }
  };
  input.onblur = () => commitTagInput(container);
  container.onclick = () => input.focus();
  renderTagInput(container);
}

function uniqueTags(values) {
  const tags = [];
  const seen = new Set();
  for (const value of values || []) {
    for (const part of String(value).split(/[,\uFF0C]|\s{2,}/)) {
      const tag = part.trim();
      const key = tag.toLowerCase();
      if (tag && !seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
    }
  }
  return tags;
}

function getTagInputValues(container) {
  try {
    return JSON.parse(container.dataset.tags || "[]");
  } catch (_) {
    return [];
  }
}

function setTagInputValues(container, tags) {
  container.dataset.tags = JSON.stringify(uniqueTags(tags));
  renderTagInput(container);
}

function commitTagInput(container) {
  const input = container.querySelector(".tag-input-field");
  const nextTags = uniqueTags([...getTagInputValues(container), input.value]);
  input.value = "";
  setTagInputValues(container, nextTags);
}

function renderTagInput(container) {
  const tokens = container.querySelector(".tag-input-tokens");
  const input = container.querySelector(".tag-input-field");
  const tags = getTagInputValues(container);
  tokens.innerHTML = tags
    .map((tag, index) => `
      <button class="tag-token" type="button" data-index="${index}">
        <span>${escapeHtml(tag)}</span>
        <b aria-hidden="true">×</b>
      </button>
    `)
    .join("");
  tokens.querySelectorAll(".tag-token").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.index);
      const nextTags = getTagInputValues(container);
      nextTags.splice(index, 1);
      setTagInputValues(container, nextTags);
      input.focus();
    };
  });
  if (input) input.placeholder = tags.length ? "" : (container.dataset.placeholder || "");
}

function sourceLinkHtml(value) {
  const url = String(value || "").trim();
  if (!url) return "未填写";
  if (!/^https?:\/\//i.test(url)) return escapeHtml(url);
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`;
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
$("timelineViewButton").onclick = () => setView("timeline");
$("workBoardButton").onclick = () => setView("work-board");
$("settingsButton").onclick = openSettings;
$("saveSettingsButton").onclick = saveSettings;
$("createBackupButton").onclick = createLocalBackup;
$("restoreBackupButton").onclick = restoreLocalBackup;
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
$("annotationBoxTool").onclick = () => setAnnotationTool("box");
$("annotationArrowTool").onclick = () => setAnnotationTool("arrow");
$("annotationTextTool").onclick = () => setAnnotationTool("text");
$("annotationUndo").onclick = () => {
  state.annotation.items.pop();
  renderAnnotationEditor();
};
$("annotationSave").onclick = saveAnnotations;
$("annotationClose").onclick = closeAnnotationEditor;
$("annotationColor").oninput = (event) => setAnnotationColor(event.target.value);
$("annotationSvg").onpointerdown = startAnnotation;
$("annotationSvg").onpointermove = moveAnnotation;
$("annotationSvg").onpointerup = finishAnnotation;
$("annotationSvg").onpointerleave = finishAnnotation;
window.addEventListener("resize", renderAnnotationSvg);
updateViewButtons();

Promise.all([loadCategories(), loadWorkGroups(), loadImages()]).catch((error) => setStatus(error.message));
