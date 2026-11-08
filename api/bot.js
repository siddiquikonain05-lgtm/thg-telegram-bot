
import admin from "firebase-admin";

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SETUP_KEY = process.env.SETUP_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, "");

const API = `https://api.telegram.org/bot${TOKEN}`;

let db;

function initFirebase() {
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!privateKey) {
      throw new Error("FIREBASE_PRIVATE_KEY is missing");
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey.replace(/\\n/g, "\n")
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }

  db = admin.database();
}

async function tg(method, data = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || `Telegram ${method} failed`);
  }

  return result.result;
}

const isAdmin = id => ADMIN_IDS.includes(String(id));

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function userName(user) {
  return [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ") || "Unknown";
}

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "📩 Report" }],
      [
        { text: "➕ Another Request" },
        { text: "📋 My Requests" }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

async function send(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

async function updateUser(user) {
  const id = String(user.id);
  const ref = db.ref(`users/${id}`);

  await ref.transaction(current => {
    current = current || {
      telegramId: id,
      totalRequests: 0,
      firstSeen: Date.now()
    };

    current.name = userName(user);
    current.username = user.username || "";
    current.lastSeen = Date.now();

    return current;
  });
}

async function startReport(chatId) {
  await db.ref(`sessions/${chatId}`).set({
    mode: "awaiting_media",
    updatedAt: Date.now()
  });

  await send(
    chatId,
    "📩 <b>Submit Your Report</b>\n\nPlease send your report as a <b>photo or video</b>.\n\nAfter that, I will ask for your User ID.",
    { reply_markup: mainKeyboard() }
  );
}

function extractUserId(caption = "") {
  const match = caption.match(/(?:user\s*id|uid)\s*[:：-]\s*([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

async function submitReport(chatId, user, session, userId) {
  const requestId = `RZ-${Date.now()}-${user.id}`;
  const createdAt = Date.now();

  const request = {
    requestId,
    userTelegramId: String(user.id),
    chatId: String(chatId),
    name: userName(user),
    username: user.username || "",
    userId,
    mediaType: session.mediaType,
    originalMessageId: session.messageId,
    originalCaption: session.originalCaption || "",
    createdAt,
    status: "PENDING",
    adminMessageIds: {}
  };

  await db.ref(`requests/${requestId}`).set(request);

  await db.ref(`users/${user.id}/totalRequests`).transaction(
    value => (value || 0) + 1
  );

  await db.ref("stats/totalReports").transaction(
    value => (value || 0) + 1
  );

  await db.ref("stats/pending").transaction(
    value => (value || 0) + 1
  );

  const date = new Date(createdAt).toLocaleString("en-PK", {
    timeZone: "Asia/Karachi",
    dateStyle: "medium",
    timeStyle: "short"
  });

  const caption =
    `⚠️ <b>NEW REPORT</b>\n\n` +
    `🆔 Request: <code>${escapeHTML(requestId)}</code>\n` +
    `👤 Name: ${escapeHTML(request.name)}\n` +
    `🔗 Username: ${request.username ? "@" + escapeHTML(request.username) : "Not set"}\n` +
    `🆔 Telegram ID: <code>${user.id}</code>\n` +
    `🎮 User ID: <code>${escapeHTML(userId)}</code>\n` +
    `📁 Type: ${escapeHTML(session.mediaType)}\n` +
    `🕒 Time: ${escapeHTML(date)}\n` +
    `📌 Status: <b>PENDING</b>`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Mark Reviewed", callback_data: `rv|${requestId}` }
      ],
      [
        { text: "👤 User History", callback_data: `uh|${user.id}` }
      ]
    ]
  };

  const adminMessageIds = {};

  for (const adminId of ADMIN_IDS) {
    try {
      const copied = await tg("copyMessage", {
        chat_id: adminId,
        from_chat_id: chatId,
        message_id: session.messageId,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      });

      adminMessageIds[adminId] = copied.message_id;

      await db.ref(
        `adminMessageMap/${adminId}/${copied.message_id}`
      ).set({
        userChatId: String(chatId),
        requestId
      });

    } catch (error) {
      console.error("Admin delivery failed:", adminId, error.message);
    }
  }

  await db.ref(`requests/${requestId}/adminMessageIds`)
    .set(adminMessageIds);

  await db.ref(`sessions/${chatId}`).remove();

  await send(
    chatId,
    "✅ <b>Your report has been submitted!</b>\n\n" +
    `🆔 Request ID: <code>${escapeHTML(requestId)}</code>\n` +
    "📌 Status: <b>UNDER REVIEW</b>\n\n" +
    "You can check your report history using My Requests.",
    { reply_markup: mainKeyboard() }
  );
}

async function showMyRequests(chatId, userId) {
  const snapshot = await db.ref("requests")
    .orderByChild("userTelegramId")
    .equalTo(String(userId))
    .limitToLast(10)
    .once("value");

  if (!snapshot.exists()) {
    return send(chatId, "📋 You have not submitted any reports yet.", {
      reply_markup: mainKeyboard()
    });
  }

  const reports = Object.values(snapshot.val())
    .sort((a, b) => b.createdAt - a.createdAt);

  let message = "📋 <b>YOUR RECENT REQUESTS</b>\n\n";

  for (const report of reports) {
    const date = new Date(report.createdAt).toLocaleString("en-PK", {
      timeZone: "Asia/Karachi",
      dateStyle: "medium",
      timeStyle: "short"
    });

    message +=
      `🆔 <code>${escapeHTML(report.requestId)}</code>\n` +
      `🎮 User ID: <code>${escapeHTML(report.userId)}</code>\n` +
      `📌 Status: <b>${escapeHTML(report.status)}</b>\n` +
      `🕒 ${escapeHTML(date)}\n\n`;
  }

  await send(chatId, message, {
    reply_markup: mainKeyboard()
  });
}

async function showAdminPanel(chatId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "📊 Statistics", callback_data: "panel|stats" }
      ],
      [
        { text: "📋 All Reports", callback_data: "panel|all" },
        { text: "⏳ Pending", callback_data: "panel|pending" }
      ],
      [
        { text: "👥 All Users", callback_data: "panel|users" }
      ]
    ]
  };

  await send(chatId, "⚙️ <b>REPORT ZONE ADMIN PANEL</b>\n\nSelect an option:", {
    reply_markup: keyboard
  });
}

async function showStats(chatId) {
  const [users, reports, pending, reviewed] = await Promise.all([
    db.ref("users").once("value"),
    db.ref("stats/totalReports").once("value"),
    db.ref("stats/pending").once("value"),
    db.ref("stats/reviewed").once("value")
  ]);

  await send(
    chatId,
    "📊 <b>BOT STATISTICS</b>\n\n" +
    `👥 Total Users: <b>${users.numChildren()}</b>\n` +
    `📋 Total Reports: <b>${reports.val() || 0}</b>\n` +
    `⏳ Pending: <b>${pending.val() || 0}</b>\n` +
    `✅ Reviewed: <b>${reviewed.val() || 0}</b>`
  );
}

async function showReportList(chatId, pendingOnly = false) {
  let query = db.ref("requests")
    .orderByChild("createdAt")
    .limitToLast(15);

  const snapshot = await query.once("value");

  if (!snapshot.exists()) {
    return send(chatId, "No reports found.");
  }

  const reports = Object.values(snapshot.val())
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter(r => !pendingOnly || r.status === "PENDING");

  if (!reports.length) {
    return send(chatId, "No pending reports found.");
  }

  for (const r of reports.slice(0, 10)) {
    await send(
      chatId,
      `📋 <b>REPORT DETAILS</b>\n\n` +
      `🆔 Request: <code>${escapeHTML(r.requestId)}</code>\n` +
      `👤 ${escapeHTML(r.name)}\n` +
      `🎮 User ID: <code>${escapeHTML(r.userId)}</code>\n` +
      `🆔 Telegram ID: <code>${escapeHTML(r.userTelegramId)}</code>\n` +
      `📌 Status: <b>${escapeHTML(r.status)}</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "👤 User History",
                callback_data: `uh|${r.userTelegramId}`
              },
              {
                text: "✅ Review",
                callback_data: `rv|${r.requestId}`
              }
            ]
          ]
        }
      }
    );
  }
}

async function showUsers(chatId) {
  const snapshot = await db.ref("users")
    .orderByChild("lastSeen")
    .limitToLast(15)
    .once("value");

  if (!snapshot.exists()) {
    return send(chatId, "No users found.");
  }

  const users = Object.values(snapshot.val())
    .sort((a, b) => b.lastSeen - a.lastSeen);

  for (const user of users.slice(0, 10)) {
    await send(
      chatId,
      `👤 <b>${escapeHTML(user.name)}</b>\n` +
      `🆔 Telegram ID: <code>${escapeHTML(user.telegramId)}</code>\n` +
      `🔗 Username: ${user.username ? "@" + escapeHTML(user.username) : "Not set"}\n` +
      `📋 Total Requests: <b>${user.totalRequests || 0}</b>`,
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: "📋 Request History",
              callback_data: `uh|${user.telegramId}`
            }
          ]]
        }
      }
    );
  }
}

async function showUserHistory(chatId, userId) {
  const snapshot = await db.ref("requests")
    .orderByChild("userTelegramId")
    .equalTo(String(userId))
    .limitToLast(10)
    .once("value");

  const user = await db.ref(`users/${userId}`).once("value");

  let message = "👤 <b>USER HISTORY</b>\n\n";

  if (user.exists()) {
    const u = user.val();

    message +=
      `Name: ${escapeHTML(u.name)}\n` +
      `Username: ${u.username ? "@" + escapeHTML(u.username) : "Not set"}\n` +
      `Telegram ID: <code>${escapeHTML(userId)}</code>\n` +
      `Total Requests: <b>${u.totalRequests || 0}</b>\n\n`;
  }

  if (snapshot.exists()) {
    const reports = Object.values(snapshot.val())
      .sort((a, b) => b.createdAt - a.createdAt);

    for (const r of reports) {
      message +=
        `🆔 <code>${escapeHTML(r.requestId)}</code>\n` +
        `🎮 User ID: <code>${escapeHTML(r.userId)}</code>\n` +
        `📌 ${escapeHTML(r.status)}\n\n`;
    }
  } else {
    message += "No requests found.";
  }

  await send(chatId, message);
}

async function markReviewed(chatId, requestId) {
  const ref = db.ref(`requests/${requestId}`);
  const snapshot = await ref.once("value");

  if (!snapshot.exists()) {
    return send(chatId, "Request not found.");
  }

  const report = snapshot.val();

  if (report.status !== "REVIEWED") {
    await ref.update({
      status: "REVIEWED",
      reviewedAt: Date.now(),
      reviewedBy: String(chatId)
    });

    await db.ref("stats/pending").transaction(
      value => Math.max(0, (value || 0) - 1)
    );

    await db.ref("stats/reviewed").transaction(
      value => (value || 0) + 1
    );

    await send(
      report.chatId,
      `✅ Your report <code>${escapeHTML(requestId)}</code> has been marked as <b>REVIEWED</b>.`,
      { reply_markup: mainKeyboard() }
    );
  }

  await send(chatId, `✅ Request ${escapeHTML(requestId)} is now REVIEWED.`);
}

async function handleAdminReply(message) {
  const adminId = String(message.from.id);
  const repliedId = message.reply_to_message?.message_id;

  if (!repliedId) return false;

  const mapping = await db.ref(
    `adminMessageMap/${adminId}/${repliedId}`
  ).once("value");

  if (!mapping.exists()) return false;

  const data = mapping.val();

  try {
    await tg("copyMessage", {
      chat_id: data.userChatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    });

    await send(
      message.chat.id,
      `✅ Your reply was sent to the user.\nRequest: <code>${escapeHTML(data.requestId)}</code>`
    );

    await db.ref(`requests/${data.requestId}/lastAdminReplyAt`)
      .set(Date.now());

  } catch (error) {
    await send(message.chat.id, `❌ Could not send reply: ${escapeHTML(error.message)}`);
  }

  return true;
}

async function handleCallback(callback) {
  const adminId = callback.from.id;
  const chatId = callback.message.chat.id;
  const data = callback.data || "";

  await tg("answerCallbackQuery", {
    callback_query_id: callback.id
  });

  if (!isAdmin(adminId)) return;

  const [action, value] = data.split("|");

  if (action === "panel") {
    if (value === "stats") return showStats(chatId);
    if (value === "all") return showReportList(chatId, false);
    if (value === "pending") return showReportList(chatId, true);
    if (value === "users") return showUsers(chatId);
  }

  if (action === "rv") {
    return markReviewed(chatId, value);
  }

  if (action === "uh") {
    return showUserHistory(chatId, value);
  }
}

async function handleMessage(message) {
  if (!message?.from || message.from.is_bot) return;

  const chatId = message.chat.id;
  const user = message.from;
  const userId = String(user.id);
  const text = (message.text || "").trim();

  await updateUser(user);

  if (isAdmin(userId)) {
    if (text === "/panel") {
      return showAdminPanel(chatId);
    }

    if (text === "/start") {
      return send(chatId, "⚙️ Admin access enabled.\nUse /panel to open the admin panel.");
    }

    if (await handleAdminReply(message)) {
      return;
    }
  }

  if (text === "/start") {
    return send(
      chatId,
      "👋 Welcome to <b>Report Zone ⚠️</b>\n\n" +
      "Use the 📩 Report button to submit a photo or video report.\n\n" +
      "You can also check your previous reports.",
      { reply_markup: mainKeyboard() }
    );
  }

  if (text === "/panel") {
    return send(chatId, "⛔ Admin access only.");
  }

  if (text === "📩 Report" || text === "➕ Another Request") {
    return startReport(chatId);
  }

  if (text === "📋 My Requests") {
    return showMyRequests(chatId, userId);
  }

  const sessionRef = db.ref(`sessions/${chatId}`);
  const sessionSnapshot = await sessionRef.once("value");
  const session = sessionSnapshot.val();

  const photo = message.photo?.length
    ? message.photo[message.photo.length - 1]
    : null;

  const video = message.video || null;

  if (session?.mode === "awaiting_media") {
    if (!photo && !video) {
      return send(chatId, "⚠️ Please send a photo or video to continue.");
    }

    const mediaType = photo ? "PHOTO" : "VIDEO";

    const pending = {
      mode: "awaiting_user_id",
      mediaType,
      messageId: message.message_id,
      originalCaption: message.caption || "",
      updatedAt: Date.now()
    };

    await sessionRef.set(pending);

    const captionUserId = extractUserId(message.caption || "");

    if (captionUserId) {
      return submitReport(chatId, user, pending, captionUserId);
    }

    return send(
      chatId,
      "🆔 <b>Please send your User ID too.</b>\n\nSend your game User ID as a text message.",
      { reply_markup: mainKeyboard() }
    );
  }

  if (session?.mode === "awaiting_user_id") {
    if (!text || text.length < 2 || text.length > 64 ||
        !/^[a-zA-Z0-9_-]+$/.test(text)) {
      return send(
        chatId,
        "⚠️ Invalid User ID.\nPlease send a valid ID using letters or numbers only."
      );
    }

    return submitReport(chatId, user, session, text);
  }

  return send(
    chatId,
    "Please use the buttons below to continue.\n\nTap 📩 Report to submit a new report.",
    { reply_markup: mainKeyboard() }
  );
}

export default async function handler(req, res) {
  try {
    if (!TOKEN) {
      return res.status(500).send("BOT_TOKEN is missing.");
    }

    initFirebase();

    if (req.method === "GET") {
      if (req.query?.setup === SETUP_KEY && SETUP_KEY && PUBLIC_URL && WEBHOOK_SECRET) {
        const result = await tg("setWebhook", {
          url: `${PUBLIC_URL}/api/bot`,
          secret_token: WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"]
        });

        return res.status(200).send(
          result ? "Webhook setup: SUCCESS" : "Webhook setup failed"
        );
      }

      return res.status(200).send("Report Zone Telegram Bot is running.");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed.");
    }

    if (
      WEBHOOK_SECRET &&
      req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET
    ) {
      return res.status(401).send("Unauthorized");
    }

    const update = req.body;

    if (update?.message) {
      await handleMessage(update.message);
    } else if (update?.callback_query) {
      await handleCallback(update.callback_query);
    }

    return res.status(200).send("OK");

  } catch (error) {
    console.error("Bot error:", error);
    return res.status(200).send("Handled");
  }
}
