"""Recuento compartido persistente. No modifica las fichadas del backend."""

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


class Conflict(ValueError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


class EncuentroStore:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS controles (
                    id TEXT PRIMARY KEY, inicio TEXT NOT NULL, fuente TEXT NOT NULL,
                    responsable TEXT NOT NULL, cierre TEXT, revision INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS un_control_activo
                    ON controles ((1)) WHERE cierre IS NULL;
                CREATE TABLE IF NOT EXISTS personas (
                    control TEXT NOT NULL, clave TEXT NOT NULL, datos TEXT NOT NULL,
                    incluido INTEGER NOT NULL, encontrado INTEGER NOT NULL DEFAULT 0,
                    responsable TEXT, confirmado TEXT, revision INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (control, clave)
                );
                CREATE TABLE IF NOT EXISTS cambios (
                    id INTEGER PRIMARY KEY, control TEXT NOT NULL, clave TEXT,
                    accion TEXT NOT NULL, responsable TEXT NOT NULL, momento TEXT NOT NULL
                );
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _state(self, db, control_id=None):
        if control_id:
            control = db.execute("SELECT * FROM controles WHERE id=?", (control_id,)).fetchone()
        else:
            control = db.execute("SELECT * FROM controles ORDER BY inicio DESC LIMIT 1").fetchone()
        if not control:
            return {"control": None}
        rows = db.execute("SELECT * FROM personas WHERE control=? ORDER BY rowid", (control["id"],)).fetchall()
        people = [dict(json.loads(row["datos"]), incluido=bool(row["incluido"]),
                       encontrado=bool(row["encontrado"]), responsable=row["responsable"],
                       confirmado=row["confirmado"], revision=row["revision"]) for row in rows]
        included = [p for p in people if p["incluido"]]
        found = sum(p["encontrado"] for p in included)
        changes = db.execute(
            "SELECT clave,accion,responsable,momento FROM cambios WHERE control=? ORDER BY id DESC LIMIT 200",
            (control["id"],),
        ).fetchall()
        return {"control": dict(control), "personas": included,
                "disponibles": [p for p in people if not p["incluido"]],
                "totales": {"total": len(included), "encontrados": found, "pendientes": len(included) - found},
                "cambios": [dict(row) for row in changes]}

    def get(self):
        with self.connection() as db:
            db.execute("BEGIN")
            return self._state(db)

    def detail(self, control_id):
        with self.connection() as db:
            db.execute("BEGIN")
            return self._state(db, control_id)

    def history(self, limit=50):
        with self.connection() as db:
            db.execute("BEGIN")
            rows = db.execute("""
                SELECT c.id, c.inicio, c.cierre, c.responsable,
                    (SELECT COUNT(*) FROM personas p WHERE p.control = c.id AND p.incluido = 1) AS total,
                    (SELECT COUNT(*) FROM personas p WHERE p.control = c.id AND p.incluido = 1 AND p.encontrado = 1) AS encontrados
                FROM controles c
                WHERE c.cierre IS NOT NULL
                ORDER BY c.cierre DESC
                LIMIT ?
            """, (limit,)).fetchall()
            return [dict(row, pendientes=row["total"] - row["encontrados"]) for row in rows]

    def start(self, source, actor):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute("SELECT id FROM controles WHERE cierre IS NULL").fetchone()
            if active:
                return self._state(db, active["id"])
            control_id = uuid.uuid4().hex
            db.execute("INSERT INTO controles(id,inicio,fuente,responsable) VALUES(?,?,?,?)",
                       (control_id, now(), source["actualizado"], actor))
            for branch in source["sucursales"]:
                for person in branch["personal"]:
                    data = dict(person, sucursal=branch["nombre"], empresa=branch["empresa"])
                    db.execute("INSERT INTO personas(control,clave,datos,incluido) VALUES(?,?,?,?)",
                               (control_id, person["clave"], json.dumps(data, ensure_ascii=False),
                                int(person["estado"] == "sin_salida")))
            db.execute("INSERT INTO cambios(control,accion,responsable,momento) VALUES(?,?,?,?)",
                       (control_id, "iniciar", actor, now()))
            return self._state(db, control_id)

    def update(self, control_id, key, found, revision, actor, *, include=False):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            control = db.execute("SELECT * FROM controles WHERE id=?", (control_id,)).fetchone()
            if not control or control["cierre"]:
                raise Conflict("Este control no está activo. Actualizá la lista.")
            row = db.execute("SELECT * FROM personas WHERE control=? AND clave=?", (control_id, key)).fetchone()
            if not row or row["revision"] != revision:
                raise Conflict("Otro responsable actualizó esta persona. Se debe recargar su estado.")
            if not row["incluido"] and not include:
                raise Conflict("Primero incorporá a esta persona al recuento.")
            if include and row["incluido"]:
                raise Conflict("La persona ya está incluida.")
            moment = now()
            db.execute("""UPDATE personas SET incluido=1, encontrado=?, responsable=?, confirmado=?,
                          revision=revision+1 WHERE control=? AND clave=?""",
                       (int(found) if not include else 0, actor, moment if found and not include else None,
                        control_id, key))
            db.execute("UPDATE controles SET revision=revision+1 WHERE id=?", (control_id,))
            action = "incorporar" if include else "encontrado" if found else "pendiente"
            db.execute("INSERT INTO cambios(control,clave,accion,responsable,momento) VALUES(?,?,?,?,?)",
                       (control_id, key, action, actor, moment))
            return self._state(db, control_id)

    def close(self, control_id, revision, actor):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            result = db.execute("UPDATE controles SET cierre=?,revision=revision+1 WHERE id=? AND cierre IS NULL AND revision=?",
                                (now(), control_id, revision))
            if result.rowcount != 1:
                raise Conflict("El control cambió o ya fue cerrado. Actualizá antes de cerrar.")
            db.execute("INSERT INTO cambios(control,accion,responsable,momento) VALUES(?,?,?,?)",
                       (control_id, "cerrar", actor, now()))
            return self._state(db, control_id)
