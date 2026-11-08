
const BOT_TOKEN = process.env.BOT_TOKEN;

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SETUP_KEY = process.env.SETUP_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL;

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, data = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

function isAdmin(id) {
  return ADMIN_IDS.includes(String(id));
}

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getName(user) {
  return [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ") || "Unknown";
}

function getMediaType(msg) {
  if (msg.photo) return "PHOTO";
  if (msg.video) return "VIDEO";
  if (msg.document) return "DOCUMENT";
  if (msg.audio) return "AUDIO";
  if (msg.animation) return "GIF";
  if (msg.voice) return "VOICE";
  if (msg.video_note) return "VIDEO NOTE";
  if (msg.sticker) return "STICKER";
  return null;
}

function getUserId(caption) {
  const match = String(caption || "").match(
    /(?:user\s*id|uid)\s*[:\-]\s*([^\n]+)/i
  );

  return match ? match[1].trim() : "Not provided";
}

function createDetails(msg, requestId, mediaType) {
  const user = msg.from;
  const username = user.username
    ? `@${user.username}`
    : "Not available";

  const userId = getUserId(msg.caption);

  const originalCaption = msg.caption
    ? `User Message: ${msg.caption}\n\n`
    : "";

  const details =
    `━━━━━━━━━━━━━━━━\n` +
    `📩 NEW SUBMISSION\n` +
    `👤 Name: ${getName(user)}\n` +
    `🔹 Username: ${username}\n` +
    `🆔 Telegram ID: ${user.id}\n` +
    `🪪 User ID: ${userId}\n` +
    `📁 Media: ${mediaType}\n` +
    `🔖 Request ID: ${requestId}\n` +
    `🕒 Date: ${new Date().toLocaleString("en-GB", {
      timeZone: "Asia/Karachi"
    })}\n` +
    `⏳ Status: PENDING\n` +
    `━━━━━━━━━━━━━━━━`;

  return (originalCaption + details).slice(0, 1024);
}

async function sendWelcome(chatId, user) {
  if (isAdmin(user.id)) {
    return telegram("sendMessage", {
      chat_id: chatId,
      text:
        `👑 Welcome Admin!\n\n` +
        `Admin dashboard ke liye /panel bhejo.\n` +
        `Your Telegram ID: ${user.id}`
    });
  }

  return telegram("sendMessage", {
    chat_id: chatId,
    text:
      `👋 Welcome to THG Submission Bot!\n\n` +
      `Apni photo ya video bhejo.\n\n` +
      `Caption mein apna User ID likhna:\n` +
      `Example: User ID: 123456789\n\n` +
      `Tumhari submission admin ko review ke liye mil jayegi.`
  });
}

async function showPanel(chatId) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text:
      `👑 THG ADMIN PANEL\n\n` +
      `📩 User submissions admin ko yahin receive hongi.\n\n` +
      `Reply system:\n` +
      `1. User ki photo/video par Reply karo.\n` +
      `2. Apna message likh kar send karo.\n` +
      `3. Bot user ko tumhara reply bhej dega.\n\n` +
      `Media Telegram mein hi rahegi.\n` +
      `Kisi external database mein upload nahi hogi.`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔄 Refresh Panel",
            callback_data: "panel"
          }
        ],
        [
          {
            text: "🆔 My Admin ID",
            callback_data: "myid"
          }
        ]
      ]
    }
  });
}

async function handleMedia(msg) {
  const user = msg.from;
  const chatId = msg.chat.id;
  const mediaType = getMediaType(msg);

  if (!mediaType) return;

  const requestId = `THG-${Date.now()}`;
  const details = createDetails(msg, requestId, mediaType);

  let delivered = 0;

  for (const adminId of ADMIN_IDS) {
    try {
      const noCaption = Boolean(msg.video_note || msg.sticker);

      // Copy the original Telegram media.
      // It will NOT show a Forwarded label.
      const copyData = {
        chat_id: adminId,
        from_chat_id: chatId,
        message_id: msg.message_id
      };

      if (!noCaption) {
        copyData.caption = details;
      }

      const copied = await telegram("copyMessage", copyData);

      // For media without caption support, send details separately.
      if (noCaption) {
        await telegram("sendMessage", {
          chat_id: adminId,
          text: details,
          reply_markup: {
            force_reply: false
          }
        });
      }

      delivered++;

    } catch (error) {
      console.error(
        "Admin delivery error:",
        adminId,
        error.message
      );
    }
  }

  if (delivered > 0) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `✅ Your submission has been received!\n\n` +
        `Request ID: ${requestId}\n` +
        `Status: UNDER REVIEW`
    });
  } else {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        `❌ Submission deliver nahi ho saki.\n` +
        `Please thori dair baad dobara try karo.`
    });
  }
}

function getTargetTelegramId(replyMessage) {
  const text =
    replyMessage.caption ||
    replyMessage.text ||
    "";

  const match = text.match(/Telegram ID:\s*(\d+)/i);

  return match ? match[1] : null;
}

async function handleAdminReply(msg) {
  if (!msg.reply_to_message) return false;

  const targetId = getTargetTelegramId(msg.reply_to_message);

  if (!targetId) {
    await telegram("sendMessage", {
      chat_id: msg.chat.id,
      text: "❌ User ki Telegram ID nahi mili. Original submission par Reply karo."
    });
    return true;
  }

  // Admin sends text through the bot.
  if (msg.text) {
    await telegram("sendMessage", {
      chat_id: targetId,
      text: `📩 Admin Reply:\n\n${msg.text}`
    });
  }

  // Admin can also reply with a photo, video or another media.
  else {
    await telegram("copyMessage", {
      chat_id: targetId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }

  await telegram("sendMessage", {
    chat_id: msg.chat.id,
    text: "✅ Reply successfully sent to the user through THG Bot."
  });

  return true;
}

async function handleCallback(query) {
  const userId = query.from.id;
  const chatId = query.message.chat.id;

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id
  });

  if (!isAdmin(userId)) {
    return telegram("sendMessage", {
      chat_id: chatId,
      text: "⛔ Access Denied."
    });
  }

  if (query.data === "panel") {
    return showPanel(chatId);
  }

  if (query.data === "myid") {
    return telegram("sendMessage", {
      chat_id: chatId,
      text: `Your Admin ID: ${userId}`
    });
  }
}

export default async function handler(req, res) {
  try {
    if (!BOT_TOKEN || !WEBHOOK_SECRET) {
      return res.status(500).send("Missing bot environment variables.");
    }

    // Webhook setup
    if (req.method === "GET") {
      if (req.query?.setup) {
        if (req.query.setup !== SETUP_KEY) {
          return res.status(403).send("Invalid setup key.");
        }

        const result = await telegram("setWebhook", {
          url: `${PUBLIC_URL}/api/bot`,
          secret_token: WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"]
        });

        return res.status(200).send(
          result ? "Webhook setup: SUCCESS" : "Webhook setup failed."
        );
      }

      return res.status(200).send("THG Telegram Bot is running.");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed.");
    }

    // Verify Telegram webhook
    if (
      req.headers["x-telegram-bot-api-secret-token"] !==
      WEBHOOK_SECRET
    ) {
      return res.status(403).send("Unauthorized.");
    }

    const update = req.body || {};

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return res.status(200).send("OK");
    }

    const msg = update.message;

    if (!msg || !msg.from) {
      return res.status(200).send("OK");
    }

    const user = msg.from;
    const chatId = msg.chat.id;
    const text = msg.text || "";

    // Start command
    if (text.startsWith("/start")) {
      await sendWelcome(chatId, user);
      return res.status(200).send("OK");
    }

    // Admin commands
    if (isAdmin(user.id)) {
      if (text.startsWith("/panel")) {
        await showPanel(chatId);
        return res.status(200).send("OK");
      }

      if (text.startsWith("/myid")) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `Your Telegram ID: ${user.id}`
        });

        return res.status(200).send("OK");
      }

      // Admin replies to a user's copied submission.
      if (msg.reply_to_message) {
        await handleAdminReply(msg);
      }

      return res.status(200).send("OK");
    }

    // User media submission
    if (getMediaType(msg)) {
      await handleMedia(msg);
      return res.status(200).send("OK");
    }

    if (text) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          `📸 Please send a photo or video.\n\n` +
          `Caption mein apna User ID bhi likhna.`
      });
    }

    return res.status(200).send("OK");

  } catch (error) {
    console.error("THG BOT ERROR:", error);

    return res.status(200).send("OK");
  }
}
