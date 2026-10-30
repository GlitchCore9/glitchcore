import asyncio
import shutil
from datetime import datetime
from pathlib import Path

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.session.base import BaseSession
from aiogram.methods import AnswerCallbackQuery, EditMessageText, SendMessage
from aiogram.types import Chat, Message, Update, User

from bot import build_router
from engine import LeadStore, Scenario, validate_answer

SRC = Path(__file__).parent / "scenario.json"


@pytest.fixture
def sc(tmp_path):
    p = tmp_path / "scenario.json"
    shutil.copy(SRC, p)
    return Scenario(p)


def test_validate_phone():
    f = {"type": "phone"}
    assert validate_answer(f, " +7 900 123-45-67 ") == "+7 900 123-45-67"
    with pytest.raises(ValueError):
        validate_answer(f, "abc")
    with pytest.raises(ValueError):
        validate_answer({"type": "text"}, "   ")


def test_edit_persists(sc):
    sc.set_text("start", "Новый текст")
    sc.add_node("prices", "Цены")
    sc.add_button("start", "Цены", "goto", "prices")
    again = Scenario(sc.path)
    assert again.nodes["start"]["text"] == "Новый текст"
    assert again.nodes["start"]["buttons"][-1] == {"text": "Цены", "goto": "prices"}


def test_bad_edits(sc):
    with pytest.raises(ValueError):
        sc.add_node("Bad ID", "x")
    with pytest.raises(ValueError):
        sc.add_node("start", "x")
    with pytest.raises(ValueError):
        sc.add_button("start", "x", "url", "javascript:alert(1)")
    with pytest.raises(ValueError):
        sc.delete_node("start")


def test_delete_node_removes_links(sc):
    sc.delete_node("contacts")
    assert all(b.get("goto") != "contacts" for n in sc.nodes.values() for b in n["buttons"])


def test_leads_export(tmp_path):
    store = LeadStore(tmp_path / "l.db")
    store.add("lead", 1, "u", {"name": "Иван"})
    out = store.export_csv(tmp_path / "o.csv")
    assert "Иван" in out.read_text(encoding="utf-8-sig")


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.calls = []

    async def make_request(self, bot, method, timeout=None):
        self.calls.append(method)
        if isinstance(method, SendMessage):
            return Message(message_id=len(self.calls), date=datetime.now(),
                           chat=Chat(id=method.chat_id, type="private"), text=method.text)
        return True

    async def close(self): ...
    async def stream_content(self, *a, **k): yield b""


def _msg(uid, text, n):
    return Update(update_id=n, message=Message(
        message_id=n, date=datetime.now(), chat=Chat(id=uid, type="private"),
        from_user=User(id=uid, is_bot=False, first_name="T", username="tester"), text=text))


def test_full_lead_flow_and_admin(sc, tmp_path):
    async def run():
        session = FakeSession()
        bot = Bot("123:ABC", session=session)
        leads = LeadStore(tmp_path / "l.db")
        sc.set_manager_chat(999)
        dp = Dispatcher()
        dp.include_router(build_router(sc, leads, {42}))
        from aiogram.types import CallbackQuery

        def cb(uid, data, n):
            return Update(update_id=n, callback_query=CallbackQuery(
                id=str(n), chat_instance="x", data=data,
                from_user=User(id=uid, is_bot=False, first_name="T", username="tester"),
                message=Message(message_id=1, date=datetime.now(), chat=Chat(id=uid, type="private"), text="x")))

        await dp.feed_update(bot, _msg(5, "/start", 1))
        await dp.feed_update(bot, cb(5, "f:lead", 2))
        await dp.feed_update(bot, _msg(5, "Иван", 3))
        await dp.feed_update(bot, _msg(5, "не телефон", 4))
        await dp.feed_update(bot, _msg(5, "+7 900 111-22-33", 5))
        await dp.feed_update(bot, _msg(5, "Нужен бот", 6))
        assert leads.count() == 1
        sent = [c for c in session.calls if isinstance(c, SendMessage)]
        assert any(c.chat_id == 999 and "Иван" in c.text and "Нужен бот" in c.text for c in sent)
        assert any("Введите телефон" in c.text for c in sent)

        # не-админ не может менять текст
        await dp.feed_update(bot, cb(5, "a:text:start", 7))
        await dp.feed_update(bot, _msg(5, "ВЗЛОМ", 8))
        assert sc.nodes["start"]["text"] != "ВЗЛОМ"

        # админ меняет текст
        await dp.feed_update(bot, cb(42, "a:text:start", 9))
        await dp.feed_update(bot, _msg(42, "Привет от админа", 10))
        assert Scenario(sc.path).nodes["start"]["text"] == "Привет от админа"

    asyncio.run(run())
