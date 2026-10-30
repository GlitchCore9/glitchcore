"""Движок сценария: хранит экраны, кнопки, формы и заявки. Не зависит от Telegram."""
import csv
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

PHONE_RE = re.compile(r"^\+?[\d\s\-()]{7,20}$")
NODE_ID_RE = re.compile(r"^[a-z0-9_]{1,30}$")


class Scenario:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    @property
    def settings(self) -> dict:
        return self.data["settings"]

    @property
    def nodes(self) -> dict:
        return self.data["nodes"]

    @property
    def forms(self) -> dict:
        return self.data["forms"]

    def node(self, node_id: str) -> dict | None:
        return self.nodes.get(node_id)

    # --- экраны ---
    def set_text(self, node_id: str, text: str) -> None:
        self.nodes[node_id]["text"] = text
        self.save()

    def add_node(self, node_id: str, text: str) -> None:
        if not NODE_ID_RE.match(node_id):
            raise ValueError("ID: только латиница, цифры и _ (до 30 символов)")
        if node_id in self.nodes:
            raise ValueError("Экран с таким ID уже есть")
        self.nodes[node_id] = {"text": text, "buttons": []}
        self.save()

    def delete_node(self, node_id: str) -> None:
        if node_id == self.settings["start_node"]:
            raise ValueError("Стартовый экран удалить нельзя")
        self.nodes.pop(node_id, None)
        for n in self.nodes.values():
            n["buttons"] = [b for b in n["buttons"] if b.get("goto") != node_id]
        self.save()

    # --- кнопки ---
    def add_button(self, node_id: str, title: str, kind: str, target: str) -> None:
        """kind: goto | form | url."""
        if kind == "goto" and target not in self.nodes:
            raise ValueError("Нет такого экрана")
        if kind == "form" and target not in self.forms:
            raise ValueError("Нет такой формы")
        if kind == "url" and not target.startswith(("http://", "https://")):
            raise ValueError("Ссылка должна начинаться с http:// или https://")
        if kind not in ("goto", "form", "url"):
            raise ValueError("Неизвестный тип кнопки")
        self.nodes[node_id]["buttons"].append({"text": title, kind: target})
        self.save()

    def delete_button(self, node_id: str, index: int) -> None:
        del self.nodes[node_id]["buttons"][index]
        self.save()

    # --- формы ---
    def set_question(self, form_id: str, index: int, question: str) -> None:
        self.forms[form_id]["fields"][index]["question"] = question
        self.save()

    def set_done_text(self, form_id: str, text: str) -> None:
        self.forms[form_id]["done_text"] = text
        self.save()

    def set_manager_chat(self, chat_id: int | None) -> None:
        self.settings["manager_chat_id"] = chat_id
        self.save()


def validate_answer(field: dict, value: str) -> str:
    """Возвращает очищенное значение или бросает ValueError с текстом для пользователя."""
    value = value.strip()
    if not value:
        raise ValueError("Ответ не должен быть пустым")
    if len(value) > 500:
        raise ValueError("Слишком длинный ответ (максимум 500 символов)")
    if field.get("type") == "phone" and not PHONE_RE.match(value):
        raise ValueError("Введите телефон, например +7 900 123-45-67")
    return value


def format_lead(form: dict, answers: dict, user_label: str) -> str:
    lines = [f"Новая заявка: {form['title']}", f"От: {user_label}"]
    for f in form["fields"]:
        lines.append(f"{f['label']}: {answers.get(f['key'], '-')}")
    return "\n".join(lines)


class LeadStore:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " created TEXT, form TEXT, user_id INTEGER, username TEXT, answers TEXT)"
        )
        self.db.commit()

    def add(self, form: str, user_id: int, username: str, answers: dict) -> int:
        cur = self.db.execute(
            "INSERT INTO leads (created, form, user_id, username, answers) VALUES (?,?,?,?,?)",
            (datetime.now().isoformat(timespec="seconds"), form, user_id, username,
             json.dumps(answers, ensure_ascii=False)),
        )
        self.db.commit()
        return cur.lastrowid

    def last(self, limit: int = 10) -> list[tuple]:
        return self.db.execute(
            "SELECT id, created, form, username, answers FROM leads ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM leads").fetchone()[0]

    def export_csv(self, out: Path) -> Path:
        rows = self.db.execute(
            "SELECT id, created, form, user_id, username, answers FROM leads ORDER BY id"
        ).fetchall()
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["id", "дата", "форма", "user_id", "username", "ответы"])
            w.writerows(rows)
        return out
