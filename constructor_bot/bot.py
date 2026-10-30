"""Telegram-бот-конструктор. Содержимое и логика берутся из scenario.json,
владелец редактирует их прямо в Telegram через /admin."""
import asyncio
import logging
import os
from pathlib import Path

from aiogram import Bot, Dispatcher, F, Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (CallbackQuery, FSInputFile, InlineKeyboardButton,
                           InlineKeyboardMarkup, Message)

from engine import LeadStore, Scenario, format_lead, validate_answer

BASE = Path(__file__).resolve().parent


class FormSt(StatesGroup):
    filling = State()


class AdminSt(StatesGroup):
    edit_text = State()
    new_node_id = State()
    new_node_text = State()
    btn_title = State()
    btn_url = State()
    edit_question = State()
    edit_done = State()


def kb(rows: list[list[InlineKeyboardButton]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=rows)


def btn(text: str, data: str | None = None, url: str | None = None) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, callback_data=data, url=url)


def node_markup(sc: Scenario, node_id: str) -> InlineKeyboardMarkup:
    rows = []
    for b in sc.nodes[node_id]["buttons"]:
        if "goto" in b:
            rows.append([btn(b["text"], f"n:{b['goto']}")])
        elif "form" in b:
            rows.append([btn(b["text"], f"f:{b['form']}")])
        else:
            rows.append([btn(b["text"], url=b["url"])])
    if node_id != sc.settings["start_node"]:
        rows.append([btn("« В начало", f"n:{sc.settings['start_node']}")])
    return kb(rows)


def build_router(sc: Scenario, leads: LeadStore, admin_ids: set[int]) -> Router:
    r = Router()
    is_admin = lambda uid: uid in admin_ids  # noqa: E731

    # ---------- пользователь ----------
    async def show_node(target: Message, node_id: str, edit: bool = False):
        node = sc.node(node_id) or sc.node(sc.settings["start_node"])
        node_id = node_id if sc.node(node_id) else sc.settings["start_node"]
        markup = node_markup(sc, node_id)
        if edit:
            try:
                await target.edit_text(node["text"], reply_markup=markup)
                return
            except Exception:
                pass
        await target.answer(node["text"], reply_markup=markup)

    @r.message(CommandStart())
    async def start(m: Message, state: FSMContext):
        await state.clear()
        await show_node(m, sc.settings["start_node"])

    @r.message(Command("myid"))
    async def myid(m: Message):
        await m.answer(f"Ваш ID: {m.from_user.id}\nID этого чата: {m.chat.id}")

    @r.callback_query(F.data.startswith("n:"))
    async def goto(c: CallbackQuery, state: FSMContext):
        await state.clear()
        await show_node(c.message, c.data[2:], edit=True)
        await c.answer()

    @r.callback_query(F.data.startswith("f:"))
    async def form_start(c: CallbackQuery, state: FSMContext):
        form_id = c.data[2:]
        if form_id not in sc.forms:
            return await c.answer("Форма не найдена", show_alert=True)
        await state.set_state(FormSt.filling)
        await state.update_data(form=form_id, step=0, answers={})
        await c.message.answer(sc.forms[form_id]["fields"][0]["question"])
        await c.answer()

    @r.message(FormSt.filling, F.text)
    async def form_step(m: Message, state: FSMContext):
        d = await state.get_data()
        form = sc.forms[d["form"]]
        field = form["fields"][d["step"]]
        try:
            value = validate_answer(field, m.text)
        except ValueError as e:
            return await m.answer(str(e))
        answers = {**d["answers"], field["key"]: value}
        step = d["step"] + 1
        if step < len(form["fields"]):
            await state.update_data(step=step, answers=answers)
            return await m.answer(form["fields"][step]["question"])
        await state.clear()
        user = m.from_user
        label = f"@{user.username}" if user.username else f"{user.full_name} (id {user.id})"
        leads.add(d["form"], user.id, user.username or "", answers)
        manager = sc.settings.get("manager_chat_id")
        if manager:
            try:
                await m.bot.send_message(manager, format_lead(form, answers, label))
            except Exception:
                logging.exception("Не удалось отправить заявку менеджеру")
        await m.answer(form["done_text"])
        await show_node(m, sc.settings["start_node"])

    # ---------- админка ----------
    def admin_menu() -> InlineKeyboardMarkup:
        return kb([
            [btn("Экраны и кнопки", "a:nodes")],
            [btn("Формы (вопросы)", "a:forms")],
            [btn(f"Заявки ({leads.count()})", "a:leads"), btn("Скачать CSV", "a:csv")],
            [btn("Этот чат = чат менеджера", "a:setmgr")],
        ])

    @r.message(Command("admin"))
    async def admin(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return await m.answer(f"Нет доступа. Ваш ID: {m.from_user.id}. Добавьте его в ADMIN_IDS в .env.")
        await state.clear()
        await m.answer("Панель управления ботом:", reply_markup=admin_menu())

    def guard(c: CallbackQuery) -> bool:
        return is_admin(c.from_user.id)

    @r.callback_query(F.data == "a:menu")
    async def a_menu(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        await state.clear()
        await c.message.edit_text("Панель управления ботом:", reply_markup=admin_menu())
        await c.answer()

    @r.callback_query(F.data == "a:nodes")
    async def a_nodes(c: CallbackQuery):
        if not guard(c):
            return await c.answer()
        rows = [[btn(f"{i}", f"a:node:{i}")] for i in sc.nodes]
        rows.append([btn("+ Новый экран", "a:newnode")])
        rows.append([btn("« Меню", "a:menu")])
        await c.message.edit_text("Выберите экран:", reply_markup=kb(rows))
        await c.answer()

    async def node_card(msg: Message, node_id: str, edit: bool = True):
        node = sc.nodes[node_id]
        lines = [f"Экран: {node_id}", "", node["text"], "", "Кнопки:"]
        rows = [[btn("Изменить текст", f"a:text:{node_id}"), btn("+ Кнопка", f"a:addbtn:{node_id}")]]
        for i, b in enumerate(node["buttons"]):
            lines.append(f"{i + 1}. {b['text']}")
            rows.append([btn(f"Удалить: {b['text']}", f"a:delbtn:{node_id}:{i}")])
        if not node["buttons"]:
            lines.append("(нет)")
        if node_id != sc.settings["start_node"]:
            rows.append([btn("Удалить экран", f"a:delnode:{node_id}")])
        rows.append([btn("« К экранам", "a:nodes")])
        text = "\n".join(lines)
        if edit:
            await msg.edit_text(text, reply_markup=kb(rows))
        else:
            await msg.answer(text, reply_markup=kb(rows))

    @r.callback_query(F.data.startswith("a:node:"))
    async def a_node(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        await state.clear()
        await node_card(c.message, c.data.split(":", 2)[2])
        await c.answer()

    @r.callback_query(F.data.startswith("a:text:"))
    async def a_text(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        node_id = c.data.split(":", 2)[2]
        await state.set_state(AdminSt.edit_text)
        await state.update_data(node=node_id)
        await c.message.answer("Отправьте новый текст экрана одним сообщением:")
        await c.answer()

    @r.message(AdminSt.edit_text, F.text)
    async def a_text_in(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return
        d = await state.get_data()
        sc.set_text(d["node"], m.text)
        await state.clear()
        await node_card(m, d["node"], edit=False)

    @r.callback_query(F.data == "a:newnode")
    async def a_newnode(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        await state.set_state(AdminSt.new_node_id)
        await c.message.answer("Введите ID нового экрана (латиница, цифры, _), например: prices")
        await c.answer()

    @r.message(AdminSt.new_node_id, F.text)
    async def a_newnode_id(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return
        node_id = m.text.strip().lower()
        if node_id in sc.nodes:
            return await m.answer("Такой экран уже есть, введите другой ID")
        try:
            sc.add_node(node_id, "...")
        except ValueError as e:
            return await m.answer(str(e))
        await state.set_state(AdminSt.new_node_text)
        await state.update_data(node=node_id)
        await m.answer("Теперь отправьте текст экрана:")

    @r.message(AdminSt.new_node_text, F.text)
    async def a_newnode_text(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return
        d = await state.get_data()
        sc.set_text(d["node"], m.text)
        await state.clear()
        await node_card(m, d["node"], edit=False)

    @r.callback_query(F.data.startswith("a:delnode:"))
    async def a_delnode(c: CallbackQuery):
        if not guard(c):
            return await c.answer()
        try:
            sc.delete_node(c.data.split(":", 2)[2])
        except ValueError as e:
            return await c.answer(str(e), show_alert=True)
        await a_nodes(c)

    @r.callback_query(F.data.startswith("a:delbtn:"))
    async def a_delbtn(c: CallbackQuery):
        if not guard(c):
            return await c.answer()
        _, _, node_id, idx = c.data.split(":")
        sc.delete_button(node_id, int(idx))
        await node_card(c.message, node_id)
        await c.answer("Удалено")

    @r.callback_query(F.data.startswith("a:addbtn:"))
    async def a_addbtn(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        await state.set_state(AdminSt.btn_title)
        await state.update_data(node=c.data.split(":", 2)[2])
        await c.message.answer("Введите надпись на кнопке:")
        await c.answer()

    @r.message(AdminSt.btn_title, F.text)
    async def a_btn_title(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return
        title = m.text.strip()[:60]
        await state.update_data(title=title)
        await m.answer("Что делает кнопка?", reply_markup=kb([
            [btn("Открывает экран", "a:bk:goto")],
            [btn("Запускает форму", "a:bk:form")],
            [btn("Открывает ссылку", "a:bk:url")],
        ]))

    @r.callback_query(F.data.startswith("a:bk:"))
    async def a_btn_kind(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        kind = c.data.split(":")[2]
        await state.update_data(kind=kind)
        if kind == "url":
            await state.set_state(AdminSt.btn_url)
            await c.message.answer("Отправьте ссылку (https://...):")
        else:
            items = sc.nodes if kind == "goto" else sc.forms
            rows = [[btn(i, f"a:bt:{i}")] for i in items]
            await c.message.answer("Выберите цель:", reply_markup=kb(rows))
        await c.answer()

    async def finish_button(msg: Message, state: FSMContext, target: str):
        d = await state.get_data()
        try:
            sc.add_button(d["node"], d["title"], d["kind"], target)
        except ValueError as e:
            return await msg.answer(str(e))
        await state.clear()
        await node_card(msg, d["node"], edit=False)

    @r.callback_query(F.data.startswith("a:bt:"))
    async def a_btn_target(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        await finish_button(c.message, state, c.data.split(":", 2)[2])
        await c.answer()

    @r.message(AdminSt.btn_url, F.text)
    async def a_btn_url(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return
        await finish_button(m, state, m.text.strip())

    # формы
    @r.callback_query(F.data == "a:forms")
    async def a_forms(c: CallbackQuery):
        if not guard(c):
            return await c.answer()
        rows = [[btn(f"{fid}: {f['title']}", f"a:form:{fid}")] for fid, f in sc.forms.items()]
        rows.append([btn("« Меню", "a:menu")])
        await c.message.edit_text("Выберите форму:", reply_markup=kb(rows))
        await c.answer()

    @r.callback_query(F.data.startswith("a:form:"))
    async def a_form(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        await state.clear()
        fid = c.data.split(":", 2)[2]
        form = sc.forms[fid]
        lines = [f"Форма: {form['title']}", ""]
        rows = []
        for i, f in enumerate(form["fields"]):
            lines.append(f"{i + 1}. {f['question']}")
            rows.append([btn(f"Изменить вопрос {i + 1}", f"a:q:{fid}:{i}")])
        lines += ["", f"Ответ после отправки: {form['done_text']}"]
        rows.append([btn("Изменить финальный ответ", f"a:done:{fid}")])
        rows.append([btn("« К формам", "a:forms")])
        await c.message.edit_text("\n".join(lines), reply_markup=kb(rows))
        await c.answer()

    @r.callback_query(F.data.startswith("a:q:"))
    async def a_q(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        _, _, fid, idx = c.data.split(":")
        await state.set_state(AdminSt.edit_question)
        await state.update_data(form=fid, idx=int(idx))
        await c.message.answer("Отправьте новый текст вопроса:")
        await c.answer()

    @r.message(AdminSt.edit_question, F.text)
    async def a_q_in(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return
        d = await state.get_data()
        sc.set_question(d["form"], d["idx"], m.text)
        await state.clear()
        await m.answer("Вопрос обновлён.", reply_markup=kb([[btn("« К форме", f"a:form:{d['form']}")]]))

    @r.callback_query(F.data.startswith("a:done:"))
    async def a_done(c: CallbackQuery, state: FSMContext):
        if not guard(c):
            return await c.answer()
        await state.set_state(AdminSt.edit_done)
        await state.update_data(form=c.data.split(":", 2)[2])
        await c.message.answer("Отправьте новый текст ответа после отправки формы:")
        await c.answer()

    @r.message(AdminSt.edit_done, F.text)
    async def a_done_in(m: Message, state: FSMContext):
        if not is_admin(m.from_user.id):
            return
        d = await state.get_data()
        sc.set_done_text(d["form"], m.text)
        await state.clear()
        await m.answer("Текст обновлён.", reply_markup=kb([[btn("« К форме", f"a:form:{d['form']}")]]))

    # заявки и настройки
    @r.callback_query(F.data == "a:leads")
    async def a_leads(c: CallbackQuery):
        if not guard(c):
            return await c.answer()
        rows = leads.last(10)
        text = "Последние заявки:\n\n" + "\n\n".join(
            f"#{i} {created} @{u or '-'}\n{a}" for i, created, _f, u, a in rows
        ) if rows else "Заявок пока нет."
        await c.message.edit_text(text[:4000], reply_markup=kb([[btn("« Меню", "a:menu")]]))
        await c.answer()

    @r.callback_query(F.data == "a:csv")
    async def a_csv(c: CallbackQuery):
        if not guard(c):
            return await c.answer()
        path = leads.export_csv(BASE / "leads_export.csv")
        await c.message.answer_document(FSInputFile(path), caption="Все заявки (откроется в Excel)")
        await c.answer()

    @r.callback_query(F.data == "a:setmgr")
    async def a_setmgr(c: CallbackQuery):
        if not guard(c):
            return await c.answer()
        sc.set_manager_chat(c.message.chat.id)
        await c.answer("Новые заявки будут приходить в этот чат", show_alert=True)

    return r


async def main():
    from dotenv import load_dotenv
    load_dotenv(BASE / ".env")
    token = os.environ["BOT_TOKEN"]
    admin_ids = {int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()}
    sc = Scenario(BASE / "scenario.json")
    leads = LeadStore(BASE / "leads.db")
    dp = Dispatcher()
    dp.include_router(build_router(sc, leads, admin_ids))
    bot = Bot(token=token)
    await dp.start_polling(bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
