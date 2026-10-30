import asyncio
import logging
import os
from pathlib import Path
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import Message, FSInputFile
from aiogram.enums import MessageEntityType
from aiogram.exceptions import TelegramRetryAfter

# Токен бота
BOT_TOKEN = os.environ["BOT_TOKEN"]

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
chat_send_locks: dict[int, asyncio.Lock] = {}
last_document_sent: dict[int, float] = {}


def get_sticker_extension(sticker) -> str:
    """Определяет расширение файла стикера/эмодзи в зависимости от типа."""
    if sticker.is_video:
        return "webm"  # Видео-стикер (WebM с прозрачностью)
    elif sticker.is_animated:
        return "tgs"   # Векторная Lottie-анимация (gzip JSON)
    return "webp"      # Статичный стикер / эмодзи


async def download_and_reply_file(message: Message, file_id: str, filename: str, description: str):
    """Скачивает файл и отправляет его пользователю обратно в виде документа с обработкой Flood Control."""
    file_path = DOWNLOAD_DIR / filename
    try:
        file_info = await bot.get_file(file_id)
        if not file_info.file_path:
            raise RuntimeError("Не удалось получить путь к файлу от Telegram API")

        await bot.download_file(file_info.file_path, destination=file_path)

        chat_id = message.chat.id
        send_lock = chat_send_locks.setdefault(chat_id, asyncio.Lock())
        async with send_lock:
            for attempt in range(5):
                elapsed = asyncio.get_running_loop().time() - last_document_sent.get(chat_id, 0)
                if elapsed < 1.2:
                    await asyncio.sleep(1.2 - elapsed)

                try:
                    await message.reply_document(
                        document=FSInputFile(file_path),
                        caption=f"✅ {description.capitalize()} успешно скачан!\n📁 Формат: `.{file_path.suffix.lstrip('.')}`",
                        parse_mode="Markdown"
                    )
                    last_document_sent[chat_id] = asyncio.get_running_loop().time()
                    break
                except TelegramRetryAfter as flood_err:
                    if attempt == 4:
                        raise
                    wait_time = flood_err.retry_after + 1
                    logging.warning(f"Flood control: ожидание {wait_time} с перед повторной отправкой...")
                    await asyncio.sleep(wait_time)

    except Exception as e:
        await message.reply(f"❌ Ошибка при скачивании {description}: {e}")


@dp.message(CommandStart())
async def start_handler(message: Message):
    await message.answer(
        "👋 **Привет! Я бот для сохранения стикеров, эмодзи и гифок.**\n\n"
        "Отправь мне:\n"
        "• Обычный статичный стикер (`.webp`)\n"
        "• Анимированный стикер (`.tgs`)\n"
        "• Видео-стикер (`.webm`)\n"
        "• GIF / Анимацию (`.mp4` / `.gif`)\n"
        "• Сообщение с кастомными эмодзи (Telegram Premium)\n\n"
        "Я сохраню оригинал и пришлю его тебе документом!",
        parse_mode="Markdown"
    )


# 1. Обработка обычных, анимированных и видео-стикеров
@dp.message(F.sticker)
async def sticker_handler(message: Message):
    sticker = message.sticker
    ext = get_sticker_extension(sticker)

    if sticker.is_video:
        type_name = "видео-стикер"
    elif sticker.is_animated:
        type_name = "анимированный стикер"
    else:
        type_name = "статичный стикер"

    filename = f"sticker_{sticker.file_unique_id}.{ext}"

    await download_and_reply_file(
        message=message,
        file_id=sticker.file_id,
        filename=filename,
        description=type_name
    )


# 2. Обработка GIF / анимаций
@dp.message(F.animation)
async def animation_handler(message: Message):
    anim = message.animation
    ext = "gif" if anim.mime_type == "image/gif" else "mp4"
    filename = f"animation_{anim.file_unique_id}.{ext}"

    await download_and_reply_file(
        message=message,
        file_id=anim.file_id,
        filename=filename,
        description="GIF/Анимацию"
    )


# 3. Обработка кастомных эмодзи в тексте и подписях к медиа
@dp.message(F.text | F.caption)
async def custom_emoji_handler(message: Message):
    entities = (message.entities or []) + (message.caption_entities or [])

    custom_emoji_ids = [
        entity.custom_emoji_id
        for entity in entities
        if entity.type == MessageEntityType.CUSTOM_EMOJI and entity.custom_emoji_id
    ]

    if not custom_emoji_ids:
        return

    logging.info("Найдено custom emoji в сообщении: %d", len(custom_emoji_ids))

    for index, custom_emoji_id in enumerate(custom_emoji_ids, start=1):
        try:
            stickers = await bot.get_custom_emoji_stickers(custom_emoji_ids=[custom_emoji_id])
        except Exception as e:
            logging.exception("Не удалось получить custom emoji %d/%d", index, len(custom_emoji_ids))
            await message.reply(f"❌ Не удалось получить эмодзи {index}: {e}")
            continue

        if not stickers:
            logging.warning("Telegram не вернул custom emoji %d/%d", index, len(custom_emoji_ids))
            continue

        sticker = stickers[0]
        logging.info("Обрабатываю custom emoji %d/%d: %s", index, len(custom_emoji_ids), sticker.file_unique_id)
        ext = get_sticker_extension(sticker)
        if sticker.is_video:
            type_name = "видео-эмодзи"
        elif sticker.is_animated:
            type_name = "анимированный эмодзи"
        else:
            type_name = "статичный эмодзи"

        filename = f"emoji_{sticker.file_unique_id}.{ext}"
        await download_and_reply_file(
            message=message,
            file_id=sticker.file_id,
            filename=filename,
            description=type_name
        )


async def main():
    logging.basicConfig(level=logging.INFO)
    print("Бот успешно запущен и ожидает сообщений...")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
