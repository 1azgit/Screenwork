import csv
import io
import json
import os
import shutil
import sqlite3
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
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
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_CATEGORY_DEPTH = 3


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
                width INTEGER,
                height INTEGER,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                title TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                expanded_note TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'new',
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
            """
        )


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
    category_id: Optional[int] = None
    tags: Optional[list[str]] = None


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
    return image


def find_duplicate_image(conn: sqlite3.Connection, original_name: str, size: int) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT *
        FROM images
        WHERE lower(original_name) = lower(?) AND size = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (original_name, size),
    ).fetchone()
    if not row:
        return None
    image = dict(row)
    return attach_image_urls(image, get_image_tags(conn, image["id"]))


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
            if ext not in ALLOWED_EXTENSIONS or not file.content_type.startswith("image/"):
                raise HTTPException(status_code=400, detail=f"Unsupported image file: {original_name}")

            image_id = uuid.uuid4().hex
            filename = f"{image_id}{ext}"
            thumb_filename = f"{image_id}.webp"
            target = UPLOAD_DIR / filename
            thumb = THUMB_DIR / thumb_filename

            with target.open("wb") as out:
                shutil.copyfileobj(file.file, out)
            size = target.stat().st_size
            duplicate = find_duplicate_image(conn, original_name, size)
            try:
                width, height = save_thumbnail(target, thumb)
            except Exception as exc:
                target.unlink(missing_ok=True)
                thumb.unlink(missing_ok=True)
                raise HTTPException(status_code=400, detail=f"Invalid image file: {original_name}") from exc

            created_at = now_iso()
            cur = conn.execute(
                """
                INSERT INTO images (
                    filename, thumb_filename, original_name, mime_type, size, width, height,
                    category_id, title, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    filename,
                    thumb_filename,
                    original_name,
                    file.content_type,
                    size,
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
    tag: str = "",
    q: str = "",
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
    if q:
        where.append("(i.title LIKE ? OR i.note LIKE ? OR i.expanded_note LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like, like])
    if tag:
        join = "JOIN image_tags it ON it.image_id = i.id JOIN tags t ON t.id = it.tag_id"
        where.append("t.name = ?")
        params.append(tag.strip().lower())
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    offset = (page - 1) * page_size
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT DISTINCT i.*
            FROM images i
            {join}
            {where_sql}
            ORDER BY i.created_at DESC
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
        for field in ("title", "note", "expanded_note", "status", "category_id"):
            if field in fields:
                updates.append(f"{field} = ?")
                params.append(getattr(payload, field))
        if updates:
            updates.append("updated_at = ?")
            params.extend([now_iso(), image_id])
            conn.execute(f"UPDATE images SET {', '.join(updates)} WHERE id = ?", params)
        if payload.tags is not None:
            set_image_tags(conn, image_id, payload.tags)
        updated = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        return attach_image_urls(dict(updated), get_image_tags(conn, image_id))


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
            item["tags"] = get_image_tags(conn, item["id"])
            images.append(item)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("metadata.json", json.dumps(images, ensure_ascii=False, indent=2))
        csv_buffer = io.StringIO()
        writer = csv.DictWriter(
            csv_buffer,
            fieldnames=["id", "original_name", "title", "note", "expanded_note", "status", "tags", "created_at"],
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
