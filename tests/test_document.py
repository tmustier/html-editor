"""Tests for server/document.py — the pure mutation surface.

Every test builds a small inline HTML/SVG fragment in the test body itself
(never reads the user's real scratch document) so the suite documents the
behaviour structurally, not by accident of one particular file's shape.
"""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from bs4 import BeautifulSoup

from server import document as D


def soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


# --- predicates -------------------------------------------------------------

class IsTextEditable(unittest.TestCase):
    def test_leaf_p_is_editable(self):
        s = soup('<p data-edit-id="e1">hello</p>')
        self.assertTrue(D.is_text_editable(s.find("p")))

    def test_inline_only_children_are_editable(self):
        s = soup('<p data-edit-id="e1">hi <b>there</b> <code>x</code></p>')
        self.assertTrue(D.is_text_editable(s.find("p")))

    def test_div_with_div_is_not_editable(self):
        s = soup('<div data-edit-id="e1"><div>nested</div></div>')
        self.assertFalse(D.is_text_editable(s.find("div")))

    def test_svg_text_is_not_editable_via_this_predicate(self):
        # SVG text is edited via update_svg_labels, not update_text.
        s = soup('<svg><text data-edit-id="e1">hi</text></svg>')
        self.assertFalse(D.is_text_editable(s.find("text")))

    def test_none_is_not_editable(self):
        self.assertFalse(D.is_text_editable(None))


# --- ensure_edit_ids --------------------------------------------------------

class EnsureEditIds(unittest.TestCase):
    def _write(self, html: str) -> Path:
        f = Path(self.tmp.name) / "doc.html"
        f.write_text(html, encoding="utf-8")
        return f

    def setUp(self):
        self.tmp = TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_assigns_ids_to_new_elements(self):
        p = self._write("<html><body><p>hi</p><div>x</div></body></html>")
        D.ensure_edit_ids(p)
        s = D.load_soup(p)
        self.assertEqual(s.find("p")["data-edit-id"], "e1")
        self.assertEqual(s.find("div")["data-edit-id"], "e2")

    def test_skips_html_body_head_script_style(self):
        p = self._write(
            "<html><head><title>t</title><style>a{}</style></head>"
            "<body><script>x</script><p>hi</p></body></html>")
        D.ensure_edit_ids(p)
        s = D.load_soup(p)
        for tag in ("html", "head", "body", "script", "style", "title"):
            self.assertFalse(s.find(tag).has_attr("data-edit-id"),
                             f"{tag} should not get an edit id")
        self.assertTrue(s.find("p").has_attr("data-edit-id"))

    def test_skips_svg_utility_groups_without_text(self):
        p = self._write(
            '<html><body><svg>'
            '<g><rect/></g>'              # utility, no text -> skip
            '<g><text>label</text></g>'   # labelled       -> keep
            '</svg></body></html>')
        D.ensure_edit_ids(p)
        s = D.load_soup(p)
        groups = s.find_all("g")
        self.assertFalse(groups[0].has_attr("data-edit-id"))
        self.assertTrue(groups[1].has_attr("data-edit-id"))

    def test_assigns_id_to_orphan_svg_text(self):
        p = self._write(
            '<html><body><svg>'
            '<text>orphan one</text>'
            '<text>orphan two</text>'
            '<g><text>inside a group</text></g>'  # not orphan
            '</svg></body></html>')
        D.ensure_edit_ids(p)
        s = D.load_soup(p)
        texts = s.find_all("text")
        self.assertTrue(texts[0].has_attr("data-edit-id"))
        self.assertTrue(texts[1].has_attr("data-edit-id"))
        # The third text is inside a labelled group; the group owns the id.
        self.assertFalse(texts[2].has_attr("data-edit-id"))

    def test_idempotent(self):
        p = self._write("<html><body><p>a</p><p>b</p></body></html>")
        D.ensure_edit_ids(p)
        first = p.read_text()
        D.ensure_edit_ids(p)
        second = p.read_text()
        self.assertEqual(first, second)

    def test_preserves_existing_ids_and_continues_numbering(self):
        p = self._write(
            '<html><body><p data-edit-id="e5">a</p><p>b</p></body></html>')
        D.ensure_edit_ids(p)
        s = D.load_soup(p)
        ids = [el["data-edit-id"] for el in s.find_all(attrs={"data-edit-id": True})]
        self.assertIn("e5", ids)
        self.assertIn("e6", ids)


# --- inline style helpers ---------------------------------------------------

class InlineStyle(unittest.TestCase):
    def test_round_trip(self):
        s = "color: red; padding: 4px"
        self.assertEqual(D.stringify_inline_style(D.parse_inline_style(s)), s)

    def test_trailing_semicolon_is_tolerated(self):
        d = D.parse_inline_style("color: red;")
        self.assertEqual(d, {"color": "red"})

    def test_empty_string_returns_empty_dict(self):
        self.assertEqual(D.parse_inline_style(""), {})

    def test_handles_colon_in_value(self):
        d = D.parse_inline_style("background: url(http://x)")
        self.assertEqual(d, {"background": "url(http://x)"})


# --- smart_update_svg_text --------------------------------------------------

class SmartUpdateSvgText(unittest.TestCase):
    def _text(self, inner: str):
        s = soup(f"<svg><text>{inner}</text></svg>")
        return s, s.find("text")

    def test_plain_text_no_tspan(self):
        s, t = self._text("hello")
        self.assertTrue(D.smart_update_svg_text(t, "world"))
        self.assertEqual(t.get_text(), "world")

    def test_no_change_returns_true(self):
        s, t = self._text('hi <tspan font-family="mono">x</tspan> bye')
        self.assertTrue(D.smart_update_svg_text(t, "hi x bye"))
        self.assertEqual(t.find("tspan")["font-family"], "mono")

    def test_single_tspan_wrap_preserves_attrs(self):
        s, t = self._text('<tspan font-family="mono">value</tspan>')
        self.assertTrue(D.smart_update_svg_text(t, "different"))
        self.assertEqual(t.get_text(), "different")
        self.assertEqual(t.find("tspan")["font-family"], "mono")

    def test_edit_inside_tspan_preserves_other_segments(self):
        s, t = self._text('node · reads <tspan font-family="mono">runner.env</tspan> / keychain')
        self.assertTrue(D.smart_update_svg_text(t, "node · reads runner.envX / keychain"))
        self.assertEqual(t.find("tspan").get_text(), "runner.envX")
        self.assertEqual(t.find("tspan")["font-family"], "mono")

    def test_edit_outside_tspan_preserves_tspan(self):
        s, t = self._text('node · reads <tspan font-family="mono">runner.env</tspan> / keychain')
        self.assertTrue(D.smart_update_svg_text(t, "node · reads runner.env / Keychain"))
        self.assertEqual(t.find("tspan").get_text(), "runner.env")
        self.assertEqual(t.find("tspan")["font-family"], "mono")
        self.assertIn("Keychain", t.get_text())

    def test_cross_segment_edit_falls_back_to_plain_text(self):
        s, t = self._text('alpha <tspan font-family="mono">beta</tspan> gamma')
        # Edit deletes across tspan + surrounding text -> can't preserve.
        result = D.smart_update_svg_text(t, "alphagamma")
        self.assertFalse(result)
        self.assertIsNone(t.find("tspan"))
        self.assertEqual(t.get_text(), "alphagamma")

    def test_nested_tspan_falls_back(self):
        s, t = self._text('a<tspan>b<tspan font-weight="bold">c</tspan>d</tspan>e')
        result = D.smart_update_svg_text(t, "modified")
        self.assertFalse(result)
        self.assertEqual(t.get_text(), "modified")
        self.assertIsNone(t.find("tspan"))

    def test_unknown_child_falls_back(self):
        # Comment node — we don't know how to splice around it.
        s = soup("<svg><text>a<!-- c -->b</text></svg>")
        t = s.find("text")
        result = D.smart_update_svg_text(t, "different")
        self.assertFalse(result)
        self.assertEqual(t.get_text(), "different")

    def test_insert_at_segment_boundary_picks_left_segment(self):
        # Insertion exactly at the seam between text and tspan should extend
        # the earlier segment (so typing at the start of a tspan doesn't
        # accidentally absorb characters into its formatted run).
        s, t = self._text('hi <tspan font-family="mono">x</tspan>')
        # Insert at offset 3 — right before the tspan begins.
        self.assertTrue(D.smart_update_svg_text(t, "hi !x"))
        # The "!" should have ended up in the leading text segment, not
        # inside the tspan, so the tspan still wraps just "x".
        self.assertEqual(t.find("tspan").get_text(), "x")
        self.assertIn("hi !", t.get_text())


# --- update_text ------------------------------------------------------------

class UpdateText(unittest.TestCase):
    def test_replaces_leaf_text(self):
        s = soup('<p data-edit-id="e1">old</p>')
        ok, result = D.update_text(s, "e1", "new", None)
        self.assertTrue(ok)
        self.assertEqual(s.find("p").get_text(), "new")
        self.assertEqual(result["tag"], "p")

    def test_replaces_with_html_when_provided(self):
        s = soup('<p data-edit-id="e1">old</p>')
        ok, _ = D.update_text(s, "e1", "ignored", "hi <b>bold</b>")
        self.assertTrue(ok)
        self.assertEqual(s.find("p").decode_contents(), "hi <b>bold</b>")

    def test_rejects_structural_element(self):
        s = soup('<div data-edit-id="e1"><div>nested</div></div>')
        ok, result = D.update_text(s, "e1", "new", None)
        self.assertFalse(ok)
        self.assertEqual(result["status"], 400)
        self.assertIn("structural", result["error"])

    def test_404_on_missing_id(self):
        s = soup('<p data-edit-id="e1">x</p>')
        ok, result = D.update_text(s, "e999", "n", None)
        self.assertFalse(ok)
        self.assertEqual(result["status"], 404)


# --- update_text_many -------------------------------------------------------

class UpdateTextMany(unittest.TestCase):
    def test_updates_multiple_cells(self):
        s = soup(
            '<table><tr>'
            '<td data-edit-id="e1">A</td><td data-edit-id="e2">B</td>'
            '</tr></table>')
        ok, result = D.update_text_many(s, [
            {"id": "e1", "text": "One"},
            {"id": "e2", "text": "Two"},
        ])
        self.assertTrue(ok)
        self.assertEqual(result["count"], 2)
        self.assertEqual([td.get_text() for td in s.find_all("td")], ["One", "Two"])

    def test_rejects_empty_batch(self):
        ok, result = D.update_text_many(soup("<p>x</p>"), [])
        self.assertFalse(ok)
        self.assertEqual(result["status"], 400)

    def test_rejects_missing_id_without_partial_mutation(self):
        s = soup(
            '<table><tr>'
            '<td data-edit-id="e1">A</td><td data-edit-id="e2">B</td>'
            '</tr></table>')
        ok, result = D.update_text_many(s, [
            {"id": "e1", "text": "One"},
            {"id": "missing", "text": "Two"},
        ])
        self.assertFalse(ok)
        self.assertEqual(result["status"], 404)
        self.assertEqual([td.get_text() for td in s.find_all("td")], ["A", "B"])

    def test_batch_lookup_matches_single_update_when_ids_are_duplicated(self):
        s = soup(
            '<table><tr>'
            '<td data-edit-id="dup">A</td><td data-edit-id="dup">B</td>'
            '</tr></table>')
        ok, result = D.update_text_many(s, [{"id": "dup", "text": "One"}])
        self.assertTrue(ok)
        self.assertEqual([td.get_text() for td in s.find_all("td")], ["One", "B"])


# --- table_operation -------------------------------------------------------

class TableOperation(unittest.TestCase):
    def test_insert_row_after_clones_structure_blank_and_assigns_ids(self):
        s = soup(
            '<table data-edit-id="e1"><tbody data-edit-id="e2">'
            '<tr data-edit-id="e3"><td data-edit-id="e4"><span class="badge" data-edit-id="e5">A</span></td>'
            '<td data-edit-id="e6">B</td></tr>'
            '</tbody></table>')
        ok, result = D.table_operation(s, "e4", "row-insert-after", include_table_html=True)
        self.assertTrue(ok)
        rows = s.find_all("tr")
        self.assertEqual(len(rows), 2)
        self.assertEqual([cell.get_text() for cell in rows[1].find_all("td")], ["", ""])
        self.assertEqual(rows[1].find("span")["class"], ["badge"])
        self.assertTrue(rows[1].find("td").has_attr("data-edit-id"))
        self.assertNotEqual(rows[1].find("td")["data-edit-id"], "e4")
        self.assertEqual(result["action"], "row-insert-after")
        self.assertEqual(result["table_id"], "e1")
        self.assertIn("<table", result["table_html"])
        self.assertIn("data-edit-id=\"e1\"", result["table_html"])

    def test_delete_column_removes_that_cell_from_each_row(self):
        s = soup(
            '<table><tr><td data-edit-id="e1">A</td><td data-edit-id="e2">B</td></tr>'
            '<tr><td data-edit-id="e3">C</td><td data-edit-id="e4">D</td></tr></table>')
        ok, result = D.table_operation(s, "e2", "col-delete")
        self.assertTrue(ok)
        self.assertEqual([[td.get_text() for td in tr.find_all("td")] for tr in s.find_all("tr")],
                         [["A"], ["C"]])
        self.assertEqual(result["selection_id"], "e1")
        self.assertNotIn("table_html", result)
        self.assertNotIn("table_id", result)

    def test_move_row_up_reorders_within_row_group(self):
        s = soup(
            '<table><tbody>'
            '<tr><td data-edit-id="e1">A</td></tr>'
            '<tr><td data-edit-id="e2">B</td></tr>'
            '</tbody></table>')
        ok, _ = D.table_operation(s, "e2", "row-move-up")
        self.assertTrue(ok)
        self.assertEqual([td.get_text() for td in s.find_all("td")], ["B", "A"])

    def test_rejects_rowspan_tables_for_now(self):
        s = soup(
            '<table><tr><td data-edit-id="e1" rowspan="2">A</td><td data-edit-id="e2">B</td></tr>'
            '<tr><td data-edit-id="e3">C</td></tr></table>')
        ok, result = D.table_operation(s, "e2", "col-insert-after")
        self.assertFalse(ok)
        self.assertEqual(result["status"], 400)
        self.assertIn("rowspan", result["error"])

    def test_rejects_column_edits_when_colgroup_present(self):
        s = soup(
            '<table><colgroup><col class="wide"/></colgroup>'
            '<tr><td data-edit-id="e1">A</td></tr></table>')
        ok, result = D.table_operation(s, "e1", "col-insert-after")
        self.assertFalse(ok)
        self.assertEqual(result["status"], 400)
        self.assertIn("colgroup", result["error"])

    def _three_row_table(self) -> BeautifulSoup:
        return soup(
            '<table data-edit-id="t1"><tbody data-edit-id="tb1">'
            '<tr data-edit-id="r1"><td data-edit-id="a1">A</td><td data-edit-id="a2">B</td></tr>'
            '<tr data-edit-id="r2"><td data-edit-id="b1">C</td><td data-edit-id="b2">D</td></tr>'
            '<tr data-edit-id="r3"><td data-edit-id="c1">E</td><td data-edit-id="c2">F</td></tr>'
            '</tbody></table>')

    def test_row_move_to_moves_row_before_target(self):
        s = self._three_row_table()
        ok, _ = D.table_operation(s, "c1", "row-move-to", target_index=0, mode="before")
        self.assertTrue(ok)
        self.assertEqual(
            [td.get_text() for td in s.find_all("td")],
            ["E", "F", "A", "B", "C", "D"])

    def test_row_move_to_moves_row_after_target(self):
        s = self._three_row_table()
        ok, _ = D.table_operation(s, "a1", "row-move-to", target_index=2, mode="after")
        self.assertTrue(ok)
        self.assertEqual(
            [td.get_text() for td in s.find_all("td")],
            ["C", "D", "E", "F", "A", "B"])

    def test_row_move_to_rejects_target_equals_source(self):
        s = self._three_row_table()
        ok, result = D.table_operation(s, "b1", "row-move-to", target_index=1, mode="before")
        self.assertFalse(ok)
        self.assertEqual(result["status"], 400)
        self.assertIn("already at that position", result["error"])

    def test_row_move_to_rejects_noop_neighbor(self):
        # dropping the second row 'after' the first row is a no-op (2 stays 2nd)
        s = self._three_row_table()
        ok, result = D.table_operation(s, "b1", "row-move-to", target_index=0, mode="after")
        self.assertFalse(ok)
        self.assertIn("already at that position", result["error"])

    def test_row_move_to_out_of_range(self):
        s = self._three_row_table()
        ok, result = D.table_operation(s, "a1", "row-move-to", target_index=5, mode="before")
        self.assertFalse(ok)
        self.assertIn("out of range", result["error"])

    def test_row_move_to_rejects_cross_section(self):
        s = soup(
            '<table><thead><tr><td data-edit-id="h1">H</td></tr></thead>'
            '<tbody><tr><td data-edit-id="b1">B</td></tr></tbody></table>')
        ok, result = D.table_operation(s, "b1", "row-move-to", target_index=0, mode="before")
        self.assertFalse(ok)
        self.assertIn("thead/tbody/tfoot", result["error"])

    def test_row_move_to_requires_target_index(self):
        s = self._three_row_table()
        ok, result = D.table_operation(s, "a1", "row-move-to")
        self.assertFalse(ok)
        self.assertIn("target_index", result["error"])

    def test_row_move_to_rejects_bad_mode(self):
        s = self._three_row_table()
        ok, result = D.table_operation(s, "a1", "row-move-to", target_index=2, mode="around")
        self.assertFalse(ok)
        self.assertIn("before", result["error"])

    def test_col_move_to_before_target(self):
        s = self._three_row_table()
        ok, _ = D.table_operation(s, "a2", "col-move-to", target_index=0, mode="before")
        self.assertTrue(ok)
        rows = [[td.get_text() for td in tr.find_all("td")] for tr in s.find_all("tr")]
        self.assertEqual(rows, [["B", "A"], ["D", "C"], ["F", "E"]])

    def test_col_move_to_after_target(self):
        s = self._three_row_table()
        ok, _ = D.table_operation(s, "a1", "col-move-to", target_index=1, mode="after")
        self.assertTrue(ok)
        rows = [[td.get_text() for td in tr.find_all("td")] for tr in s.find_all("tr")]
        self.assertEqual(rows, [["B", "A"], ["D", "C"], ["F", "E"]])

    def test_col_move_to_rejects_same_column(self):
        s = self._three_row_table()
        ok, result = D.table_operation(s, "a1", "col-move-to", target_index=0, mode="before")
        self.assertFalse(ok)
        self.assertIn("already at that position", result["error"])

    def test_col_move_to_out_of_range(self):
        s = self._three_row_table()
        ok, result = D.table_operation(s, "a1", "col-move-to", target_index=4, mode="before")
        self.assertFalse(ok)
        self.assertIn("out of range", result["error"])


# --- duplicate_element -----------------------------------------------------

class DuplicateElement(unittest.TestCase):
    def test_duplicates_html_element_with_fresh_ids(self):
        s = soup(
            '<section id="original" data-edit-id="e1"><p id="child" data-edit-id="e2">Hello</p></section>'
            '<p data-edit-id="e3">After</p>')
        ok, result = D.duplicate_element(s, "e1")
        self.assertTrue(ok)
        sections = s.find_all("section")
        self.assertEqual(len(sections), 2)
        self.assertEqual(sections[1].get_text(), "Hello")
        self.assertNotEqual(sections[1]["data-edit-id"], "e1")
        self.assertFalse(sections[1].has_attr("id"))
        self.assertNotEqual(sections[1].find("p")["data-edit-id"], "e2")
        self.assertFalse(sections[1].find("p").has_attr("id"))
        self.assertEqual(result["new_id"], sections[1]["data-edit-id"])

    def test_rejects_table_internal_duplicates(self):
        s = soup('<table><tr><td data-edit-id="e1">A</td></tr></table>')
        ok, result = D.duplicate_element(s, "e1")
        self.assertFalse(ok)
        self.assertEqual(result["status"], 400)
        self.assertIn("table internals", result["error"])

    def test_duplicates_orphan_svg_text_with_offset(self):
        s = soup('<svg><text data-edit-id="e1">Label</text></svg>')
        ok, result = D.duplicate_element(s, "e1")
        self.assertTrue(ok)
        texts = s.find_all("text")
        self.assertEqual(len(texts), 2)
        self.assertEqual(texts[1].get_text(), "Label")
        self.assertIn("translate(12.00 12.00)", texts[1]["transform"])
        self.assertNotEqual(result["new_id"], "e1")


# --- update_svg_labels ------------------------------------------------------

class UpdateSvgLabels(unittest.TestCase):
    def test_orphan_text(self):
        s = soup('<svg><text data-edit-id="e1">a</text></svg>')
        ok, result = D.update_svg_labels(s, "e1", ["b"])
        self.assertTrue(ok)
        self.assertEqual(s.find("text").get_text(), "b")
        self.assertFalse(result["formatting_lost"])

    def test_labelled_group_with_multiple_texts(self):
        s = soup(
            '<svg><g data-edit-id="e1">'
            '<text>title</text><text>subtitle</text>'
            '</g></svg>')
        ok, _ = D.update_svg_labels(s, "e1", ["TITLE", "SUB"])
        self.assertTrue(ok)
        texts = s.find_all("text")
        self.assertEqual(texts[0].get_text(), "TITLE")
        self.assertEqual(texts[1].get_text(), "SUB")

    def test_wrong_line_count_rejected(self):
        s = soup('<svg><g data-edit-id="e1"><text>a</text></g></svg>')
        ok, result = D.update_svg_labels(s, "e1", ["a", "b"])
        self.assertFalse(ok)
        self.assertEqual(result["status"], 400)

    def test_container_group_rejected(self):
        s = soup(
            '<svg><g data-edit-id="e1">'
            '<g data-edit-id="e2"><text>x</text></g>'
            '</g></svg>')
        ok, result = D.update_svg_labels(s, "e1", ["y"])
        self.assertFalse(ok)
        self.assertIn("leaf", result["error"])

    def test_group_without_text_rejected(self):
        s = soup('<svg><g data-edit-id="e1"><rect/></g></svg>')
        ok, result = D.update_svg_labels(s, "e1", [])
        self.assertFalse(ok)
        self.assertIn("no text labels", result["error"])

    def test_html_element_rejected(self):
        s = soup('<p data-edit-id="e1">x</p>')
        ok, result = D.update_svg_labels(s, "e1", ["y"])
        self.assertFalse(ok)
        self.assertIn("not inside an SVG", result["error"])

    def test_cross_segment_edit_reports_formatting_lost(self):
        s = soup(
            '<svg><text data-edit-id="e1">a<tspan font-family="mono">b</tspan>c</text></svg>')
        ok, result = D.update_svg_labels(s, "e1", ["xyz"])
        self.assertTrue(ok)
        self.assertTrue(result["formatting_lost"])
        self.assertIsNone(s.find("tspan"))


# --- move_element -----------------------------------------------------------

class MoveElement(unittest.TestCase):
    def _doc(self):
        return soup(
            '<div data-edit-id="root">'
            '<p data-edit-id="a">A</p>'
            '<p data-edit-id="b">B</p>'
            '<p data-edit-id="c">C</p>'
            '</div>')

    def test_move_before(self):
        s = self._doc()
        ok, _ = D.move_element(s, "c", "a", "before")
        self.assertTrue(ok)
        ids = [p["data-edit-id"] for p in s.find_all("p")]
        self.assertEqual(ids, ["c", "a", "b"])

    def test_move_after(self):
        s = self._doc()
        ok, _ = D.move_element(s, "a", "c", "after")
        self.assertTrue(ok)
        ids = [p["data-edit-id"] for p in s.find_all("p")]
        self.assertEqual(ids, ["b", "c", "a"])

    def test_rejects_self_move(self):
        s = self._doc()
        ok, result = D.move_element(s, "a", "a", "after")
        self.assertFalse(ok)
        self.assertIn("relative to itself", result["error"])

    def test_rejects_invalid_position(self):
        s = self._doc()
        ok, result = D.move_element(s, "a", "b", "sideways")
        self.assertFalse(ok)
        self.assertIn("before|after", result["error"])

    def test_404_on_missing_source(self):
        s = self._doc()
        ok, result = D.move_element(s, "missing", "a", "before")
        self.assertEqual(result["status"], 404)

    def test_404_on_missing_target(self):
        s = self._doc()
        ok, result = D.move_element(s, "a", "missing", "before")
        self.assertEqual(result["status"], 404)

    def test_rejects_moving_into_own_descendant(self):
        s = soup(
            '<div data-edit-id="outer">'
            '<div data-edit-id="inner"><p data-edit-id="leaf">x</p></div>'
            '</div>')
        ok, result = D.move_element(s, "outer", "leaf", "before")
        self.assertFalse(ok)
        self.assertIn("descendant", result["error"])

    def test_rejects_svg_move(self):
        s = soup(
            '<div><svg>'
            '<g data-edit-id="a"><text>A</text></g>'
            '<g data-edit-id="b"><text>B</text></g>'
            '</svg></div>')
        ok, result = D.move_element(s, "a", "b", "before")
        self.assertFalse(ok)
        self.assertIn("SVG", result["error"])


# --- move_svg ---------------------------------------------------------------

class MoveSvg(unittest.TestCase):
    def test_adds_translate_when_missing(self):
        s = soup('<svg><g data-edit-id="e1"><text>x</text></g></svg>')
        ok, _ = D.move_svg(s, "e1", 10.5, -3.25)
        self.assertTrue(ok)
        self.assertEqual(s.find("g")["transform"], "translate(10.50 -3.25)")

    def test_replaces_existing_translate(self):
        s = soup(
            '<svg><g data-edit-id="e1" transform="translate(5 5) rotate(45)">'
            '<text>x</text></g></svg>')
        ok, _ = D.move_svg(s, "e1", 1.0, 2.0)
        self.assertTrue(ok)
        self.assertEqual(s.find("g")["transform"],
                         "translate(1.00 2.00) rotate(45)")

    def test_rejects_non_svg_element(self):
        s = soup('<p data-edit-id="e1">x</p>')
        ok, result = D.move_svg(s, "e1", 0, 0)
        self.assertFalse(ok)

    def test_rejects_container_group(self):
        s = soup(
            '<svg><g data-edit-id="outer">'
            '<g data-edit-id="inner"><text>x</text></g>'
            '</g></svg>')
        ok, result = D.move_svg(s, "outer", 1, 1)
        self.assertFalse(ok)
        self.assertIn("leaf", result["error"])

    def test_404_on_missing(self):
        s = soup('<svg><g data-edit-id="e1"><text>x</text></g></svg>')
        ok, result = D.move_svg(s, "missing", 0, 0)
        self.assertEqual(result["status"], 404)


# --- resize_element ---------------------------------------------------------

class ResizeElement(unittest.TestCase):
    def test_applies_width_and_height(self):
        s = soup('<div data-edit-id="e1">x</div>')
        ok, result = D.resize_element(s, "e1", width="200px", height="100px")
        self.assertTrue(ok)
        self.assertIn("width: 200px", result["style"])
        self.assertIn("height: 100px", result["style"])

    def test_strips_style_when_empty(self):
        s = soup('<div data-edit-id="e1" style="width: 50px">x</div>')
        ok, _ = D.resize_element(s, "e1", width="")
        self.assertTrue(ok)
        self.assertFalse(s.find("div").has_attr("style"))

    def test_max_width_applied(self):
        s = soup('<div data-edit-id="e1">x</div>')
        ok, result = D.resize_element(s, "e1", width="500px", max_width="none")
        self.assertTrue(ok)
        self.assertIn("max-width: none", result["style"])

    def test_preserves_other_style_properties(self):
        s = soup('<div data-edit-id="e1" style="color: red; padding: 4px">x</div>')
        ok, result = D.resize_element(s, "e1", width="100px")
        self.assertTrue(ok)
        self.assertIn("color: red", result["style"])
        self.assertIn("padding: 4px", result["style"])
        self.assertIn("width: 100px", result["style"])

    def test_rejects_svg_element(self):
        s = soup('<svg><g data-edit-id="e1"><text>x</text></g></svg>')
        ok, result = D.resize_element(s, "e1", width="100px")
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
