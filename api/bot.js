
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(id => id.trim())
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

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

function getTargetChatId(caption) {
  const match = String(caption || "").match(
    /THG_CHAT_ID:\s*(-?\d+)/i
  );
  return match ? match[1] : null;
}

function getUserName(from) {
  return [
    from.first_name || "",
    from.last_name || ""
  ].join(" ").trim() || "Unknown";
}

async function handleMessage(msg) {
  if (!msg || !msg.chat || !msg.from) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();
  const admin = isAdmin(userId);

  // ADMIN COMMANDS
  if (admin && text === "/start") {
    await sendMessage(
      chatId,
      "🛡️ THG ADMIN PANEL\n\n" +
      "You are an authorized administrator.\n\n" +
      "📩 New user submissions will arrive here.\n" +
      "↩️ Reply directly to a submitted video to send a message to its user.\n\n" +
      "Use /myid to check your own admin ID."
    );
    return;
  }

  // Only admins can use /myid
  if (text === "/myid") {
    if (admin) {
      await sendMessage(
        chatId,
        `🛡️ Admin ID: ${userId}`
      );
    } else {
      await sendMessage(
        chatId,
        "This command is available to administrators only."
      );
    }
    return;
  }

  // ADMIN REPLY TO USER SUBMISSION
  if (admin && msg.reply_to_message) {
    const originalCaption = msg.reply_to_message.caption || "";
    const targetChatId = getTargetChatId(originalCaption);

    if (!targetChatId) {
      await sendMessage(
        chatId,
        "⚠️ User information not found.\nPlease reply directly to the original submitted video."
      );
      return;
    }

    if (!text || text.startsWith("/")) {
      await sendMessage(
        chatId,
        "Please reply with a normal text message."
      );
      return;
    }

    await sendMessage(
      targetChatId,
      "📩 RESPONSE FROM THG ADMIN\n\n" + text
    );

    await sendMessage(
      chatId,
      "✅ Your response has been delivered to the user."
    );
    return;
  }

  // Do not expose admin information to users
  if (admin) {
    if (text === "/cancel") {
      await sendMessage(chatId, "Action cancelled.");
    } else {
      await sendMessage(
        chatId,
        "📩 To respond to a user, reply directly to their submitted video."
      );
    }
    return;
  }

  // USER START
  if (text === "/start") {
    await sendMessage(
      chatId,
      "Assalamualaikum! 👋\n\n" +
      "Welcome to THG Submission Bot! 🎬\n\n" +
      "You can submit your video for review.\n\n" +
      "📌 Please include your Game ID in the video caption.\n\n" +
      "Press the button below to submit your request, or send your video with its Game ID directly.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎬 Submit Your Request",
                callback_data: "submit_request"
              }
            ]
          ]
        }
      }
    );
    return;
  }

  if (text === "/cancel") {
    await sendMessage(chatId, "Your current action has been cancelled.");
    return;
  }

  // USER VIDEO SUBMISSION
  if (msg.video) {
    const userCaption = (msg.caption || "").trim();

    if (!userCaption) {
      await sendMessage(
        chatId,
        "❌ Your video does not have a caption.\n\n" +
        "Please send the video again and write your Game ID in its caption.\n\n" +
        "Example:\nGame ID: 123456789"
      );
      return;
    }

    const name = getUserName(msg.from);
    const username = msg.from.username
      ? "@" + msg.from.username
      : "Not available";

    // Keep the routing ID at the beginning of the admin caption
    const adminCaption =
      `THG_CHAT_ID: ${chatId}\n\n` +
      `🎬 NEW VIDEO SUBMISSION\n\n` +
      `👤 Name: ${name}\n` +
      `🔗 Username: ${username}\n` +
      `🆔 Telegram User ID: ${userId}\n` +
      `💬 Chat ID: ${chatId}\n\n` +
      `🎮 GAME ID / USER CAPTION:\n` +
      userCaption;

    let delivered = 0;

    for (const adminId of ADMIN_IDS) {
      try {
        await telegram("sendVideo", {
          chat_id: adminId,
          video: msg.video.file_id,
          caption: adminCaption.slice(0, 1024)
        });

        delivered++;
      } catch (error) {
        console.error(
          "Admin delivery failed:",
          adminId,
          error.message
        );
      }
    }

    if (delivered > 0) {
      await sendMessage(
        chatId,
        "✅ Your request has been submitted successfully!\n\n" +
        "⏳ Status: UNDER REVIEW\n\n" +
        "Our admin team is checking your video. Please wait for a response."
      );
    } else {
      await sendMessage(
        chatId,
        "⚠️ Your video could not be submitted right now.\nPlease try again later."
      );
    }

    return;
  }

  // USER BUTTON / PROMPT
  if (text === "/submit" || text === "🎬 Submit Your Request") {
    await sendMessage(
      chatId,
      "🎬 SEND YOUR VIDEO NOW\n\n" +
      "Please attach your video and write your Game ID in the caption.\n\n" +
      "Example:\nGame ID: 123456789\n\n" +
      "Send both together in one message."
    );
    return;
  }

  // OTHER USER MESSAGES
  await sendMessage(
    chatId,
    "Welcome to THG Submission Bot! 🎬\n\n" +
    "Please send your video with your Game ID written in its caption."
  );
}

module.exports = async (req, res) => {
  try {
    if (!BOT_TOKEN || !ADMIN_IDS.length) {
      return res.status(500).send("Missing BOT_TOKEN or ADMIN_IDS");
    }

    // WEBHOOK SETUP
    if (req.method === "GET" && req.query.setup) {
      if (!SETUP_KEY || req.query.setup !== SETUP_KEY) {
        return res.status(403).send("Invalid setup key");
      }

      if (!PUBLIC_URL || !WEBHOOK_SECRET) {
        return res.status(500).send("Missing PUBLIC_URL or WEBHOOK_SECRET");
      }

      const webhookUrl = `${PUBLIC_URL}/api/bot`;

      await telegram("setWebhook", {
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"]
      });

      return res.status(200).send(
        `Webhook setup: SUCCESS\n${webhookUrl}`
      );
    }

    // HEALTH CHECK
    if (req.method === "GET") {
      return res.status(200).send("THG Telegram Bot is running.");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    // VERIFY TELEGRAM SECRET
    const receivedSecret =
      req.headers["x-telegram-bot-api-secret-token"];

    if (!WEBHOOK_SECRET || receivedSecret !== WEBHOOK_SECRET) {
      return res.status(403).send("Forbidden");
    }

    const update =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    // INLINE BUTTON CLICK
    if (update && update.callback_query) {
      const callback = update.callback_query;

      if (callback.data === "submit_request") {
        await telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "Ready! Send your video with your Game ID."
        });

        await sendMessage(
          callback.message.chat.id,
          "🎬 SEND YOUR VIDEO NOW\n\n" +
          "Attach your video and write your Game ID in the caption.\n\n" +
          "Example:\nGame ID: 123456789"
        );
      }

      return res.status(200).send("OK");
    }

    // NORMAL MESSAGE
    if (update && update.message) {
      await handleMessage(update.message);
    }

    return res.status(200).send("OK");

  } catch (error) {
    console.error("THG bot error:", error);

    if (req.method === "GET") {
      return res.status(500).send(
        "Error: " + error.message
      );
    }

    return res.status(200).send("OK");
  }
};
