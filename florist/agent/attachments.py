"""Files attached to a chat: stored under ``~/.florist/attachments``; models read the extracted text."""

from __future__ import annotations

import base64
import binascii
import io
from pathlib import Path

from .. import paths
from ..schemas import Attachment
from ..store import db

MAX_BYTES = 15 * 1024 * 1024
MAX_TEXT = 60_000


def _text_of(name: str, raw: bytes) -> str:
    if Path(name).suffix.lower() == ".pdf":
        from pypdf import PdfReader

        try:
            pages = PdfReader(io.BytesIO(raw)).pages
            return "\n\n".join((p.extract_text() or "") for p in pages)[:MAX_TEXT].strip()
        except Exception as e:
            raise ValueError(f"couldn't read {name}: {e}") from e
    if b"\0" in raw[:4096]:
        raise ValueError(f"{name} isn't a text file or PDF, so Florist can't read it")
    return raw.decode("utf-8", errors="replace")[:MAX_TEXT].strip()


def add(name: str, data_b64: str, mime: str = "") -> Attachment:
    name = Path(name.replace("\\", "/")).name or "file"
    try:
        raw = base64.b64decode(data_b64, validate=True)
    except binascii.Error as e:
        raise ValueError("the upload was corrupted") from e
    if len(raw) > MAX_BYTES:
        raise ValueError(f"{name} is larger than {MAX_BYTES // (1024 * 1024)} MB")
    content = _text_of(name, raw)
    if not content:
        raise ValueError(f"{name} has no readable text")
    aid = db.new_id("att")
    path = paths.sub("attachments") / f"{aid}{Path(name).suffix.lower()}"
    path.write_bytes(raw)
    return db.put_attachment(Attachment(id=aid, name=name, mime=mime, size=len(raw), path=str(path), text=content))
