const express = require("express")
const { createClient } = require("@supabase/supabase-js")

const app = express()
app.use(express.json())

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://telehub.to")
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization")

  if (req.method === "OPTIONS") {
    return res.sendStatus(200)
  }

  next()
})


app.get("/", (req, res) => {
  res.status(200).send("Telegram sync backend running")
})

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`


const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean)

async function tg(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })

  const json = await res.json()
  if (!json.ok) throw new Error(json.description || "Telegram API error")
  return json.result
}

function cleanUsername(username) {
  if (!username) return null
  return username.startsWith("@") ? username : `@${username}`
}

function extractUsernameFromLink(link) {
  if (!link) return null
  const cleaned = link
    .replace("https://t.me/", "")
    .replace("http://t.me/", "")
    .replace("@", "")
    .split("?")[0]
    .split("/")[0]
    .trim()

  if (!cleaned || cleaned.startsWith("+")) return null
  return `@${cleaned}`
}

async function uploadTelegramPhoto(fileId, listingId) {
  const file = await tg("getFile", { file_id: fileId })

  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`
  const imageRes = await fetch(fileUrl)
  const arrayBuffer = await imageRes.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const ext = file.file_path.split(".").pop() || "jpg"
  const path = `telegram-icons/${listingId}-${Date.now()}.${ext}`

  const { error } = await supabaseAdmin.storage
    .from("listing-images")
    .upload(path, buffer, {
      contentType: imageRes.headers.get("content-type") || "image/jpeg",
      upsert: true,
    })

  if (error) throw error

  const { data } = supabaseAdmin.storage
    .from("listing-images")
    .getPublicUrl(path)

  return data.publicUrl
}

async function syncListingTelegramData(listing) {
  const chatTarget =
    listing.telegram_chat_id ||
    listing.telegram_username ||
    extractUsernameFromLink(listing.telegram_link)

  if (!chatTarget) throw new Error("No Telegram username or chat ID found")

  const chat = await tg("getChat", { chat_id: chatTarget })
  const memberCount = await tg("getChatMemberCount", { chat_id: chat.id })

  let iconUrl = listing.icon_url || null

  if (chat.photo?.big_file_id) {
    iconUrl = await uploadTelegramPhoto(chat.photo.big_file_id, listing.id)
  }

  const { error } = await supabaseAdmin
    .from("channel_listings")
    .update({
      telegram_chat_id: String(chat.id),
      telegram_username: cleanUsername(chat.username),
      telegram_title: chat.title || null,
      telegram_description: chat.description || chat.bio || null,
      member_count: memberCount,
      icon_url: iconUrl,
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", listing.id)

  if (error) throw error

  await supabaseAdmin.from("channel_member_snapshots").insert({
    listing_id: listing.id,
    member_count: memberCount,
  })

  return { chat, memberCount, iconUrl }
}

app.post("/api/auth/is-admin", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const token = authHeader.replace("Bearer ", "")

    if (!token) {
      return res.status(401).json({ isAdmin: false })
    }

    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ isAdmin: false })
    }

    const email = (user.email || "").toLowerCase()
    const isAdmin = ADMIN_EMAILS.includes(email)

    return res.json({ isAdmin })
  } catch (err) {
    console.error("Admin check error:", err)
    return res.status(500).json({ isAdmin: false })
  }
})

app.post("/api/discord/vote-feed", async (req, res) => {
  console.log("Discord vote feed route hit:", req.body)

  try {
    const webhookUrl = process.env.DISCORD_VOTE_WEBHOOK_URL

    if (!webhookUrl) {
      console.log("Missing DISCORD_VOTE_WEBHOOK_URL")
      return res.status(500).json({ error: "Missing Discord webhook URL" })
    }

    const {
      title,
      description,
      telegram_link,
      listing_url,
      icon_url,
      image_url,
      votes_count,
      member_count,
      categories,
    } = req.body

    const safeTelegramLink = telegram_link?.startsWith("http")
      ? telegram_link
      : `https://${telegram_link}`

    const safeListingUrl = listing_url?.startsWith("http")
      ? listing_url
      : `https://telehub.to${listing_url}`

    const payload = {
      username: "TeleHub",
      content: `🔥 **${title || "A Telegram channel"}** was just voted on TeleHub!`,
      embeds: [
        {
          title: title || "Telegram Channel",
          url: safeListingUrl,
          description:
            (description || "A Telegram community was recently voted on TeleHub.").slice(0, 250),
          color: 2260697,
          image: image_url ? { url: image_url } : undefined,
          fields: [
            {
              name: "Votes",
              value: String(votes_count || 0),
              inline: true,
            },
            {
              name: "Members",
              value: member_count
                ? Number(member_count).toLocaleString()
                : "Updating",
              inline: true,
            },
            {
              name: "Categories",
              value:
                Array.isArray(categories) && categories.length
                  ? categories.slice(0, 5).join(", ")
                  : "General",
              inline: false,
            },
          ],
          footer: {
            text: "Recently voted on TeleHub",
          },
          timestamp: new Date().toISOString(),
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "View on TeleHub",
              url: safeListingUrl,
            },
            {
              type: 2,
              style: 5,
              label: "Join Telegram",
              url: safeTelegramLink,
            },
          ],
        },
      ],
    }

    console.log("Sending payload to Discord...")

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    const text = await response.text()

    console.log("Discord webhook status:", response.status)
    console.log("Discord webhook response:", text)

    if (!response.ok) {
      return res.status(500).json({ error: text })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error("Discord vote feed error:", err)
    return res.status(500).json({ error: err.message })
  }
})


app.post("/api/telegram/webhook", async (req, res) => {
  console.log("Telegram webhook hit:", JSON.stringify(req.body, null, 2))
  
  try {
    const update = req.body

    const chat =
      update.my_chat_member?.chat ||
      update.message?.chat ||
      update.channel_post?.chat

    if (!chat) return res.json({ ok: true })

    const username = cleanUsername(chat.username)

    if (!username) {
      return res.json({
        ok: true,
        message: "Bot detected chat, but no public username found.",
      })
    }

    const { data: listings } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .or(
        `telegram_username.eq.${username},telegram_link.ilike.%${username.replace("@", "")}%`
      )

    for (const listing of listings || []) {
      await syncListingTelegramData({
        ...listing,
        telegram_chat_id: String(chat.id),
        telegram_username: username,
      })
    }

    res.json({ ok: true })
  } catch (err) {
    console.error("Telegram webhook error:", err)
    res.status(500).json({ error: err.message })
  }
})



app.post("/api/telegram/sync-listing/:id", async (req, res) => {
  try {
    const { id } = req.params

    const { data: listing, error } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("id", id)
      .single()

    if (error) throw error

    const result = await syncListingTelegramData(listing)

    res.json({
      ok: true,
      member_count: result.memberCount,
      icon_url: result.iconUrl,
      telegram_title: result.chat.title,
      telegram_username: cleanUsername(result.chat.username),
    })
  } catch (err) {
    console.error("Manual sync error:", err)
    res.status(500).json({ error: err.message })
  }
})




app.post("/api/telegram/sync-hourly", async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { data: listings, error } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("status", "approved")

    if (error) throw error

    const results = []

    for (const listing of listings || []) {
      try {
        const synced = await syncListingTelegramData(listing)
        results.push({
          id: listing.id,
          ok: true,
          member_count: synced.memberCount,
        })
      } catch (err) {
        results.push({
          id: listing.id,
          ok: false,
          error: err.message,
        })
      }
    }

    res.json({ ok: true, results })
  } catch (err) {
    console.error("Hourly sync error:", err)
    res.status(500).json({ error: err.message })
  }
})


app.post("/api/admin/approve-listing/:id", async (req, res) => {
  try {
    const { id } = req.params

    const { data: listing, error } = await supabaseAdmin
      .from("channel_listings")
      .update({ status: "approved" })
      .eq("id", id)
      .select()
      .single()

    if (error) throw error

    // 🔹 THIS is the important line
    await syncListingTelegramData(listing)

    res.json({ ok: true })
  } catch (err) {
    console.error("Approve listing error:", err)
    res.status(500).json({ error: err.message })
  }
})



const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})



app.get("/api/telegram/sync-hourly", async (req, res) => {
  try {
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { data: listings, error } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("status", "approved")

    if (error) throw error

    const results = []

    for (const listing of listings || []) {
      try {
        const synced = await syncListingTelegramData(listing)
        results.push({
          id: listing.id,
          ok: true,
          member_count: synced.memberCount,
        })
      } catch (err) {
        results.push({
          id: listing.id,
          ok: false,
          error: err.message,
        })
      }
    }

    res.json({ ok: true, results })
  } catch (err) {
    console.error("Hourly sync error:", err)
    res.status(500).json({ error: err.message })
  }
})
