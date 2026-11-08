
import admin from "firebase-admin";

const TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SETUP_KEY = process.env.SETUP_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, "");

let db;

function initFirebase() {
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!privateKey) throw new Error("Firebase private key missing");

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

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function displayName(user) {
  return [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ") || "Unknown";
}

function keyboard() {
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

async function saveUser(user) {
  const ref = db.ref(`users/${user.id}`);

  await ref.transaction(current => {
    current = current || {
      telegramId: String(user.id),
      totalRequests: 0,
      firstSeen: Date.now()
    };

    current.name = displayName(user);
    current.username = user.username || "";
    current.lastSeen = Date.now();

    return current;
  });
}

async function welcome(chatId) {
  const message =
    "🚨 <b>WELCOME TO REPORT ZONE ⚠️</b>\n\n" +
    "👋 Hello! Welcome to <b>Report Zone</b>.\n\n" +
    "🎬 Please send a short video (15–20 seconds) along with your ID number.\n\n" +
    "🆔 <b>Your ID:</b> <i>Send your ID after the video.</i>\n\n" +
    "📩 Make sure to include your ID with the video.";

  await send(chatId, message, {
    reply_markup: keyboard()
  });
}

async function startReport(chatId) {
  await db.ref(`sessions/${chatId}`).set({
    mode: "awaiting_video",
    updatedAt: Date.now()
  });

  await send(
    chatId,
    "🎬 <b>Send Your Video</b>\n\n" +
    "Please send a short video of 15–20 seconds.\n" +
    "After receiving your video, I will ask for your ID number.",
    { reply_markup: keyboard() }
  );
}

async function submitReport(chatId, user, session, gameUserId) {
  const requestId = `RZ-${Date.now()}-${user.id}`;
  const createdAt = Date.now();

  const request = {
    requestId,
    userTelegramId: String(user.id),
    chatId: String(chatId),
    name: displayName(user),
    username: user.username || "",
    userId: gameUserId,
    mediaType: "VIDEO",
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

  const adminCaption =
    "🚨 <b>NEW REPORT — REPORT ZONE</b>\n\n" +
    `🆔 Request ID: <code>${esc(requestId)}</code>\n` +
    `👤 Name: ${esc(request.name)}\n` +
    `🔗 Username: ${request.username ? "@" + esc(request.username) : "Not set"}\n` +
    `🆔 Telegram ID: <code>${user.id}</code>\n` +
    `🎮 User ID: <code>${esc(gameUserId)}</code>\n` +
    `🎬 Media: VIDEO\n` +
    `🕒 Date: ${esc(date)}\n` +
    "📌 Status: <b>PENDING</b>";

  const adminKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ APPROVE", callback_data: `status|APPROVED|${requestId}` },
        { text: "❌ REJECT", callback_data: `status|REJECTED|${requestId}` }
      ],
      [
        { text: "💬 Message User", callback_data: `message|${user.id}` },
        { text: "👤 User History", callback_data: `history|${user.id}` }
      ]
    ]
  };

  const messageMap = {};

  for (const adminId of ADMIN_IDS) {
    try {
      const copied = await tg("copyMessage", {
        chat_id: adminId,
        from_chat_id: chatId,
        message_id: session.messageId,
        caption: adminCaption,
        parse_mode: "HTML",
        reply_markup: adminKeyboard
      });

      messageMap[adminId] = copied.message_id;

      await db.ref(
        `adminMessageMap/${adminId}/${copied.message_id}`
      ).set({
        userChatId: String(chatId),
        requestId
      });

    } catch (error) {
      console.error("Admin delivery error:", adminId, error.message);
    }
  }

  await db.ref(`requests/${requestId}/adminMessageIds`).set(messageMap);
  await db.ref(`sessions/${chatId}`).remove();

  await send(
    chatId,
    "✅ <b>Your report has been submitted successfully!</b>\n\n" +
    `🆔 Request ID: <code>${esc(requestId)}</code>\n` +
    "📌 Status: <b>PENDING — UNDER REVIEW</b>\n\n" +
    "You will receive a message when your report is approved or rejected.",
    { reply_markup: keyboard() }
  );
}

async function myRequests(chatId, userId) {
  const snapshot = await db.ref("requests")
    .orderByChild("userTelegramId")
    .equalTo(String(userId))
    .limitToLast(10)
    .once("value");

  if (!snapshot.exists()) {
    return send(chatId, "📋 You have not submitted any reports yet.", {
      reply_markup: keyboard()
    });
  }

  const reports = Object.values(snapshot.val())
    .sort((a, b) => b.createdAt - a.createdAt);

  let text = "📋 <b>YOUR RECENT REQUESTS</b>\n\n";

  for (const r of reports) {
    text +=
      `🆔 <code>${esc(r.requestId)}</code>\n` +
      `🎮 User ID: <code>${esc(r.userId)}</code>\n` +
      `📌 Status: <b>${esc(r.status)}</b>\n\n`;
  }

  return send(chatId, text, { reply_markup: keyboard() });
}

async function adminPanel(chatId) {
  return send(chatId, "⚙️ <b>REPORT ZONE — ADMIN PANEL</b>\n\nSelect an option:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Statistics", callback_data: "panel|stats" }],
        [
          { text: "📋 All Reports", callback_data: "panel|all" },
          { text: "⏳ Pending", callback_data: "panel|pending" }
        ],
        [{ text: "👥 All Users", callback_data: "panel|users" }],
        [{ text: "💬 Send Custom Message", callback_data: "panel|custom" }]
      ]
    }
  });
}

async function statistics(chatId) {
  const [users, total, pending, approved, rejected] = await Promise.all([
    db.ref("users").once("value"),
    db.ref("stats/totalReports").once("value"),
    db.ref("stats/pending").once("value"),
    db.ref("stats/approved").once("value"),
    db.ref("stats/rejected").once("value")
  ]);

  return send(
    chatId,
    "📊 <b>REPORT ZONE STATISTICS</b>\n\n" +
    `👥 Total Users: <b>${users.numChildren()}</b>\n` +
    `📋 Total Reports: <b>${total.val() || 0}</b>\n` +
    `⏳ Pending: <b>${pending.val() || 0}</b>\n` +
    `✅ Approved: <b>${approved.val() || 0}</b>\n` +
    `❌ Rejected: <b>${rejected.val() || 0}</b>`
  );
}

async function reportList(chatId, pendingOnly = false) {
  const snapshot = await db.ref("requests")
    .orderByChild("createdAt")
    .limitToLast(30)
    .once("value");

  if (!snapshot.exists()) return send(chatId, "No reports found.");

  const reports = Object.values(snapshot.val())
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter(r => !pendingOnly || r.status === "PENDING");

  if (!reports.length) return send(chatId, "No pending reports found.");

  for (const r of reports.slice(0, 15)) {
    await send(
      chatId,
      "📋 <b>REPORT DETAILS</b>\n\n" +
      `🆔 Request: <code>${esc(r.requestId)}</code>\n` +
      `👤 ${esc(r.name)}\n` +
      `🎮 User ID: <code>${esc(r.userId)}</code>\n` +
      `🆔 Telegram ID: <code>${esc(r.userTelegramId)}</code>\n` +
      `📌 Status: <b>${esc(r.status)}</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `status|APPROVED|${r.requestId}` },
              { text: "❌ Reject", callback_data: `status|REJECTED|${r.requestId}` }
            ],
            [
              { text: "💬 Message User", callback_data: `message|${r.userTelegramId}` },
              { text: "👤 History", callback_data: `history|${r.userTelegramId}` }
            ]
          ]
        }
      }
    );
  }
}

async function userList(chatId) {
  const snapshot = await db.ref("users")
    .orderByChild("lastSeen")
    .limitToLast(20)
    .once("value");

  if (!snapshot.exists()) return send(chatId, "No users found.");

  const users = Object.values(snapshot.val())
    .sort((a, b) => b.lastSeen - a.lastSeen);

  for (const u of users.slice(0, 15)) {
    await send(
      chatId,
      `👤 <b>${esc(u.name)}</b>\n` +
      `🆔 Telegram ID: <code>${esc(u.telegramId)}</code>\n` +
      `🔗 Username: ${u.username ? "@" + esc(u.username) : "Not set"}\n` +
      `📋 Requests: <b>${u.totalRequests || 0}</b>`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "💬 Message User", callback_data: `message|${u.telegramId}` },
            { text: "📋 History", callback_data: `history|${u.telegramId}` }
          ]]
        }
      }
    );
  }
}

async function userHistory(chatId, userId) {
  const [userSnap, reportsSnap] = await Promise.all([
    db.ref(`users/${userId}`).once("value"),
    db.ref("requests")
      .orderByChild("userTelegramId")
      .equalTo(String(userId))
      .limitToLast(15)
      .once("value")
  ]);

  let text = "👤 <b>USER DETAILS & HISTORY</b>\n\n";

  if (userSnap.exists()) {
    const u = userSnap.val();

    text +=
      `Name: ${esc(u.name)}\n` +
      `Username: ${u.username ? "@" + esc(u.username) : "Not set"}\n` +
      `Telegram ID: <code>${esc(userId)}</code>\n` +
      `Total Requests: <b>${u.totalRequests || 0}</b>\n\n`;
  }

  if (reportsSnap.exists()) {
    const reports = Object.values(reportsSnap.val())
      .sort((a, b) => b.createdAt - a.createdAt);

    for (const r of reports) {
      text +=
        `🆔 <code>${esc(r.requestId)}</code>\n` +
        `🎮 User ID: <code>${esc(r.userId)}</code>\n` +
        `📌 ${esc(r.status)}\n\n`;
    }
  } else {
    text += "No reports found.";
  }

  await send(chatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "💬 Send Custom Message", callback_data: `message|${userId}` }
      ]]
    }
  });
}

async function changeStatus(adminChatId, status, requestId) {
  const ref = db.ref(`requests/${requestId}`);
  const snap = await ref.once("value");

  if (!snap.exists()) return send(adminChatId, "❌ Report not found.");

  const report = snap.val();

  if (!["APPROVED", "REJECTED"].includes(status)) {
    return send(adminChatId, "Invalid status.");
  }

  if (report.status === status) {
    return send(adminChatId, `This report is already ${status}.`);
  }

  const previousStatus = report.status;

  await ref.update({
    status,
    statusUpdatedAt: Date.now(),
    statusUpdatedBy: String(adminChatId)
  });

  if (previousStatus === "PENDING") {
    await db.ref("stats/pending").transaction(
      value => Math.max(0, (value || 0) - 1)
    );
  } else {
    await db.ref(`stats/${previousStatus.toLowerCase()}`).transaction(
      value => Math.max(0, (value || 0) - 1)
    );
  }

  await db.ref(`stats/${status.toLowerCase()}`).transaction(
    value => (value || 0) + 1
  );

  const notice = status === "APPROVED"
    ? "🎉 <b>Your report has been APPROVED!</b>\n\nThank you for submitting your report."
    : "❌ <b>Your report has been REJECTED.</b>\n\nPlease contact the administration if you need further information.";

  await send(report.chatId, notice + `\n\n🆔 Request: <code>${esc(requestId)}</code>`, {
    reply_markup: keyboard()
  });

  return send(
    adminChatId,
    `✅ Report <code>${esc(requestId)}</code> status changed to <b>${status}</b>.`
  );
}

async function askCustomMessage(adminChatId, targetUserId) {
  await db.ref(`adminSessions/${adminChatId}`).set({
    mode: "awaiting_custom_message",
    targetUserId: String(targetUserId)
  });

  return send(
    adminChatId,
    `💬 <b>Send Custom Message</b>\n\n` +
    `Target Telegram ID: <code>${esc(targetUserId)}</code>\n\n` +
    "Now send the message you want the user to receive.\n" +
    "Send /cancel to cancel."
  );
}

async function handleCustomMessage(message) {
  const adminId = String(message.from.id);
  const ref = db.ref(`adminSessions/${adminId}`);
  const snap = await ref.once("value");

  if (!snap.exists()) return false;

  const session = snap.val();

  if (session.mode !== "awaiting_custom_message") return false;

  if (message.text?.trim() === "/cancel") {
    await ref.remove();
    await send(message.chat.id, "❎ Custom message cancelled.");
    return true;
  }

  if (!message.text && !message.photo && !message.video && !message.document) {
    await send(message.chat.id, "Please send text, photo, video or document.");
    return true;
  }

  try {
    if (message.text) {
      await send(session.targetUserId, message.text);
    } else {
      await tg("copyMessage", {
        chat_id: session.targetUserId,
        from_chat_id: message.chat.id,
        message_id: message.message_id
      });
    }

    await ref.remove();

    await send(
      message.chat.id,
      `✅ Message sent successfully to <code>${esc(session.targetUserId)}</code>.`
    );
  } catch (error) {
    await send(
      message.chat.id,
      `❌ Message could not be sent: ${esc(error.message)}`
    );
  }

  return true;
}

async function handleAdminReply(message) {
  const adminId = String(message.from.id);
  const replyId = message.reply_to_message?.message_id;

  if (!replyId) return false;

  const snap = await db.ref(
    `adminMessageMap/${adminId}/${replyId}`
  ).once("value");

  if (!snap.exists()) return false;

  const mapping = snap.val();

  try {
    await tg("copyMessage", {
      chat_id: mapping.userChatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    });

    await send(message.chat.id, "✅ Reply sent to the user.");
  } catch (error) {
    await send(message.chat.id, `❌ Reply failed: ${esc(error.message)}`);
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

  const parts = data.split("|");
  const action = parts[0];

  if (action === "panel") {
    if (parts[1] === "stats") return statistics(chatId);
    if (parts[1] === "all") return reportList(chatId, false);
    if (parts[1] === "pending") return reportList(chatId, true);
    if (parts[1] === "users") return userList(chatId);

    if (parts[1] === "custom") {
      await db.ref(`adminSessions/${adminId}`).set({
        mode: "awaiting_target_id"
      });

      return send(
        chatId,
        "💬 <b>Custom Message</b>\n\nSend the user's numeric Telegram ID.\n\nSend /cancel to cancel."
      );
    }
  }

  if (action === "status") {
    return changeStatus(chatId, parts[1], parts.slice(2).join("|"));
  }

  if (action === "history") {
    return userHistory(chatId, parts[1]);
  }

  if (action === "message") {
    return askCustomMessage(chatId, parts[1]);
  }
}

async function handleAdminTarget(message) {
  const adminId = String(message.from.id);
  const ref = db.ref(`adminSessions/${adminId}`);
  const snap = await ref.once("value");

  if (!snap.exists()) return false;

  const session = snap.val();

  if (session.mode !== "awaiting_target_id") return false;

  if (message.text?.trim() === "/cancel") {
    await ref.remove();
    await send(message.chat.id, "❎ Cancelled.");
    return true;
  }

  const targetId = (message.text || "").trim();

  if (!/^\d+$/.test(targetId)) {
    await send(message.chat.id, "⚠️ Please send a valid numeric Telegram ID.");
    return true;
  }

  await ref.set({
    mode: "awaiting_custom_message",
    targetUserId: targetId
  });

  await send(
    message.chat.id,
    `Now send the custom message for Telegram ID <code>${esc(targetId)}</code>.\n\nSend /cancel to cancel.`
  );

  return true;
}

async function handleMessage(message) {
  if (!message?.from || message.from.is_bot) return;

  const chatId = message.chat.id;
  const user = message.from;
  const userId = String(user.id);
  const text = (message.text || "").trim();

  await saveUser(user);

  if (isAdmin(userId)) {
    if (text === "/panel") return adminPanel(chatId);

    if (text === "/start") {
      return send(chatId, "⚙️ Admin access enabled.\nUse /panel to open the admin panel.");
    }

    if (await handleAdminTarget(message)) return;
    if (await handleCustomMessage(message)) return;
    if (await handleAdminReply(message)) return;
  }

  if (text === "/start") return welcome(chatId);

  if (text === "/cancel") {
    await db.ref(`sessions/${chatId}`).remove();
    return send(chatId, "Your current report has been cancelled.", {
      reply_markup: keyboard()
    });
  }

  if (text === "📩 Report" || text === "➕ Another Request") {
    return startReport(chatId);
  }

  if (text === "📋 My Requests") {
    return myRequests(chatId, userId);
  }

  const sessionRef = db.ref(`sessions/${chatId}`);
  const snap = await sessionRef.once("value");
  const session = snap.val();

  if (session?.mode === "awaiting_video") {
    if (!message.video) {
      return send(
        chatId,
        "⚠️ Please send a video only. Photos and text are not accepted as reports."
      );
    }

    const pending = {
      mode: "awaiting_user_id",
      messageId: message.message_id,
      mediaType: "VIDEO",
      originalCaption: message.caption || "",
      updatedAt: Date.now()
    };

    await sessionRef.set(pending);

    return send(
      chatId,
      "🆔 <b>Please send your ID number now.</b>\n\n" +
      "Send your ID as a text message to complete your report."
    );
  }

  if (session?.mode === "awaiting_user_id") {
    if (!text || text.length < 2 || text.length > 64 ||
        !/^[a-zA-Z0-9_-]+$/.test(text)) {
      return send(
        chatId,
        "⚠️ Invalid ID. Please send a valid ID using letters or numbers only."
      );
    }

    return submitReport(chatId, user, session, text);
  }

  return send(
    chatId,
    "Please use the buttons below.\n\nTap 📩 Report to submit a new report.",
    { reply_markup: keyboard() }
  );
}

export default async function handler(req, res) {
  try {
    if (!TOKEN) {
      return res.status(500).send("BOT_TOKEN is missing.");
    }

    initFirebase();

    if (req.method === "GET") {
      if (
        req.query?.setup === SETUP_KEY &&
        SETUP_KEY &&
        PUBLIC_URL &&
        WEBHOOK_SECRET
      ) {
        await tg("setWebhook", {
          url: `${PUBLIC_URL}/api/bot`,
          secret_token: WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"]
        });

        return res.status(200).send("Webhook setup: SUCCESS");
      }

      return res.status(200).send("Report Zone Bot is running.");
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
    console.error("Report Zone error:", error);
    return res.status(200).send("Handled");
  }
}
