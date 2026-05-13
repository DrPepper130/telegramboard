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


// ========================================
// FAKE ONLINE COUNTER
// ========================================

let fakeOnlineCount = 151

function updateFakeOnlineCount() {
    const movement = Math.floor(Math.random() * 7) - 3
    fakeOnlineCount += movement

    if (fakeOnlineCount < 100) fakeOnlineCount = 100
    if (fakeOnlineCount > 200) fakeOnlineCount = 200
}

// update once per minute
setInterval(updateFakeOnlineCount, 60 * 1000)

app.get("/api/stats/online", async (req, res) => {
    res.json({
        online: fakeOnlineCount,
    })
})

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)

const RANK_PRICE_IDS = {
  silver: "price_1TWUrs7OqwgduKJFky8xGosP",
  gold: "price_1TWUtJ7OqwgduKJFU5ghC6Md",
  sponsor: "price_1TWUuW7OqwgduKJF8FK40UYG",
}


const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"]

    let event

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (err) {
      console.error("Stripe webhook signature error:", err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object

        const listingId = session.metadata?.listing_id
        const userId = session.metadata?.user_id
        const rank = session.metadata?.rank
        const subscriptionId = session.subscription
        const customerId = session.customer

        if (listingId && userId && rank && subscriptionId) {
          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId)

          await supabaseAdmin
            .from("channel_listings")
            .update({
              paid_rank: rank,
              paid_rank_status: subscription.status,
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              paid_rank_current_period_end: subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000).toISOString()
                : null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", listingId)
            .eq("user_id", userId)
        }
      }

      if (
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        const subscription = event.data.object

        const listingId = subscription.metadata?.listing_id
        const userId = subscription.metadata?.user_id
        const rank = subscription.metadata?.rank

        const activeStatuses = ["active", "trialing"]
        const isActive = activeStatuses.includes(subscription.status)

        if (listingId && userId) {
          await supabaseAdmin
            .from("channel_listings")
            .update({
              paid_rank: isActive ? rank : "free",
              paid_rank_status: subscription.status,
              stripe_subscription_id: subscription.id,
              paid_rank_current_period_end:
                subscription.current_period_end
                  ? new Date(
                      subscription.current_period_end * 1000
                    ).toISOString()
                  : null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", listingId)
            .eq("user_id", userId)
        }
      }

      if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object
        const subscriptionId = invoice.subscription

        if (subscriptionId) {
          await supabaseAdmin
            .from("channel_listings")
            .update({
              paid_rank_status: "payment_failed",
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", subscriptionId)
        }
      }

      return res.json({ received: true })
    } catch (err) {
      console.error("Stripe webhook handling error:", err)
      return res.status(500).json({ error: err.message })
    }
  }
)


app.post("/api/stripe/create-rank-checkout", async (req, res) => {
  try {
    const { listing_id, rank, user_id } = req.body

    const cleanRank = String(rank || "").toLowerCase()
    const priceId = RANK_PRICE_IDS[cleanRank]

    if (!listing_id || !user_id || !priceId) {
      return res.status(400).json({ error: "Missing listing, user, or rank." })
    }

    const { data: listing, error } = await supabaseAdmin
      .from("channel_listings")
      .select("id, user_id, channel_name")
      .eq("id", listing_id)
      .eq("user_id", user_id)
      .single()

    if (error || !listing) {
      return res.status(403).json({ error: "Listing not found or not yours." })
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://telehub.to/dashboard?payment=success",
      cancel_url: "https://telehub.to/dashboard?payment=cancelled",
      metadata: {
        listing_id,
        user_id,
        rank: cleanRank,
      },
      subscription_data: {
        metadata: {
          listing_id,
          user_id,
          rank: cleanRank,
        },
      },
    })

    return res.json({ url: session.url })
  } catch (err) {
    console.error("Stripe checkout error:", err)
    return res.status(500).json({ error: err.message })
  }
})

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
    created_at: new Date().toISOString(),
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

const crypto = require("crypto")

const REFERRAL_DAILY_CAP = 50
const REFERRAL_WINDOW_HOURS = 24

function cleanReferralCode(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function shouldResetReferralWindow(listing) {
  const now = new Date()

  // Arizona timezone
  const arizonaNow = new Date(
    now.toLocaleString("en-US", {
      timeZone: "America/Phoenix",
    })
  )

  // Today's midnight in Arizona
  const arizonaMidnight = new Date(arizonaNow)
  arizonaMidnight.setHours(0, 0, 0, 0)

  if (!listing.referral_last_reset) {
    return true
  }

  const lastReset = new Date(listing.referral_last_reset)

  // Convert last reset into Arizona timezone
  const arizonaLastReset = new Date(
    lastReset.toLocaleString("en-US", {
      timeZone: "America/Phoenix",
    })
  )

  // Reset once calendar day changes in Arizona
  return arizonaLastReset < arizonaMidnight
}

function hashValue(value) {
  if (!value) return null

  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"]

  if (forwarded) {
    return forwarded.split(",")[0].trim()
  }

  return req.socket?.remoteAddress || null
}

function cleanVisitorId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80)
}

app.get("/api/referrals/track", async (req, res) => {
  try {
    const code = cleanReferralCode(req.query.code)
    const visitorId = cleanVisitorId(req.query.visitor_id)

    if (!code) {
      return res.status(400).json({ error: "Missing referral code" })
    }

    const { data: listing, error } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("short_invite", code)
      .eq("status", "approved")
      .maybeSingle()

    if (error) throw error

    if (!listing || listing.is_banned) {
      return res.status(404).json({ error: "Invite not found" })
    }

    const nowDate = new Date()
    const now = nowDate.toISOString()
    const resetNeeded = shouldResetReferralWindow(listing)

    const windowStartDate = resetNeeded
      ? nowDate
      : new Date(listing.referral_last_reset || now)

    const windowStart = windowStartDate.toISOString()

    const ip = getClientIp(req)
    const userAgent = req.headers["user-agent"] || ""

    const visitorHash = hashValue(visitorId)
    const ipHash = hashValue(ip)
    const userAgentHash = hashValue(userAgent)
    const ipUserAgentHash = hashValue(`${ip || ""}|${userAgent || ""}`)

    const startingClicks = resetNeeded
      ? 0
      : Number(listing.referral_clicks_today || 0)

    let alreadyCounted = false

    let duplicateChecks = []

    if (visitorHash) {
      duplicateChecks.push(`visitor_hash.eq.${visitorHash}`)
    }

    if (ipHash) {
      duplicateChecks.push(`ip_hash.eq.${ipHash}`)
    }

    if (ipUserAgentHash) {
      duplicateChecks.push(`ip_user_agent_hash.eq.${ipUserAgentHash}`)
    }

    if (duplicateChecks.length > 0) {
      const { data: existingClick, error: existingError } = await supabaseAdmin
        .from("listing_referral_clicks")
        .select("id")
        .eq("listing_id", listing.id)
        .gte("created_at", windowStart)
        .or(duplicateChecks.join(","))
        .limit(1)
        .maybeSingle()

      if (existingError) throw existingError

      alreadyCounted = !!existingClick
    }

    const canCount =
      !alreadyCounted &&
      startingClicks < REFERRAL_DAILY_CAP &&
      (visitorHash || ipHash || ipUserAgentHash)

    const nextClicks = canCount ? startingClicks + 1 : startingClicks
    const nextBoost = Math.round(
      (Math.min(nextClicks, REFERRAL_DAILY_CAP) / REFERRAL_DAILY_CAP) * 100
    )

    if (canCount) {
      await supabaseAdmin.from("listing_referral_clicks").insert({
        listing_id: listing.id,
        short_invite: code,

        // Keep raw values only if your table already has these columns.
        // If you prefer privacy-only, remove ip_address and user_agent.
        ip_address: ip,
        user_agent: userAgent,

        visitor_hash: visitorHash,
        ip_hash: ipHash,
        user_agent_hash: userAgentHash,
        ip_user_agent_hash: ipUserAgentHash,

        counted: true,
        created_at: now,
      })
    } else {
      await supabaseAdmin.from("listing_referral_clicks").insert({
        listing_id: listing.id,
        short_invite: code,
        ip_address: ip,
        user_agent: userAgent,
        visitor_hash: visitorHash,
        ip_hash: ipHash,
        user_agent_hash: userAgentHash,
        ip_user_agent_hash: ipUserAgentHash,
        counted: false,
        created_at: now,
      })
    }

    const { error: updateError } = await supabaseAdmin
      .from("channel_listings")
      .update({
        referral_clicks_today: nextClicks,
        referral_boost_score: nextBoost,
        referral_last_reset: resetNeeded ? now : listing.referral_last_reset,
        updated_at: now,
      })
      .eq("id", listing.id)

    if (updateError) throw updateError

    return res.json({
      ok: true,
      counted: canCount,
      already_counted: alreadyCounted,
      telegram_link: listing.telegram_link,
      clicks_today: nextClicks,
      boost_percent: nextBoost,
      daily_cap: REFERRAL_DAILY_CAP,
    })
  } catch (err) {
    console.error("Referral tracking error:", err)
    return res.status(500).json({ error: err.message })
  }
})



// ========================================
// RANKING ALGORITHM
// ========================================

const RANKING_WEIGHTS = {
  votes: 0.35,
  referralBoost: 0.25,
  memberGrowth: 0.25,
  freshness: 0.15,
}

function clampNumber(value, min, max) {
  const num = Number(value || 0)
  if (!Number.isFinite(num)) return min
  return Math.max(min, Math.min(max, num))
}

function normalizeLogScore(value, maxValue) {
  const num = Math.max(0, Number(value || 0))
  const max = Math.max(1, Number(maxValue || 1))

  return Math.min(100, (Math.log10(num + 1) / Math.log10(max + 1)) * 100)
}

function getFreshnessScore(listing) {
  const dateValue =
    listing.updated_at ||
    listing.last_synced_at ||
    listing.created_at

  if (!dateValue) return 0

  const ageMs = Date.now() - new Date(dateValue).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)

  if (!Number.isFinite(ageDays)) return 0

  // Full power when very fresh, fades over 30 days
  return clampNumber(100 - (ageDays / 30) * 100, 0, 100)
}

function calculateRankingScore(listing, maxStats) {
  const voteScore = normalizeLogScore(
    listing.votes_count || 0,
    maxStats.maxVotes
  )

  const referralScore = clampNumber(
    listing.referral_boost_score || 0,
    0,
    100
  )

  const memberGrowthScore = normalizeLogScore(
    listing.member_growth_24h || 0,
    maxStats.maxGrowth
  )

  const freshnessScore = getFreshnessScore(listing)

  const rankingScore =
    voteScore * RANKING_WEIGHTS.votes +
    referralScore * RANKING_WEIGHTS.referralBoost +
    memberGrowthScore * RANKING_WEIGHTS.memberGrowth +
    freshnessScore * RANKING_WEIGHTS.freshness

  return {
    ranking_score: Math.round(rankingScore * 100) / 100,
    ranking_breakdown: {
      vote_score: Math.round(voteScore * 100) / 100,
      referral_score: Math.round(referralScore * 100) / 100,
      member_growth_score: Math.round(memberGrowthScore * 100) / 100,
      freshness_score: Math.round(freshnessScore * 100) / 100,
    },
  }
}



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


app.get("/api/listings/ranked", async (req, res) => {
  try {
    const { data: listings, error: listingsError } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("status", "approved")

    if (listingsError) throw listingsError

    const listingIds = (listings || []).map((item) => item.id)

    let snapshots = []

    if (listingIds.length > 0) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

      const { data: snapshotData, error: snapshotError } = await supabaseAdmin
        .from("channel_member_snapshots")
        .select("listing_id, member_count, created_at")
        .in("listing_id", listingIds)
        .gte("created_at", since)
        .order("created_at", { ascending: true })

      if (snapshotError) throw snapshotError

      snapshots = snapshotData || []
    }

    const snapshotsByListing = {}

    snapshots.forEach((snapshot) => {
      if (!snapshotsByListing[snapshot.listing_id]) {
        snapshotsByListing[snapshot.listing_id] = []
      }

      snapshotsByListing[snapshot.listing_id].push(snapshot)
    })

    const listingsWithGrowth = (listings || []).map((listing) => {
      const listingSnapshots = snapshotsByListing[listing.id] || []
      const firstSnapshot = listingSnapshots[0]
      const latestSnapshot = listingSnapshots[listingSnapshots.length - 1]

      const oldMembers = Number(firstSnapshot?.member_count || listing.member_count || 0)
      const latestMembers = Number(latestSnapshot?.member_count || listing.member_count || 0)

      const memberGrowth24h = Math.max(0, latestMembers - oldMembers)

      return {
        ...listing,
        member_growth_24h: memberGrowth24h,
      }
    })

    const maxStats = {
      maxVotes: Math.max(
        1,
        ...listingsWithGrowth.map((item) => Number(item.votes_count || 0))
      ),
      maxGrowth: Math.max(
        1,
        ...listingsWithGrowth.map((item) => Number(item.member_growth_24h || 0))
      ),
    }

    const rankedListings = listingsWithGrowth
      .map((listing) => {
        const ranking = calculateRankingScore(listing, maxStats)

        return {
          ...listing,
          ...ranking,
        }
      })
      .sort((a, b) => {
        if (b.ranking_score !== a.ranking_score) {
          return b.ranking_score - a.ranking_score
        }

        return (
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
        )
      })

    return res.json({
      ok: true,
      listings: rankedListings,
      weights: RANKING_WEIGHTS,
    })
  } catch (err) {
    console.error("Ranked listings error:", err)
    return res.status(500).json({ error: err.message })
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
