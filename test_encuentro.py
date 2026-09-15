import tempfile
import unittest
from pathlib import Path

from encuentro import Conflict, EncuentroStore


def source():
    return {"actualizado": "2026-09-14T10:00:00-03:00", "sucursales": [{
        "nombre": "Central", "empresa": "Empresa", "personal": [
            {"clave": "a", "nombre": "Persona Uno", "sector": "Ventas", "estado": "sin_salida"},
            {"clave": "b", "nombre": "Persona Dos", "sector": "Ventas", "estado": "sin_salida"},
            {"clave": "c", "nombre": "Persona Tres", "sector": "Ventas", "estado": "sin_fichadas"},
        ]}]}


class EncuentroTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "control.sqlite3"
        self.store = EncuentroStore(self.path)
        self.state = self.store.start(source(), "Responsable A")
        self.control_id = self.state["control"]["id"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_snapshot_persistence_and_duplicate_start(self):
        self.assertEqual(self.state["totales"], dict(total=2, encontrados=0, pendientes=2))
        result = self.store.update(self.control_id, "a", True, 0, "Responsable A")
        self.assertEqual(result["totales"]["encontrados"], 1)
        restarted = EncuentroStore(self.path)
        self.assertEqual(restarted.get()["totales"]["encontrados"], 1)
        changed_source = source()
        changed_source["sucursales"][0]["personal"] = []
        self.assertEqual(restarted.start(changed_source, "Responsable B")["totales"]["total"], 2)

    def test_separate_people_can_be_checked_and_stale_same_person_conflicts(self):
        self.store.update(self.control_id, "a", True, 0, "A")
        result = self.store.update(self.control_id, "b", True, 0, "B")
        self.assertEqual(result["totales"]["encontrados"], 2)
        with self.assertRaises(Conflict):
            self.store.update(self.control_id, "a", False, 0, "B")
        self.assertEqual(self.store.get()["totales"]["encontrados"], 2)
        undone = self.store.update(self.control_id, "a", False, 1, "B")
        self.assertEqual(undone["totales"]["pendientes"], 1)

    def test_add_person_without_ingress_needs_explicit_check(self):
        with self.assertRaises(Conflict):
            self.store.update(self.control_id, "c", True, 0, "A")
        result = self.store.update(self.control_id, "c", False, 0, "A", include=True)
        self.assertEqual(result["totales"], dict(total=3, encontrados=0, pendientes=3))
        result = self.store.update(self.control_id, "c", True, 1, "A")
        self.assertEqual(result["totales"]["encontrados"], 1)

    def test_close_conflicts_if_changed_and_new_control_is_separate(self):
        self.store.update(self.control_id, "a", True, 0, "A")
        with self.assertRaises(Conflict):
            self.store.close(self.control_id, 0, "B")
        closed = self.store.close(self.control_id, 1, "A")
        self.assertIsNotNone(closed["control"]["cierre"])
        with self.assertRaises(Conflict):
            self.store.update(self.control_id, "b", True, 0, "A")
        fresh = self.store.start(source(), "B")
        self.assertNotEqual(fresh["control"]["id"], self.control_id)
        self.assertEqual(fresh["totales"]["encontrados"], 0)
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controles").fetchone()[0], 2)

    def test_state_includes_recent_changes(self):
        self.store.update(self.control_id, "a", True, 0, "A")
        state = self.store.get()
        self.assertEqual([c["accion"] for c in state["cambios"]], ["encontrado", "iniciar"])
        self.assertEqual(state["cambios"][0]["clave"], "a")

    def test_history_lists_only_closed_controls_newest_first(self):
        self.assertEqual(self.store.history(), [])
        self.store.update(self.control_id, "a", True, 0, "A")
        first_id = self.control_id
        self.store.close(first_id, 1, "A")
        second = self.store.start(source(), "B")
        second_id = second["control"]["id"]
        self.store.update(second_id, "a", True, 0, "B")
        self.store.update(second_id, "b", True, 0, "B")
        self.store.close(second_id, 2, "B")
        history = self.store.history()
        self.assertEqual([row["id"] for row in history], [second_id, first_id])
        self.assertEqual(history[0]["encontrados"], 2)
        self.assertEqual(history[0]["pendientes"], 0)
        self.assertEqual(history[1]["encontrados"], 1)
        self.assertEqual(history[1]["pendientes"], 1)

    def test_detail_reads_a_specific_non_latest_control(self):
        first_id = self.control_id
        self.store.close(first_id, 0, "A")
        second = self.store.start(source(), "B")
        self.assertNotEqual(second["control"]["id"], first_id)
        detail = self.store.detail(first_id)
        self.assertEqual(detail["control"]["id"], first_id)
        self.assertIsNotNone(detail["control"]["cierre"])

    def test_detail_of_unknown_control_returns_empty_control(self):
        self.assertEqual(self.store.detail("no-existe"), {"control": None})


if __name__ == "__main__":
    unittest.main()
