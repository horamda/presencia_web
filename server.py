"""Pantalla independiente: solo requiere Python 3, sin acceso a la base."""

import json
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen
from encuentro import Conflict, EncuentroStore

ROOT = Path(__file__).resolve().parent
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/presencia.css": ("presencia.css", "text/css; charset=utf-8"),
    "/responsive.css": ("responsive.css", "text/css; charset=utf-8"),
    "/presencia.js": ("presencia.js", "text/javascript; charset=utf-8"),
    "/encuentro.js": ("encuentro.js", "text/javascript; charset=utf-8"),
}


def make_handler(backend_url, store=None):
    backend_url = backend_url.rstrip("/")
    if urlsplit(backend_url).scheme not in {"http", "https"}:
        raise ValueError("backend_url debe comenzar con http:// o https://")
    store = store or EncuentroStore(ROOT / "data" / "encuentros.sqlite3")

    def read_source(query=""):
        with urlopen(backend_url + "/presencia/datos" + query, timeout=10) as upstream:
            return json.load(upstream)

    def public_person(person):
        return dict({key: str(person[key]) for key in (
            "clave", "nombre", "sector", "modalidad", "modalidad_codigo", "ultimo_ingreso", "estado"
        )}, ingreso_validado=person["ingreso_validado"] is True)

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body, content_type="application/json; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Robots-Tag", "noindex, nofollow")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            request = urlsplit(self.path)
            if request.path == "/api/encuentro":
                try:
                    self.reply(200, json.dumps(store.get(), ensure_ascii=False).encode("utf-8"))
                except sqlite3.Error:
                    self.reply(503, b'{"error":"No se pudo leer el control guardado"}')
                return
            if request.path == "/api/encuentro/historial":
                try:
                    self.reply(200, json.dumps(store.history(), ensure_ascii=False).encode("utf-8"))
                except sqlite3.Error:
                    self.reply(503, b'{"error":"No se pudo leer el historial de controles"}')
                return
            if request.path.startswith("/api/encuentro/historial/"):
                control_id = request.path.rsplit("/", 1)[-1]
                try:
                    self.reply(200, json.dumps(store.detail(control_id), ensure_ascii=False).encode("utf-8"))
                except sqlite3.Error:
                    self.reply(503, b'{"error":"No se pudo leer el control guardado"}')
                return
            if request.path in STATIC:
                filename, content_type = STATIC[request.path]
                self.reply(200, (ROOT / filename).read_bytes(), content_type)
                return
            if request.path != "/api/presencia":
                self.reply(404, b'{"error":"No encontrado"}')
                return
            empresa = parse_qs(request.query).get("empresa_id", [""])[0]
            if empresa and (not empresa.isascii() or not empresa.isdecimal() or int(empresa) <= 0):
                self.reply(400, b'{"error":"Empresa invalida"}')
                return
            query = "?" + urlencode({"empresa_id": empresa}) if empresa else ""
            try:
                data = read_source(query)
                # Lista mínima para consulta: nombres, sector, modalidad y hora.
                keys = ("empleados", "presentes", "vinieron", "retirados", "sin_ingreso")
                def counts(row):
                    result = {key: row[key] for key in keys}
                    if any(type(value) is not int or value < 0 for value in result.values()):
                        raise ValueError("Conteos invalidos")
                    return result
                def modalities(row):
                    return [dict(counts(item), codigo=str(item["codigo"]), nombre=str(item["nombre"]))
                            for item in row["modalidades"]]
                payload = {
                    "totales": counts(data["totales"]),
                    "empresas": [dict(counts(row), nombre=str(row["nombre"])) for row in data["empresas"]],
                    "sucursales": [dict(counts(branch), nombre=str(branch["nombre"]),
                        personas=[public_person(person) for person in branch["personas"]],
                        sin_ingreso_personas=[public_person(person) for person in branch["sin_ingreso_personas"]],
                        empresa=str(branch["empresa"]), modalidades=modalities(branch), sectores=[
                            dict(counts(sector), nombre=str(sector["nombre"]), modalidades=modalities(sector)) for sector in branch["sectores"]
                        ]) for branch in data["sucursales"]],
                    "fecha": data["fecha"], "actualizado": data["actualizado"],
                    "intervalo_segundos": 30,
                }
                self.reply(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            except HTTPError as exc:
                message = (
                    "El sistema conectado no tiene disponible /presencia/datos. Hay que actualizar ese backend."
                    if exc.code == 404 else
                    "El sistema de asistencia no pudo entregar los datos. Revisar su conexion a la base."
                )
                self.reply(503, json.dumps({"error": message}).encode("utf-8"))
            except (URLError, TimeoutError, OSError):
                self.reply(503, json.dumps({"error":
                    "No hay conexion con el sistema de asistencia. Si es local, abrilo con iniciar.bat; si es remoto, revisa backend_url en config.json."
                }).encode("utf-8"))
            except (ValueError, KeyError, TypeError):
                self.reply(503, b'{"error":"El sistema conectado devolvio datos con un formato incompatible"}')

        def do_POST(self):
            path = urlsplit(self.path).path
            if path not in {"/api/encuentro/iniciar", "/api/encuentro/marcar", "/api/encuentro/incorporar", "/api/encuentro/cerrar"}:
                self.reply(404, b'{"error":"No encontrado"}')
                return
            origin = self.headers.get("Origin")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.headers.get_content_type() != "application/json" or not 0 < length <= 4096:
                    raise ValueError("Solicitud inválida.")
                raw_body = self.rfile.read(length)
                if (origin and urlsplit(origin).netloc != self.headers.get("Host")) or self.headers.get("Sec-Fetch-Site") == "cross-site":
                    self.reply(403, b'{"error":"Origen no permitido"}')
                    return
                body = json.loads(raw_body)
                if not isinstance(body, dict):
                    raise ValueError("Solicitud inválida.")
                actor = body.get("responsable")
                if not isinstance(actor, str) or not 2 <= len(actor.strip()) <= 80:
                    raise ValueError("Ingresá el nombre del responsable (2 a 80 caracteres).")
                actor = actor.strip()
                if path.endswith("/iniciar"):
                    current = store.get()
                    if current["control"] and not current["control"]["cierre"]:
                        result = current
                    else:
                        source = read_source()
                        age = (datetime.now(timezone.utc) - datetime.fromisoformat(source["actualizado"])).total_seconds()
                        if not -30 <= age <= 90:
                            raise ValueError("Los datos de asistencia están desactualizados. No se inició el control.")
                        for branch in source["sucursales"]:
                            branch["personal"] = [public_person(p) for p in branch["personal"]]
                        result = store.start(source, actor)
                else:
                    control_id, revision = body.get("control_id"), body.get("revision")
                    if not isinstance(control_id, str) or type(revision) is not int or revision < 0:
                        raise ValueError("Control o revisión inválida.")
                    if path.endswith("/cerrar"):
                        result = store.close(control_id, revision, actor)
                    else:
                        key = body.get("clave")
                        if not isinstance(key, str) or len(key) > 80:
                            raise ValueError("Persona inválida.")
                        found = body.get("encontrado", False)
                        if type(found) is not bool:
                            raise ValueError("Estado inválido.")
                        result = store.update(control_id, key, found, revision, actor,
                                              include=path.endswith("/incorporar"))
                self.reply(200, json.dumps(result, ensure_ascii=False).encode("utf-8"))
            except Conflict as exc:
                self.reply(409, json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8"))
            except (ValueError, KeyError, TypeError) as exc:
                message = str(exc) if type(exc) is ValueError else "Datos del control incompatibles."
                self.reply(400, json.dumps({"error": message}, ensure_ascii=False).encode("utf-8"))
            except (URLError, TimeoutError, OSError, sqlite3.Error):
                self.reply(503, b'{"error":"No se pudo completar el guardado o la consulta. Actualiza el control antes de reintentar."}')

    return Handler


def main():
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    server = ThreadingHTTPServer(
        (config.get("host", "0.0.0.0"), int(config.get("port", 8080))),
        make_handler(config["backend_url"]),
    )
    print(f"Presencia web: http://localhost:{server.server_port}", flush=True)
    print("Para cerrar, presione Ctrl+C.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
