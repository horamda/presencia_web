import json
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from encuentro import EncuentroStore
from server import make_handler


def fixture():
    people = [dict(clave=str(i), nombre=f"Persona {i}", sector="Ventas", modalidad="Presencial",
                   modalidad_codigo="presencial", ultimo_ingreso="08:00:00", ingreso_validado=False,
                   estado="sin_salida" if i < 3 else "sin_fichadas") for i in range(1, 4)]
    counts = dict(empleados=3, presentes=2, vinieron=2, retirados=0, sin_ingreso=1)
    return dict(actualizado=datetime.now(timezone.utc).isoformat(), fecha="2026-09-14", totales=counts,
                empresas=[dict(counts, nombre="Empresa")], sucursales=[dict(counts, nombre="Central",
                empresa="Empresa", personal=people, personas=people[:2], sin_ingreso_personas=people[2:],
                modalidades=[], sectores=[])])


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        class Source(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(fixture()).encode())
            def log_message(self, *args):
                pass
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Source)
        handler = make_handler(f'http://127.0.0.1:{self.upstream.server_port}',
                               EncuentroStore(Path(self.tmp.name) / 'control.db'))
        handler.log_message = lambda *args: None
        self.web = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        for server in (self.upstream, self.web):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.web.server_port}'

    def tearDown(self):
        for server in (self.web, self.upstream):
            server.shutdown()
            server.server_close()
        self.tmp.cleanup()

    def request(self, path, body=None, origin=None):
        headers = {'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        req = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                      headers=headers)
        try:
            response = urlopen(req, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_counts_absence_and_shared_checklist_flow(self):
        code, data = self.request('/api/presencia')
        self.assertEqual(code, 200)
        self.assertEqual(len(data['sucursales'][0]['sin_ingreso_personas']), 1)
        code, state = self.request('/api/encuentro/iniciar', {'responsable': 'Operador A'})
        self.assertEqual(code, 200)
        body = dict(responsable='Operador A', control_id=state['control']['id'], clave='1', revision=0, encontrado=True)
        code, marked = self.request('/api/encuentro/marcar', body)
        self.assertEqual(code, 200)
        self.assertEqual(marked['totales']['encontrados'], 1)
        code, state = self.request('/api/encuentro')
        self.assertEqual(state['totales']['encontrados'], 1)
        code, _ = self.request('/api/encuentro/marcar', dict(body, responsable='Operador B', encontrado=False))
        self.assertEqual(code, 409)
        self.assertEqual(self.request('/api/encuentro')[1]['totales']['encontrados'], 1)
        # A live roster is not needed to read an already-started control.
        self.upstream.shutdown()
        self.upstream.server_close()
        self.assertEqual(self.request('/api/encuentro')[0], 200)

    def test_mutation_validation_and_private_files(self):
        self.assertEqual(self.request('/api/encuentro/iniciar', {'responsable': ''})[0], 400)
        self.assertEqual(self.request('/api/encuentro/iniciar', {'responsable': 'Operador'}, 'https://other.example')[0], 403)
        self.assertEqual(self.request('/data/encuentros.sqlite3')[0], 404)
        self.assertEqual(self.request('/config.json')[0], 404)
        self.assertIsNone(self.request('/api/encuentro')[1]['control'])


if __name__ == '__main__':
    unittest.main()
