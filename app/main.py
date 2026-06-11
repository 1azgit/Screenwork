import csv
import io
import json
import os
import re
import sqlite3
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field


APP_TITLE = "Screenwork"
DATA_DIR = Path(os.getenv("SCREENWORK_DATA_DIR", "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
THUMB_DIR = DATA_DIR / "thumbs"
EXPORT_DIR = DATA_DIR / "exports"
DB_PATH = Path(os.getenv("SCREENWORK_DB_PATH", DATA_DIR / "screenwork.db"))
STATIC_DIR = Path(__file__).parent / "static"
ALLOWED_EXTENSIONS = {".png"}
MAX_CATEGORY_DEPTH = 3
PRIORITY_VALUES = {"", "高价值", "待验证", "可立即开发"}


app = FastAPI(title=APP_TITLE)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)


@contextmanager
def db() -> Any:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        yield conn
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def init_db() -> None:
    ensure_dirs()
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL UNIQUE,
                thumb_filename TEXT NOT NULL,
                original_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                source_size INTEGER,
                width INTEGER,
                height INTEGER,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                title TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                expanded_note TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'new',
                priority TEXT NOT NULL DEFAULT '',
                starred INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS image_tags (
                image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (image_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS work_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                purpose TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]',
                combined_group_ids_json TEXT NOT NULL DEFAULT '[]',
                priority TEXT NOT NULL DEFAULT '',
                starred INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS work_group_images (
                work_group_id INTEGER NOT NULL REFERENCES work_groups(id) ON DELETE CASCADE,
                image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (work_group_id, image_id)
            );
            """
        )
        image_columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)").fetchall()}
        if "source_size" not in image_columns:
            conn.execute("ALTER TABLE images ADD COLUMN source_size INTEGER")
        if "priority" not in image_columns:
            conn.execute("ALTER TABLE images ADD COLUMN priority TEXT NOT NULL DEFAULT ''")
        if "starred" not in image_columns:
            conn.execute("ALTER TABLE images ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE images SET source_size = size WHERE source_size IS NULL")
        work_columns = {row["name"] for row in conn.execute("PRAGMA table_info(work_groups)").fetchall()}
        if "priority" not in work_columns:
            conn.execute("ALTER TABLE work_groups ADD COLUMN priority TEXT NOT NULL DEFAULT ''")
        if "starred" not in work_columns:
            conn.execute("ALTER TABLE work_groups ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")


@app.on_event("startup")
def startup() -> None:
    init_db()


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent_id: Optional[int] = None
    sort_order: int = 0


class CategoryPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    parent_id: Optional[int] = None
    sort_order: Optional[int] = None


class ImagePatch(BaseModel):
    title: Optional[str] = None
    note: Optional[str] = None
    expanded_note: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    starred: Optional[bool] = None
    category_id: Optional[int] = None
    tags: Optional[list[str]] = None


class BulkImagePatch(BaseModel):
    ids: list[int] = Field(min_length=1)
    title: Optional[str] = None
    note: Optional[str] = None
    note_mode: str = "replace"
    category_id: Optional[int] = None
    priority: Optional[str] = None
    starred: Optional[bool] = None
    tags: Optional[list[str]] = None
    tag_mode: str = "replace"


class ImageIdsIn(BaseModel):
    ids: list[int] = Field(min_length=1)


class DuplicateCandidate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0)


class DuplicateCheckIn(BaseModel):
    files: list[DuplicateCandidate]


class SettingsPatch(BaseModel):
    metapi_base_url: str = ""
    metapi_model: str = ""
    metapi_provider: str = "openai"
    metapi_api_key: str = ""


class WorkGroupIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    purpose: str = ""
    notes: str = ""
    priority: str = ""
    starred: bool = False
    tags: list[str] = []
    image_ids: list[int] = []
    combined_group_ids: list[int] = []


class WorkGroupPatch(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    purpose: Optional[str] = None
    notes: Optional[str] = None
    priority: Optional[str] = None
    starred: Optional[bool] = None
    tags: Optional[list[str]] = None
    image_ids: Optional[list[int]] = None
    combined_group_ids: Optional[list[int]] = None


def get_category_depth(conn: sqlite3.Connection, category_id: Optional[int]) -> int:
    if category_id is None:
        return 0
    depth = 0
    current_id = category_id
    seen: set[int] = set()
    while current_id is not None:
        if current_id in seen:
            raise HTTPException(status_code=400, detail="Category cycle detected")
        seen.add(current_id)
        row = conn.execute("SELECT id, parent_id FROM categories WHERE id = ?", (current_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Category not found")
        depth += 1
        current_id = row["parent_id"]
    return depth


def build_category_tree(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    nodes = [{**dict(row), "children": []} for row in rows]
    by_id = {node["id"]: node for node in nodes}
    roots: list[dict[str, Any]] = []
    for node in nodes:
        parent_id = node["parent_id"]
        if parent_id and parent_id in by_id:
            by_id[parent_id]["children"].append(node)
        else:
            roots.append(node)
    return roots


def normalize_tags(tags: list[str] | None) -> list[str]:
    if not tags:
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        name = tag.strip().lower()
        if name and name not in seen:
            cleaned.append(name[:40])
            seen.add(name)
    return cleaned


def normalize_priority(priority: str | None) -> str:
    value = (priority or "").strip()
    if value not in PRIORITY_VALUES:
        raise HTTPException(status_code=400, detail="Invalid priority")
    return value


def get_image_tags(conn: sqlite3.Connection, image_id: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT t.name
        FROM tags t
        JOIN image_tags it ON it.tag_id = t.id
        WHERE it.image_id = ?
        ORDER BY t.name
        """,
        (image_id,),
    ).fetchall()
    return [row["name"] for row in rows]


def attach_image_urls(image: dict[str, Any], tags: list[str] | None = None) -> dict[str, Any]:
    image["image_url"] = f"/uploads/{image['filename']}"
    image["thumb_url"] = f"/thumbs/{image['thumb_filename']}"
    image["tags"] = tags or []
    image["starred"] = bool(image.get("starred", 0))
    return image


def find_duplicate_image(conn: sqlite3.Connection, original_name: str, source_size: int) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT *
        FROM images
        WHERE lower(original_name) = lower(?) AND source_size = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (original_name, source_size),
    ).fetchone()
    if not row:
        return None
    image = dict(row)
    return attach_image_urls(image, get_image_tags(conn, image["id"]))


def serialize_work_group(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    include_images: bool = False,
) -> dict[str, Any]:
    group = dict(row)
    group["starred"] = bool(group.get("starred", 0))
    group["tags"] = json.loads(group.pop("tags_json") or "[]")
    combined_ids = json.loads(group.pop("combined_group_ids_json") or "[]")
    group["combined_group_ids"] = combined_ids
    group["combined_groups"] = []
    if combined_ids:
        placeholders = ",".join("?" for _ in combined_ids)
        rows = conn.execute(
            f"SELECT id, title FROM work_groups WHERE id IN ({placeholders}) ORDER BY title",
            combined_ids,
        ).fetchall()
        group["combined_groups"] = [dict(item) for item in rows]
    if include_images:
        rows = conn.execute(
            """
            SELECT i.*
            FROM images i
            JOIN work_group_images wgi ON wgi.image_id = i.id
            WHERE wgi.work_group_id = ?
            ORDER BY wgi.sort_order, i.created_at DESC
            """,
            (group["id"],),
        ).fetchall()
        group["images"] = [attach_image_urls(dict(item), get_image_tags(conn, item["id"])) for item in rows]
    return group


def replace_work_group_images(conn: sqlite3.Connection, group_id: int, image_ids: list[int]) -> None:
    conn.execute("DELETE FROM work_group_images WHERE work_group_id = ?", (group_id,))
    seen: set[int] = set()
    for sort_order, image_id in enumerate(image_ids):
        if image_id in seen:
            continue
        seen.add(image_id)
        conn.execute(
            "INSERT OR IGNORE INTO work_group_images (work_group_id, image_id, sort_order) VALUES (?, ?, ?)",
            (group_id, image_id, sort_order),
        )


def set_image_tags(conn: sqlite3.Connection, image_id: int, tags: list[str]) -> None:
    conn.execute("DELETE FROM image_tags WHERE image_id = ?", (image_id,))
    for name in normalize_tags(tags):
        conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        conn.execute("INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)", (image_id, row["id"]))


def save_thumbnail(source_path: Path, thumb_path: Path) -> tuple[int | None, int | None]:
    with Image.open(source_path) as image:
        width, height = image.size
        image.thumbnail((480, 480))
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGB")
        image.save(thumb_path, format="WEBP", quality=82)
        return width, height


def save_as_jpg(source_bytes: bytes, target_path: Path) -> tuple[int | None, int | None]:
    with Image.open(io.BytesIO(source_bytes)) as image:
        width, height = image.size
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.split()[-1])
            image = background
        elif image.mode != "RGB":
            image = image.convert("RGB")
        image.save(target_path, format="JPEG", quality=80, optimize=True)
        return width, height


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def get_effective_settings() -> dict[str, str]:
    with db() as conn:
        return {
            "metapi_base_url": os.getenv("METAPI_BASE_URL") or get_setting(conn, "metapi_base_url"),
            "metapi_model": os.getenv("METAPI_MODEL") or get_setting(conn, "metapi_model", "gpt-4o-mini"),
            "metapi_provider": os.getenv("METAPI_PROVIDER") or get_setting(conn, "metapi_provider", "openai"),
            "metapi_api_key": os.getenv("METAPI_API_KEY") or get_setting(conn, "metapi_api_key"),
        }


@app.get("/api/health")
def health() -> dict[str, Any]:
    ensure_dirs()
    return {"ok": True, "data_dir": str(DATA_DIR), "port": 26633}


@app.get("/api/categories")
def list_categories() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM categories ORDER BY parent_id IS NOT NULL, sort_order, lower(name)"
        ).fetchall()
        return build_category_tree(rows)


@app.post("/api/categories")
def create_category(payload: CategoryIn) -> dict[str, Any]:
    with db() as conn:
        if get_category_depth(conn, payload.parent_id) >= MAX_CATEGORY_DEPTH:
            raise HTTPException(status_code=400, detail="Category depth cannot exceed 3 levels")
        created_at = now_iso()
        cur = conn.execute(
            "INSERT INTO categories (parent_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)",
            (payload.parent_id, payload.name.strip(), payload.sort_order, created_at),
        )
        row = conn.execute("SELECT * FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


@app.patch("/api/categories/{category_id}")
def update_category(category_id: int, payload: CategoryPatch) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Category not found")
        fields = payload.model_fields_set
        parent_id = payload.parent_id if "parent_id" in fields else row["parent_id"]
        if parent_id == category_id:
            raise HTTPException(status_code=400, detail="Category cannot be its own parent")
        if get_category_depth(conn, parent_id) >= MAX_CATEGORY_DEPTH:
            raise HTTPException(status_code=400, detail="Category depth cannot exceed 3 levels")
        conn.execute(
            """
            UPDATE categories
            SET name = COALESCE(?, name),
                parent_id = ?,
                sort_order = COALESCE(?, sort_order)
            WHERE id = ?
            """,
            (payload.name.strip() if payload.name else None, parent_id, payload.sort_order, category_id),
        )
        updated = conn.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
        return dict(updated)


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: int) -> dict[str, Any]:
    with db() as conn:
        conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
        return {"ok": True}


@app.post("/api/images/check-duplicates")
def check_image_duplicates(payload: DuplicateCheckIn) -> dict[str, Any]:
    with db() as conn:
        items = []
        for candidate in payload.files:
            duplicate = find_duplicate_image(conn, candidate.name, candidate.size)
            items.append(
                {
                    "name": candidate.name,
                    "size": candidate.size,
                    "duplicate": duplicate,
                }
            )
        return {"items": items}


@app.post("/api/images/upload")
async def upload_images(
    files: list[UploadFile] = File(...),
    category_id: Optional[int] = Form(default=None),
) -> dict[str, Any]:
    created: list[dict[str, Any]] = []
    with db() as conn:
        if category_id is not None:
            get_category_depth(conn, category_id)
        for file in files:
            original_name = file.filename or "screenshot"
            ext = Path(original_name).suffix.lower()
            if ext not in ALLOWED_EXTENSIONS or file.content_type not in {"image/png", "image/x-png"}:
                raise HTTPException(status_code=400, detail=f"Only PNG images are supported: {original_name}")

            image_id = uuid.uuid4().hex
            filename = f"{image_id}.jpg"
            thumb_filename = f"{image_id}.webp"
            target = UPLOAD_DIR / filename
            thumb = THUMB_DIR / thumb_filename

            source_bytes = await file.read()
            source_size = len(source_bytes)
            duplicate = find_duplicate_image(conn, original_name, source_size)
            try:
                width, height = save_as_jpg(source_bytes, target)
                save_thumbnail(target, thumb)
            except Exception as exc:
                target.unlink(missing_ok=True)
                thumb.unlink(missing_ok=True)
                raise HTTPException(status_code=400, detail=f"Invalid image file: {original_name}") from exc
            size = target.stat().st_size

            created_at = now_iso()
            cur = conn.execute(
                """
                INSERT INTO images (
                    filename, thumb_filename, original_name, mime_type, size, source_size, width, height,
                    category_id, title, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    filename,
                    thumb_filename,
                    original_name,
                    "image/jpeg",
                    size,
                    source_size,
                    width,
                    height,
                    category_id,
                    Path(original_name).stem[:120],
                    created_at,
                    created_at,
                ),
            )
            row = conn.execute("SELECT * FROM images WHERE id = ?", (cur.lastrowid,)).fetchone()
            created_image = attach_image_urls(dict(row))
            created_image["duplicate"] = duplicate
            created.append(created_image)
    return {"ok": True, "images": created}


@app.get("/api/images")
def list_images(
    category_id: Optional[int] = None,
    status: str = "",
    priority: str = "",
    starred: bool = False,
    tag: str = "",
    q: str = "",
    sort: str = "newest",
    no_content: bool = False,
    page: int = 1,
    page_size: int = 60,
) -> dict[str, Any]:
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    where = []
    params: list[Any] = []
    join = ""
    if category_id is not None:
        where.append("i.category_id = ?")
        params.append(category_id)
    if status:
        where.append("i.status = ?")
        params.append(status)
    if priority:
        where.append("i.priority = ?")
        params.append(normalize_priority(priority))
    if starred:
        where.append("i.starred = 1")
    if q:
        for term in [part.strip().lower() for part in re.split(r"\s{2,}", q) if part.strip()]:
            like = f"%{term}%"
            where.append(
                """
                (
                    lower(i.title) LIKE ?
                    OR lower(i.note) LIKE ?
                    OR lower(i.expanded_note) LIKE ?
                    OR EXISTS (
                        SELECT 1
                        FROM image_tags sit
                        JOIN tags st ON st.id = sit.tag_id
                        WHERE sit.image_id = i.id AND lower(st.name) LIKE ?
                    )
                )
                """
            )
            params.extend([like, like, like, like])
    if no_content:
        where.append("trim(i.note) = '' AND trim(i.expanded_note) = ''")
    if tag:
        join = "JOIN image_tags it ON it.image_id = i.id JOIN tags t ON t.id = it.tag_id"
        where.append("t.name = ?")
        params.append(tag.strip().lower())
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    order_sql = "i.created_at ASC" if sort == "oldest" else "i.created_at DESC"
    offset = (page - 1) * page_size
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT DISTINCT i.*
            FROM images i
            {join}
            {where_sql}
            ORDER BY {order_sql}
            LIMIT ? OFFSET ?
            """,
            (*params, page_size, offset),
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(DISTINCT i.id) AS count FROM images i {join} {where_sql}",
            params,
        ).fetchone()["count"]
        images = []
        for row in rows:
            image = dict(row)
            images.append(attach_image_urls(image, get_image_tags(conn, image["id"])))
        return {"items": images, "total": total, "page": page, "page_size": page_size}


@app.get("/api/images/{image_id}")
def get_image(image_id: int) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")
        return attach_image_urls(dict(row), get_image_tags(conn, image_id))


@app.patch("/api/images/{image_id}")
def update_image(image_id: int, payload: ImagePatch) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")
        fields = payload.model_fields_set
        if "category_id" in fields and payload.category_id is not None:
            get_category_depth(conn, payload.category_id)
        updates = []
        params: list[Any] = []
        for field in ("title", "note", "expanded_note", "status", "priority", "starred", "category_id"):
            if field in fields:
                updates.append(f"{field} = ?")
                value = getattr(payload, field)
                if field == "priority":
                    value = normalize_priority(value)
                elif field == "starred":
                    value = 1 if value else 0
                params.append(value)
        if updates:
            updates.append("updated_at = ?")
            params.extend([now_iso(), image_id])
            conn.execute(f"UPDATE images SET {', '.join(updates)} WHERE id = ?", params)
        if payload.tags is not None:
            set_image_tags(conn, image_id, payload.tags)
        updated = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        return attach_image_urls(dict(updated), get_image_tags(conn, image_id))


@app.patch("/api/images-bulk")
def bulk_update_images(payload: BulkImagePatch) -> dict[str, Any]:
    fields = payload.model_fields_set
    if payload.note_mode not in {"replace", "append"}:
        raise HTTPException(status_code=400, detail="Invalid note_mode")
    if payload.tag_mode not in {"replace", "append"}:
        raise HTTPException(status_code=400, detail="Invalid tag_mode")
    with db() as conn:
        if "category_id" in fields and payload.category_id is not None:
            get_category_depth(conn, payload.category_id)
        changed = 0
        for image_id in payload.ids:
            row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
            if not row:
                continue
            updates = []
            params: list[Any] = []
            if "title" in fields and payload.title is not None:
                updates.append("title = ?")
                params.append(payload.title)
            if "category_id" in fields:
                updates.append("category_id = ?")
                params.append(payload.category_id)
            if "priority" in fields:
                updates.append("priority = ?")
                params.append(normalize_priority(payload.priority))
            if "starred" in fields:
                updates.append("starred = ?")
                params.append(1 if payload.starred else 0)
            if "note" in fields and payload.note is not None:
                next_note = payload.note
                if payload.note_mode == "append" and row["note"]:
                    next_note = f"{row['note']}\n{payload.note}"
                updates.append("note = ?")
                params.append(next_note)
            if updates:
                updates.append("updated_at = ?")
                params.extend([now_iso(), image_id])
                conn.execute(f"UPDATE images SET {', '.join(updates)} WHERE id = ?", params)
            if payload.tags is not None:
                tags = normalize_tags(payload.tags)
                if payload.tag_mode == "append":
                    tags = normalize_tags([*get_image_tags(conn, image_id), *tags])
                set_image_tags(conn, image_id, tags)
            changed += 1
        return {"ok": True, "updated": changed}


@app.post("/api/images-delete")
def delete_images(payload: ImageIdsIn) -> dict[str, Any]:
    deleted = 0
    with db() as conn:
        for image_id in payload.ids:
            row = conn.execute("SELECT filename, thumb_filename FROM images WHERE id = ?", (image_id,)).fetchone()
            if not row:
                continue
            conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
            (UPLOAD_DIR / row["filename"]).unlink(missing_ok=True)
            (THUMB_DIR / row["thumb_filename"]).unlink(missing_ok=True)
            deleted += 1
    return {"ok": True, "deleted": deleted}


@app.post("/api/images/{image_id}/expand")
async def expand_image_note(image_id: int) -> dict[str, Any]:
    settings = get_effective_settings()
    if not settings["metapi_base_url"]:
        raise HTTPException(status_code=400, detail="Metapi base URL is not configured")

    with db() as conn:
        row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")
        image = dict(row)
        tags = get_image_tags(conn, image_id)

    prompt = (
        "你是一个产品点子整理助手。根据截图标题、备注和 TAG，扩写成可执行的点子说明，"
        "包括灵感来源、可能用途、开发方向、下一步行动。保持中文，结构清晰。\n\n"
        f"标题: {image['title']}\n备注: {image['note']}\nTAG: {', '.join(tags)}"
    )
    headers = {"Content-Type": "application/json"}
    if settings["metapi_api_key"]:
        headers["Authorization"] = f"Bearer {settings['metapi_api_key']}"

    base_url = settings["metapi_base_url"].rstrip("/")
    provider = settings["metapi_provider"].lower()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            if provider == "claude":
                response = await client.post(
                    f"{base_url}/v1/messages",
                    headers={**headers, "anthropic-version": "2023-06-01"},
                    json={
                        "model": settings["metapi_model"],
                        "max_tokens": 1200,
                        "messages": [{"role": "user", "content": prompt}],
                    },
                )
                response.raise_for_status()
                data = response.json()
                content = "".join(part.get("text", "") for part in data.get("content", []))
            else:
                response = await client.post(
                    f"{base_url}/v1/chat/completions",
                    headers=headers,
                    json={
                        "model": settings["metapi_model"],
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.7,
                    },
                )
                response.raise_for_status()
                data = response.json()
                content = data["choices"][0]["message"]["content"]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Metapi request failed: {exc}") from exc

    with db() as conn:
        conn.execute(
            "UPDATE images SET expanded_note = ?, updated_at = ? WHERE id = ?",
            (content.strip(), now_iso(), image_id),
        )
    return {"expanded_note": content.strip()}


@app.get("/api/tags")
def list_tags() -> list[str]:
    with db() as conn:
        rows = conn.execute("SELECT name FROM tags ORDER BY name").fetchall()
        return [row["name"] for row in rows]


@app.get("/api/work-groups")
def list_work_groups() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM work_groups ORDER BY updated_at DESC").fetchall()
        return [serialize_work_group(conn, row) for row in rows]


@app.post("/api/work-groups")
def create_work_group(payload: WorkGroupIn) -> dict[str, Any]:
    with db() as conn:
        timestamp = now_iso()
        cur = conn.execute(
            """
            INSERT INTO work_groups (
                title, purpose, notes, priority, starred, tags_json, combined_group_ids_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.title.strip(),
                payload.purpose.strip(),
                payload.notes.strip(),
                normalize_priority(payload.priority),
                1 if payload.starred else 0,
                json.dumps(normalize_tags(payload.tags), ensure_ascii=False),
                json.dumps(payload.combined_group_ids),
                timestamp,
                timestamp,
            ),
        )
        group_id = cur.lastrowid
        replace_work_group_images(conn, group_id, payload.image_ids)
        row = conn.execute("SELECT * FROM work_groups WHERE id = ?", (group_id,)).fetchone()
        return serialize_work_group(conn, row, include_images=True)


@app.get("/api/work-groups/{group_id}")
def get_work_group(group_id: int) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM work_groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Work group not found")
        return serialize_work_group(conn, row, include_images=True)


@app.patch("/api/work-groups/{group_id}")
def update_work_group(group_id: int, payload: WorkGroupPatch) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM work_groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Work group not found")
        fields = payload.model_fields_set
        updates = []
        params: list[Any] = []
        for field in ("title", "purpose", "notes"):
            if field in fields:
                updates.append(f"{field} = ?")
                params.append((getattr(payload, field) or "").strip())
        if "priority" in fields:
            updates.append("priority = ?")
            params.append(normalize_priority(payload.priority))
        if "starred" in fields:
            updates.append("starred = ?")
            params.append(1 if payload.starred else 0)
        if "tags" in fields:
            updates.append("tags_json = ?")
            params.append(json.dumps(normalize_tags(payload.tags), ensure_ascii=False))
        if "combined_group_ids" in fields:
            updates.append("combined_group_ids_json = ?")
            params.append(json.dumps(payload.combined_group_ids or []))
        if updates:
            updates.append("updated_at = ?")
            params.extend([now_iso(), group_id])
            conn.execute(f"UPDATE work_groups SET {', '.join(updates)} WHERE id = ?", params)
        if payload.image_ids is not None:
            replace_work_group_images(conn, group_id, payload.image_ids)
        updated = conn.execute("SELECT * FROM work_groups WHERE id = ?", (group_id,)).fetchone()
        return serialize_work_group(conn, updated, include_images=True)


@app.get("/api/settings")
def read_settings() -> dict[str, str]:
    effective = get_effective_settings()
    return {
        "metapi_base_url": effective["metapi_base_url"],
        "metapi_model": effective["metapi_model"],
        "metapi_provider": effective["metapi_provider"],
        "metapi_api_key": "configured" if effective["metapi_api_key"] else "",
    }


@app.put("/api/settings")
def save_settings(payload: SettingsPatch) -> dict[str, bool]:
    with db() as conn:
        for key, value in payload.model_dump().items():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value.strip()),
            )
    return {"ok": True}


@app.post("/api/export")
def export_images(payload: dict[str, list[int]]) -> StreamingResponse:
    ids = payload.get("ids") or []
    if not ids:
        raise HTTPException(status_code=400, detail="No images selected")
    placeholders = ",".join("?" for _ in ids)
    with db() as conn:
        rows = conn.execute(f"SELECT * FROM images WHERE id IN ({placeholders})", ids).fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="Images not found")
        images = []
        for row in rows:
            item = dict(row)
            item["starred"] = bool(item.get("starred", 0))
            item["tags"] = get_image_tags(conn, item["id"])
            images.append(item)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("metadata.json", json.dumps(images, ensure_ascii=False, indent=2))
        csv_buffer = io.StringIO()
        writer = csv.DictWriter(
            csv_buffer,
            fieldnames=[
                "id",
                "original_name",
                "title",
                "note",
                "expanded_note",
                "status",
                "priority",
                "starred",
                "tags",
                "created_at",
            ],
        )
        writer.writeheader()
        for image in images:
            writer.writerow(
                {
                    "id": image["id"],
                    "original_name": image["original_name"],
                    "title": image["title"],
                    "note": image["note"],
                    "expanded_note": image["expanded_note"],
                    "status": image["status"],
                    "priority": image["priority"],
                    "starred": "yes" if image["starred"] else "no",
                    "tags": ",".join(image["tags"]),
                    "created_at": image["created_at"],
                }
            )
            source = UPLOAD_DIR / image["filename"]
            if source.exists():
                archive.write(source, f"images/{image['original_name']}")
        archive.writestr("metadata.csv", csv_buffer.getvalue())

    buffer.seek(0)
    filename = f"screenwork-export-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


ensure_dirs()
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/thumbs", StaticFiles(directory=THUMB_DIR), name="thumbs")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
