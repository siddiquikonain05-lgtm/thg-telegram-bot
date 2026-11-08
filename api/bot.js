
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SETUP_KEY = process.env.SETUP_KEY;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

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

async function sendText(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

function getChatIdFromCaption(caption) {
  const match = String(caption || "").match(/Chat ID:\s*(-?\d+)/i);
  return match ? match[1] : null;
}

module.exports = async (req, res) => {
  try {
    // Basic configuration check
    if (!BOT_TOKEN || !ADMIN_IDS.length) {
      return res.status(500).send("Missing BOT_TOKEN or ADMIN_IDS");
    }

    // One-time webhook setup
    if (req.method === "GET" && req.query.setup) {
      if (!SETUP_KEY || req.query.setup !== SETUP_KEY) {
        return res.status(403).send("Invalid setup key");
      }

      if (!PUBLIC_URL || !WEBHOOK_SECRET) {
        return res.status(500).send("Missing PUBLIC_URL or WEBHOOK_SECRET");
      }

      const webhookUrl = `${PUBLIC_URL}/api/bot`;

      const result = await telegram("setWebhook", {
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ["message"]
      });

      return res.status(200).send(
        `Webhook setup: ${result ? "SUCCESS" : "FAILED"}\n${webhookUrl}`
      );
    }

    // Health check
    if (req.method === "GET") {
      return res.status(200).send("THG Telegram Bot is running.");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    // Verify Telegram webhook secret
    const receivedSecret =
      req.headers["x-telegram-bot-api-secret-token"];

    if (!WEBHOOK_SECRET || receivedSecret !== WEBHOOK_SECRET) {
      return res.status(403).send("Forbidden");
    }

    const update =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const msg = update && update.message;
    if (!msg) return res.status(200).send("OK");

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || "").trim();
    const admin = isAdmin(userId);

    // Admin commands
    if (admin && text === "/start") {
      await sendText(
        chatId,
        "THG Admin Panel\n\n" +
        "Send a reply to any submitted video to respond to that user.\n" +
        "Use /myid to see your Telegram ID."
      );
      return res.status(200).send("OK");
    }

    if (text === "/myid") {
      await sendText(
        chatId,
        `Your Telegram ID: ${userId}\nChat ID: ${chatId}`
      );
      return res.status(200).send("OK");
    }

    // Admin replies to a submitted video
    if (admin && msg.reply_to_message) {
      const originalCaption = msg.reply_to_message.caption || "";
      const targetChatId = getChatIdFromCaption(originalCaption);

      if (!targetChatId) {
        await sendText(
          chatId,
          "I could not find the user's Chat ID. Reply directly to the original submitted video."
        );
        return res.status(200).send("OK");
      }

      if (!text) {
        await sendText(
          chatId,
          "Please send a text reply to the submitted video."
        );
        return res.status(200).send("OK");
      }

      await sendText(
        targetChatId,
        `📩 Admin Response:\n\n${text}`
      );

      await sendText(chatId, "✅ Your reply was sent to the user.");
      return res.status(200).send("OK");
    }

    // Ignore other admin messages
    if (admin) {
      await sendText(
        chatId,
        "Reply directly to a submitted video to message its user.\nUse /myid for your ID."
      );
      return res.status(200).send("OK");
    }

    // User commands
    if (text === "/start") {
      await sendText(
        chatId,
        "Assalamualaikum!\n\nWelcome to THG Video Submission Bot.\n\nPress the button below to submit your video.",
        {
          reply_markup: {
            keyboard: [
              [{ text: "🎬 Send Your ID and Video" }]
            ],
            resize_keyboard: true
          }
        }
      );
      return res.status(200).send("OK");
    }

    if (text === "/cancel") {
      await sendText(chatId, "Submission cancelled.");
      return res.status(200).send("OK");
    }

    if (text === "🎬 Send Your ID and Video") {
      await sendText(
        chatId,
        "Please send your video with your Game ID written in the video caption.\n\nExample:\nGame ID: 123456789\n\nSend both together in one message."
      );
      return res.status(200).send("OK");
    }

    // Receive user video
    if (msg.video) {
      const userCaption = (msg.caption || "").trim();

      if (!userCaption) {
        await sendText(
          chatId,
          "❌ Your video has no caption.\nPlease resend the video with your Game ID in its caption."
        );
        return res.status(200).send("OK");
      }

      const name = [
        msg.from.first_name || "",
        msg.from.last_name || ""
      ].join(" ").trim() || "Unknown";

      const username = msg.from.username
        ? `@${msg.from.username}`
        : "Not available";

      const adminCaption =
        `🎬 NEW VIDEO SUBMISSION\n\n` +
        `👤 User: ${name}\n` +
        `🔗 Username: ${username}\n` +
        `🆔 Telegram ID: ${userId}\n` +
        `💬 Chat ID: ${chatId}\n\n` +
        `🎮 User's ID / Caption:\n${userCaption.slice(0, 450)}`;

      let delivered = 0;

      for (const adminId of ADMIN_IDS) {
        try {
          await telegram("sendVideo", {
            chat_id: adminId,
            video: msg.video.file_id,
            caption: adminCaption
          });
          delivered++;
        } catch (error) {
          console.error("Admin delivery failed:", adminId, error.message);
        }
      }

      if (delivered > 0) {
        await sendText(
          chatId,
          "✅ Your video has been received successfully.\n\n⏳ Status: Pending review."
        );
      } else {
        await sendText(
          chatId,
          "⚠️ Your video could not be delivered to the admins. Please try again later."
        );
      }

      return res.status(200).send("OK");
    }

    // Other user messages
    await sendText(
      chatId,
      "Please press 🎬 Send Your ID and Video, then send your video with your Game ID in its caption."
    );

    return res.status(200).send("OK");

  } catch (error) {
    console.error("THG bot error:", error);
    return res.status(200).send("Bot received the update.");
  }
};
