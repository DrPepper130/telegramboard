const express = require("express")
const { createClient } = require("@supabase/supabase-js")
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)
const app = express()

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://telehub.to")
  res.header("Access-Control-Allow-Methods","GET, POST, DELETE, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Template-Session")

  if (req.method === "OPTIONS") {
    return res.sendStatus(200)
  }

  next()
})

const BACKEND_BUILD_ID =
  "telehub-telemetr-nonoverlapping-ranges-2026-07-29"

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "Telegram sync backend",
    build: BACKEND_BUILD_ID,
  })
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
// ONLINE COUNTER
// ========================================

// Start blank/hidden until first update happens
let fakeOnlineCount = null

function updateFakeOnlineCount() {
  // First real value: start somewhere between 1,000 and 2,000
  if (fakeOnlineCount === null) {
    fakeOnlineCount = Math.floor(Math.random() * 10001) + 10000
    return
  }

  // Change by 10–25 users per minute
  const changeAmount = Math.floor(Math.random() * 160) + 100

  // Randomly go up or down
  const direction = Math.random() < 0.5 ? -1 : 1

  fakeOnlineCount += changeAmount * direction

  // Keep it between 1,000 and 2,000
  if (fakeOnlineCount < 10000) fakeOnlineCount = 10000
  if (fakeOnlineCount > 20000) fakeOnlineCount = 20000
}

// update once per minute
setInterval(updateFakeOnlineCount, 60 * 1000)

app.get("/api/stats/online", async (req, res) => {
  res.json({
    online: fakeOnlineCount,
  })
})



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
              paid_rank_current_period_end:
                subscription.items?.data?.[0]?.current_period_end
                  ? new Date(
                    subscription.items.data[0].current_period_end * 1000
                  ).toISOString()
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
                subscription.items?.data?.[0]?.current_period_end
                  ? new Date(
                    subscription.items.data[0].current_period_end * 1000
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

app.use(express.json({ limit: "2mb" }))
const RANK_PRICE_IDS = {
  silver: "price_1TWUrs7OqwgduKJFky8xGosP",
  gold: "price_1TWUtJ7OqwgduKJFU5ghC6Md",
  sponsor: "price_1TWUuW7OqwgduKJF8FK40UYG",
}


app.post("/api/stripe/create-billing-portal", async (req, res) => {
  try {
    const { listing_id, user_id } = req.body

    const { data: listing, error } = await supabaseAdmin
      .from("channel_listings")
      .select("id, user_id, stripe_customer_id")
      .eq("id", listing_id)
      .eq("user_id", user_id)
      .single()

    if (error || !listing?.stripe_customer_id) {
      return res.status(400).json({ error: "No Stripe customer found." })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: listing.stripe_customer_id,
      return_url: "https://telehub.to/dashboard",
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error("Billing portal error:", err)
    res.status(500).json({ error: err.message })
  }
})


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

  const json = await res.json().catch(() => ({}))

  if (!json.ok) {
    const retryAfter = Number(
      json?.parameters?.retry_after ||
      String(json?.description || "").match(/retry after\s+(\d+)/i)?.[1] ||
      0
    )

    const error = new Error(json.description || "Telegram API error")
    error.code = res.status === 429 || retryAfter > 0
      ? "TELEGRAM_RATE_LIMITED"
      : "TELEGRAM_API_ERROR"
    error.status = res.status
    error.retry_after_seconds = retryAfter
    error.telegram_method = method
    throw error
  }

  return json.result
}

function cleanUsername(username) {
  if (!username) return null
  return username.startsWith("@") ? username : `@${username}`
}

function normalizeTelegramType(chatType) {
  if (chatType === "channel") return "channel"
  if (chatType === "group" || chatType === "supergroup") return "group"
  return null
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


function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    )
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim()
}

function publicTelegramUsername(listing) {
  const username =
    listing.telegram_username ||
    extractUsernameFromLink(listing.telegram_link)

  if (!username) return null

  const clean = String(username)
    .replace(/^@/, "")
    .trim()

  if (!/^[a-zA-Z0-9_]{3,}$/.test(clean)) return null
  return clean
}

function parseDisplayedTelegramCount(rawText) {
  const normalized = decodeHtmlEntities(rawText)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const match = normalized.match(
    /([\d\s.,]+)\s*([kmb])?\s+(members?|subscribers?|participants?)/i
  )

  if (!match) return null

  const countText = match[1].trim()
  const suffix = String(match[2] || "").toLowerCase()

  let memberCount = null

  if (suffix) {
    const numeric = Number(
      countText
        .replace(/\s+/g, "")
        .replace(/,(?=\d{1,2}$)/, ".")
        .replace(/,/g, "")
    )

    if (Number.isFinite(numeric)) {
      const multiplier =
        suffix === "k"
          ? 1_000
          : suffix === "m"
            ? 1_000_000
            : suffix === "b"
              ? 1_000_000_000
              : 1

      memberCount = Math.round(numeric * multiplier)
    }
  } else {
    const digitsOnly = countText.replace(/[^\d]/g, "")
    if (digitsOnly) memberCount = Number(digitsOnly)
  }

  if (!Number.isFinite(memberCount)) return null

  return {
    memberCount,
    listingType: /subscribers?/i.test(match[3]) ? "channel" : "group",
    rawDisplay: match[0],
  }
}


function classifyTelegramPublicPage(html, username) {
  const rawHtml = String(html || "")
  const decodedHtml = decodeHtmlEntities(rawHtml)
  const visibleText = stripHtml(decodedHtml).replace(/\s+/g, " ").trim()

  const htmlTitle =
    stripHtml(
      rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""
    ) || ""

  const actionText =
    stripHtml(
      rawHtml.match(
        /<div[^>]+class=["'][^"']*tgme_page_action[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
      )?.[1] || ""
    ) || ""

  const extras = []
  const extraRegex =
    /<div[^>]+class=["'][^"']*tgme_page_extra[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
  let extraMatch
  while ((extraMatch = extraRegex.exec(rawHtml))) {
    const value = stripHtml(extraMatch[1] || "").replace(/\s+/g, " ").trim()
    if (value) extras.push(value)
  }

  const extraText = extras.join(" | ")
  const parsedCount = parseDisplayedTelegramCount(extraText)

  const hasPreviewChannel =
    /class=["'][^"']*tgme_page_context_link[^"']*["'][^>]*href=["'][^"']*\/s\/[^"']+["']/i.test(
      rawHtml
    ) ||
    /\bPreview channel\b/i.test(visibleText)

  const hasMonthlyUsers =
    /\b[\d\s.,]+\s+(?:monthly\s+users?|monthly\s+active\s+users?)\b/i.test(
      extraText
    ) || /\bmonthly users?\b/i.test(visibleText)

  const isBotAction =
    /\bStart Bot\b/i.test(actionText) ||
    /\bStart Bot\b/i.test(visibleText) ||
    /\byou can launch\b/i.test(visibleText)

  const isUserPage =
    /^Telegram:\s*Contact\s+@/i.test(htmlTitle) ||
    /\bSend Message\b/i.test(actionText) ||
    /\byou can contact\b/i.test(visibleText)

  const isViewPage =
    /^Telegram:\s*View\s+@/i.test(htmlTitle) ||
    /\bView in Telegram\b/i.test(actionText)

  if (hasMonthlyUsers || isBotAction) {
    return {
      entityType: "bot",
      listingType: null,
      memberCount: null,
      rawDisplay: extraText || null,
      htmlTitle,
      actionText,
      reason: hasMonthlyUsers ? "monthly_users" : "start_bot",
    }
  }

  if (isUserPage) {
    return {
      entityType: "user",
      listingType: null,
      memberCount: null,
      rawDisplay: extraText || null,
      htmlTitle,
      actionText,
      reason: "contact_page",
    }
  }

  if (parsedCount?.listingType === "channel") {
    return {
      entityType: "channel",
      listingType: "channel",
      memberCount: parsedCount.memberCount,
      rawDisplay: parsedCount.rawDisplay,
      htmlTitle,
      actionText,
      reason:
        hasPreviewChannel || isViewPage
          ? "subscriber_count_and_channel_structure"
          : "subscriber_count",
    }
  }

  if (parsedCount?.listingType === "group") {
    return {
      entityType: "group",
      listingType: "group",
      memberCount: parsedCount.memberCount,
      rawDisplay: parsedCount.rawDisplay,
      htmlTitle,
      actionText,
      reason: "member_count",
    }
  }

  if (hasPreviewChannel || isViewPage) {
    return {
      entityType: "unknown_channel_like",
      listingType: null,
      memberCount: null,
      rawDisplay: extraText || null,
      htmlTitle,
      actionText,
      reason: "channel_structure_without_count",
    }
  }

  return {
    entityType: "unknown",
    listingType: null,
    memberCount: null,
    rawDisplay: extraText || null,
    htmlTitle,
    actionText,
    reason: "unrecognized_public_page",
  }
}

async function fetchPublicTelegramPage(listing) {
  const username = publicTelegramUsername(listing)

  if (!username) {
    const error = new Error(
      "No public Telegram username is available for webpage scraping."
    )
    error.code = "TME_SCRAPE_UNAVAILABLE"
    throw error
  }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(3000, Number(process.env.TME_SCRAPE_TIMEOUT_MS || 12000))
  )

  try {
    const pageUrl = `https://t.me/${encodeURIComponent(username)}`
    const response = await fetch(pageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.TME_SCRAPE_USER_AGENT ||
          "Mozilla/5.0 (compatible; TeleHubBot/1.0; +https://telehub.to)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
        "Cache-Control": "no-cache",
      },
    })

    if (!response.ok) {
      const error = new Error(
        `Telegram public page returned HTTP ${response.status}.`
      )
      error.code =
        response.status === 429
          ? "TME_SCRAPE_RATE_LIMITED"
          : "TME_SCRAPE_HTTP_ERROR"
      error.status = response.status
      throw error
    }

    const html = await response.text()

    const titleMatch =
      html.match(
        /<div[^>]+class="[^"]*tgme_page_title[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      ) ||
      html.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i
      )

    const descriptionMatch =
      html.match(
        /<div[^>]+class="[^"]*tgme_page_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      ) ||
      html.match(
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i
      )

    const imageMatch =
      html.match(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<img[^>]+class="[^"]*tgme_page_photo_image[^"]*"[^>]+src=["']([^"']+)["']/i
      )

    const classification = classifyTelegramPublicPage(html, username)

    if (classification.entityType === "bot") {
      const error = new Error(
        "Telegram public page is a bot or mini-app, not a channel/group."
      )
      error.code = "TME_ENTITY_BOT"
      error.entity_type = "bot"
      error.classification_reason = classification.reason
      throw error
    }

    if (classification.entityType === "user") {
      const error = new Error(
        "Telegram public page is a personal/user account, not a channel/group."
      )
      error.code = "TME_ENTITY_USER"
      error.entity_type = "user"
      error.classification_reason = classification.reason
      throw error
    }

    if (
      classification.listingType !== "channel" &&
      classification.listingType !== "group"
    ) {
      const error = new Error(
        "Telegram public page could not be confidently classified as a channel or group."
      )
      error.code =
        classification.entityType === "unknown_channel_like"
          ? "TME_ENTITY_CHANNEL_LIKE_NO_COUNT"
          : "TME_ENTITY_UNKNOWN"
      error.entity_type = classification.entityType
      error.classification_reason = classification.reason
      throw error
    }

    return {
      username,
      telegramUsername: `@${username}`,
      telegramLink: `https://t.me/${username}`,
      title: stripHtml(titleMatch?.[1] || ""),
      description: stripHtml(descriptionMatch?.[1] || ""),
      iconUrl: decodeHtmlEntities(imageMatch?.[1] || "") || null,
      memberCount: classification.memberCount,
      listingType: classification.listingType,
      rawDisplay: classification.rawDisplay,
      entityType: classification.entityType,
      classificationReason: classification.reason,
      source: "tme_public_page_structural",
    }
  } finally {
    clearTimeout(timeout)
  }
}


function compactTelegramPostText(value) {
  return stripHtml(value)
    .replace(/\s+/g, " ")
    .trim()
}

async function fetchPublicTelegramPostContext(listing, options = {}) {
  const username = publicTelegramUsername(listing)

  if (!username) {
    const error = new Error(
      "No public Telegram username is available for post-context scraping."
    )
    error.code = "TME_POST_CONTEXT_UNAVAILABLE"
    throw error
  }

  const maxPosts = Math.max(
    1,
    Math.min(Number(options.maxPosts || process.env.TME_IMPORT_POST_LIMIT || 15), 30)
  )
  const maxCharacters = Math.max(
    500,
    Math.min(
      Number(options.maxCharacters || process.env.TME_IMPORT_CONTEXT_MAX_CHARS || 7000),
      15000
    )
  )

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(3000, Number(process.env.TME_POST_SCRAPE_TIMEOUT_MS || 12000))
  )

  try {
    const pageUrl = `https://t.me/s/${encodeURIComponent(username)}`
    const response = await fetch(pageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.TME_SCRAPE_USER_AGENT ||
          "Mozilla/5.0 (compatible; TeleHubBot/1.0; +https://telehub.to)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
        "Cache-Control": "no-cache",
      },
    })

    if (!response.ok) {
      const error = new Error(
        `Telegram public post page returned HTTP ${response.status}.`
      )
      error.code =
        response.status === 429
          ? "TME_POST_CONTEXT_RATE_LIMITED"
          : "TME_POST_CONTEXT_HTTP_ERROR"
      error.status = response.status
      throw error
    }

    const html = await response.text()
    const posts = []
    const imageUrls = []
    const telegramLinks = []
    const messageRegex =
      /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi

    // Public Telegram post pages expose photo URLs in inline background-image
    // styles. Video posts often expose a poster image instead.
    const photoRegex =
      /class=["'][^"']*tgme_widget_message_photo_wrap[^"']*["'][^>]*style=["'][^"']*background-image\s*:\s*url\((?:&quot;|["']?)(https?:[^)"'&]+)(?:&quot;|["']?)\)/gi
    const posterRegex =
      /<video[^>]+poster=["'](https?:[^"']+)["']/gi
    const imageTagRegex =
      /<img[^>]+class=["'][^"']*tgme_widget_message_photo[^"']*["'][^>]+src=["'](https?:[^"']+)["']/gi

    for (const regex of [photoRegex, posterRegex, imageTagRegex]) {
      let imageMatch
      while ((imageMatch = regex.exec(html)) && imageUrls.length < 20) {
        const url = decodeHtmlEntities(imageMatch[1] || "").trim()
        if (url && !imageUrls.includes(url)) imageUrls.push(url)
      }
    }

    const discoveredUsernames = new Set()
    const absoluteTelegramRegex =
      /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]{4,})(?:\/?|[?#][^\s"'<>]*)/gi
    const mentionRegex = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z][a-zA-Z0-9_]{3,31})\b/g
    const blockedTelegramRoutes = new Set([
      "s", "joinchat", "addstickers", "addemoji", "share", "proxy",
      "socks", "login", "iv", "setlanguage", "confirmphone",
    ])

    let discoveryMatch
    while ((discoveryMatch = absoluteTelegramRegex.exec(html))) {
      const candidate = String(discoveryMatch[1] || "").trim()
      if (
        candidate &&
        !blockedTelegramRoutes.has(candidate.toLowerCase()) &&
        /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(candidate)
      ) {
        discoveredUsernames.add(candidate)
      }
    }

    const visibleText = stripHtml(html)
    while ((discoveryMatch = mentionRegex.exec(visibleText))) {
      const candidate = String(discoveryMatch[1] || "").trim()
      if (candidate) discoveredUsernames.add(candidate)
    }

    for (const candidate of discoveredUsernames) {
      telegramLinks.push(`https://t.me/${candidate}`)
      if (telegramLinks.length >= 100) break
    }

    let match
    let totalCharacters = 0

    while ((match = messageRegex.exec(html)) && posts.length < maxPosts) {
      const cleanText = compactTelegramPostText(match[1])
      if (!cleanText) continue

      const remaining = maxCharacters - totalCharacters
      if (remaining <= 0) break

      const clipped = cleanText.slice(0, remaining)
      posts.push(clipped)
      totalCharacters += clipped.length
    }

    return {
      username,
      pageUrl,
      posts,
      postCount: posts.length,
      contextText: posts.join("\n\n---\n\n"),
      imageUrls,
      imageCount: imageUrls.length,
      telegramLinks,
      telegramLinkCount: telegramLinks.length,
      source: "tme_public_posts",
    }
  } finally {
    clearTimeout(timeout)
  }
}


function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { extension: "jpg", contentType: "image/jpeg" }
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { extension: "png", contentType: "image/png" }
  }

  const gifHeader = buffer.subarray(0, 6).toString("ascii")
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { extension: "gif", contentType: "image/gif" }
  }

  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp", contentType: "image/webp" }
  }

  return null
}

async function normalizeTelegramIconBuffer(
  inputBuffer,
  reportedContentType = ""
) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error("Telegram icon response was empty.")
  }

  const cleanReportedType = String(reportedContentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase()

  const detected = detectImageFormat(inputBuffer)

  // Keep already-safe raster formats without recompressing them.
  if (detected) {
    return {
      buffer: inputBuffer,
      extension: detected.extension,
      contentType: detected.contentType,
      converted: false,
      sourceFormat: detected.extension,
    }
  }

  // Sharp handles valid SVG, AVIF, TIFF and other supported formats.
  // Everything non-standard is normalized to PNG for reliable Framer import.
  try {
    const metadata = await sharp(inputBuffer, {
      failOn: "error",
      density: 192,
    }).metadata()

    const outputBuffer = await sharp(inputBuffer, {
      failOn: "error",
      density: 192,
    })
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
      })
      .toBuffer()

    return {
      buffer: outputBuffer,
      extension: "png",
      contentType: "image/png",
      converted: true,
      sourceFormat:
        metadata.format ||
        cleanReportedType ||
        "unknown",
    }
  } catch (err) {
    throw new Error(
      `Telegram icon could not be decoded or converted. ` +
      `Reported content type: ${cleanReportedType || "unknown"}. ` +
      `Sharp error: ${err.message}`
    )
  }
}


function stableStringHash(value) {
  let hash = 2166136261
  const text = String(value || "")

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

async function uploadRemoteListingBackground(remoteUrl, listingId, source = "remote") {
  if (!remoteUrl) return null

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(4000, Number(process.env.BACKGROUND_FETCH_TIMEOUT_MS || 15000))
  )

  try {
    const imageRes = await fetch(remoteUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.TME_SCRAPE_USER_AGENT ||
          "Mozilla/5.0 (compatible; TeleHubBot/1.0; +https://telehub.to)",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    })

    if (!imageRes.ok) {
      throw new Error(`Background image returned HTTP ${imageRes.status}.`)
    }

    const contentLength = Number(imageRes.headers.get("content-length") || 0)
    if (contentLength > 12 * 1024 * 1024) {
      throw new Error("Background image is larger than 12MB.")
    }

    const inputBuffer = Buffer.from(await imageRes.arrayBuffer())
    if (!inputBuffer.length || inputBuffer.length > 12 * 1024 * 1024) {
      throw new Error("Background image was empty or larger than 12MB.")
    }

    const outputBuffer = await sharp(inputBuffer, {
      failOn: "error",
      density: 144,
    })
      .rotate()
      .resize({
        width: 1600,
        height: 900,
        fit: "cover",
        position: "attention",
        withoutEnlargement: false,
      })
      .jpeg({
        quality: 82,
        mozjpeg: true,
      })
      .toBuffer()

    const cleanSource = String(source || "remote")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .slice(0, 30)

    const path =
      `listing-backgrounds/${listingId}-${cleanSource}-${Date.now()}.jpg`

    const { error } = await supabaseAdmin.storage
      .from("listing-images")
      .upload(path, outputBuffer, {
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: false,
      })

    if (error) throw error

    const { data } = supabaseAdmin.storage
      .from("listing-images")
      .getPublicUrl(path)

    return data.publicUrl
  } finally {
    clearTimeout(timeout)
  }
}

function buildRelatedBackgroundQuery(aiContent, listingType) {
  const categories = Array.isArray(aiContent?.categories)
    ? aiContent.categories.filter(Boolean).slice(0, 2)
    : []

  const raw = [
    ...categories,
    aiContent?.display_name,
    listingType === "group" ? "community" : "news",
  ]
    .filter(Boolean)
    .join(" ")

  return raw
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

async function findPexelsRelatedBackground(query, seed) {
  const apiKey = String(process.env.PEXELS_API_KEY || "").trim()
  if (!apiKey) {
    const error = new Error(
      "PEXELS_API_KEY is not set. Add it in Render to test related-image backgrounds."
    )
    error.code = "PEXELS_API_KEY_MISSING"
    throw error
  }

  const searchUrl =
    `https://api.pexels.com/v1/search?orientation=landscape&per_page=20&query=` +
    encodeURIComponent(query || "abstract technology")

  const response = await fetch(searchUrl, {
    headers: {
      Authorization: apiKey,
      "User-Agent": "TeleHub/1.0",
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      data?.error || `Pexels search returned HTTP ${response.status}.`
    )
  }

  const photos = Array.isArray(data?.photos) ? data.photos : []
  const usable = photos.filter(
    (photo) => photo?.src?.landscape || photo?.src?.large2x || photo?.src?.large
  )

  if (!usable.length) {
    throw new Error(`No related landscape images were found for "${query}".`)
  }

  const selected = usable[stableStringHash(seed) % usable.length]

  return {
    remoteUrl:
      selected.src.landscape ||
      selected.src.large2x ||
      selected.src.large,
    provider: "pexels",
    providerId: selected.id || null,
    photographer: selected.photographer || null,
    photographerUrl: selected.photographer_url || null,
    sourcePageUrl: selected.url || null,
    query,
  }
}

async function chooseAndUploadImportBackground({
  mode,
  listingId,
  iconUrl,
  postContext,
  aiContent,
  listingType,
  seed,
}) {
  const cleanMode = String(mode || "none").toLowerCase()

  if (cleanMode === "none") {
    return { imageUrl: null, source: "none" }
  }

  if (cleanMode === "icon") {
    return {
      imageUrl: iconUrl || null,
      source: iconUrl ? "telegram_icon" : "none",
      error: iconUrl ? null : "Telegram icon was unavailable.",
    }
  }

  if (cleanMode === "telegram_post") {
    const candidates = Array.isArray(postContext?.imageUrls)
      ? postContext.imageUrls.filter(Boolean)
      : []

    if (!candidates.length) {
      return {
        imageUrl: null,
        source: "telegram_post",
        error: "No usable image was found in the recent public Telegram posts.",
      }
    }

    // Try several candidates because a Telegram CDN URL may occasionally expire
    // or point to a format Sharp cannot decode.
    const startIndex = stableStringHash(seed) % candidates.length
    let lastError = null

    for (let offset = 0; offset < Math.min(candidates.length, 5); offset += 1) {
      const candidate = candidates[(startIndex + offset) % candidates.length]

      try {
        const imageUrl = await uploadRemoteListingBackground(
          candidate,
          listingId,
          "telegram-post"
        )

        return {
          imageUrl,
          source: "telegram_post",
          remoteUrl: candidate,
        }
      } catch (error) {
        lastError = error
      }
    }

    return {
      imageUrl: null,
      source: "telegram_post",
      error: lastError?.message || "Telegram post images could not be uploaded.",
    }
  }

  if (cleanMode === "related") {
    const query = buildRelatedBackgroundQuery(aiContent, listingType)
    const related = await findPexelsRelatedBackground(query, seed)
    const imageUrl = await uploadRemoteListingBackground(
      related.remoteUrl,
      listingId,
      "pexels"
    )

    return {
      imageUrl,
      source: "related",
      ...related,
    }
  }

  return {
    imageUrl: null,
    source: "none",
    error: `Unsupported background mode: ${cleanMode}`,
  }
}

async function uploadRemoteTelegramPhoto(remoteUrl, listingId) {
  if (!remoteUrl) return null

  const imageRes = await fetch(remoteUrl, {
    headers: {
      "User-Agent":
        process.env.TME_SCRAPE_USER_AGENT ||
        "Mozilla/5.0 (compatible; TeleHubBot/1.0; +https://telehub.to)",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  })

  if (!imageRes.ok) {
    throw new Error(
      `Telegram public icon returned HTTP ${imageRes.status}.`
    )
  }

  const reportedContentType =
    imageRes.headers.get("content-type") || ""

  const arrayBuffer = await imageRes.arrayBuffer()
  const inputBuffer = Buffer.from(arrayBuffer)
  const normalized = await normalizeTelegramIconBuffer(
    inputBuffer,
    reportedContentType
  )

  const path =
    `telegram-icons/${listingId}-${Date.now()}.${normalized.extension}`

  const { error } = await supabaseAdmin.storage
    .from("listing-images")
    .upload(path, normalized.buffer, {
      contentType: normalized.contentType,
      upsert: true,
    })

  if (error) throw error

  const { data } = supabaseAdmin.storage
    .from("listing-images")
    .getPublicUrl(path)

  console.log("Telegram icon normalized:", {
    listing_id: listingId,
    source_format: normalized.sourceFormat,
    output_format: normalized.extension,
    converted: normalized.converted,
    bytes_in: inputBuffer.length,
    bytes_out: normalized.buffer.length,
  })

  return data.publicUrl
}

async function uploadTelegramPhoto(fileId, listingId) {
  const file = await tg("getFile", { file_id: fileId })

  const fileUrl =
    `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`

  const imageRes = await fetch(fileUrl)

  if (!imageRes.ok) {
    throw new Error(
      `Telegram Bot API icon returned HTTP ${imageRes.status}.`
    )
  }

  const reportedContentType =
    imageRes.headers.get("content-type") || ""

  const arrayBuffer = await imageRes.arrayBuffer()
  const inputBuffer = Buffer.from(arrayBuffer)
  const normalized = await normalizeTelegramIconBuffer(
    inputBuffer,
    reportedContentType
  )

  const path =
    `telegram-icons/${listingId}-${Date.now()}.${normalized.extension}`

  const { error } = await supabaseAdmin.storage
    .from("listing-images")
    .upload(path, normalized.buffer, {
      contentType: normalized.contentType,
      upsert: true,
    })

  if (error) throw error

  const { data } = supabaseAdmin.storage
    .from("listing-images")
    .getPublicUrl(path)

  console.log("Telegram Bot API icon normalized:", {
    listing_id: listingId,
    source_format: normalized.sourceFormat,
    output_format: normalized.extension,
    converted: normalized.converted,
    bytes_in: inputBuffer.length,
    bytes_out: normalized.buffer.length,
  })

  return data.publicUrl
}

async function recordTelegramScrapeFailure(listing, error) {
  const nextFailureCount =
    Number(listing?.scrape_failure_count || 0) + 1

  const { error: updateError } = await supabaseAdmin
    .from("channel_listings")
    .update({
      scrape_failure_count: nextFailureCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listing.id)

  if (updateError) {
    console.warn("Could not record Telegram scrape failure:", {
      listing_id: listing.id,
      original_error: error?.message,
      update_error: updateError.message,
    })
  }
}

async function syncListingTelegramData(listing, options = {}) {
  const refreshIcon = options.refreshIcon !== false
  const insertSnapshot = options.insertSnapshot !== false

  let scraped = null
  let scrapeError = null

  try {
    scraped = await fetchPublicTelegramPage(listing)
  } catch (err) {
    scrapeError = err
    console.warn("Telegram public-page scrape failed; using Bot API fallback:", {
      listing_id: listing.id,
      channel_name: listing.channel_name,
      code: err.code,
      error: err.message,
    })
  }

  if (scraped) {
    console.log("Telegram public-page scrape succeeded:", {
      listing_id: listing.id,
      username: scraped.telegramUsername,
      member_count: scraped.memberCount,
      listing_type: scraped.listingType,
      title: scraped.title,
      icon_found: Boolean(scraped.iconUrl),
      source: scraped.source,
      raw_display: scraped.rawDisplay,
    })

    let iconUrl = listing.icon_url || null

    if (refreshIcon && scraped.iconUrl) {
      try {
        iconUrl = await uploadRemoteTelegramPhoto(
          scraped.iconUrl,
          listing.id
        )
      } catch (photoErr) {
        console.warn("Telegram scraped photo upload failed:", {
          listing_id: listing.id,
          error: photoErr.message,
        })
      }
    }

    const now = new Date().toISOString()

    const { error: updateError } = await supabaseAdmin
      .from("channel_listings")
      .update({
        telegram_username: scraped.telegramUsername,
        telegram_title:
          scraped.title || listing.telegram_title || listing.channel_name,
        telegram_description:
          scraped.description ||
          listing.telegram_description ||
          null,
        member_count: scraped.memberCount,
        icon_url: iconUrl,
        listing_type: scraped.listingType,
        last_synced_at: now,
        telegram_metadata_synced_at: now,
        last_member_scraped_at: now,
        last_metadata_scraped_at: now,
        ...(refreshIcon ? { last_icon_scraped_at: now } : {}),
        scrape_source: scraped.source,
        scrape_failure_count: 0,
        updated_at: now,
      })
      .eq("id", listing.id)

    if (updateError) throw updateError

    if (insertSnapshot) {
      const { error: snapshotError } = await supabaseAdmin
        .from("channel_member_snapshots")
        .insert({
          listing_id: listing.id,
          member_count: scraped.memberCount,
          created_at: now,
        })

      if (snapshotError) {
        console.warn("Member snapshot insert failed:", {
          listing_id: listing.id,
          error: snapshotError.message,
        })
      }
    }

    return {
      chat: null,
      memberCount: scraped.memberCount,
      iconUrl,
      listingType: scraped.listingType,
      successfulTarget: scraped.telegramUsername,
      source: scraped.source,
      rawDisplay: scraped.rawDisplay,
    }
  }

  const possibleTargets = [
    listing.telegram_chat_id
      ? String(listing.telegram_chat_id).trim()
      : null,
    listing.telegram_username
      ? cleanUsername(listing.telegram_username)
      : null,
    extractUsernameFromLink(listing.telegram_link),
  ].filter(Boolean)

  const uniqueTargets = [...new Set(possibleTargets)]

  if (uniqueTargets.length === 0) {
    throw scrapeError || new Error(
      "No Telegram username, chat ID, or public link found"
    )
  }

  let chat = null
  let successfulTarget = null
  let lastError = scrapeError

  for (const target of uniqueTargets) {
    try {
      chat = await tg("getChat", {
        chat_id: target,
      })
      successfulTarget = target
      break
    } catch (err) {
      lastError = err
      console.warn("Telegram getChat fallback failed:", {
        listing_id: listing.id,
        channel_name: listing.channel_name,
        target,
        error: err.message,
      })

      if (err?.code === "TELEGRAM_RATE_LIMITED") {
        throw err
      }
    }
  }

  if (!chat) {
    throw new Error(
      lastError?.message ||
        "Telegram chat could not be found using any stored identifier."
    )
  }

  const memberCount = await tg("getChatMemberCount", {
    chat_id: chat.id,
  })
  const listingType = normalizeTelegramType(chat.type)

  if (!listingType) {
    throw new Error(
      `Could not detect whether this Telegram link is a group or channel. Telegram type: ${chat.type || "unknown"}`
    )
  }

  let iconUrl = listing.icon_url || null

  if (refreshIcon && chat.photo?.big_file_id) {
    try {
      iconUrl = await uploadTelegramPhoto(
        chat.photo.big_file_id,
        listing.id
      )
    } catch (photoErr) {
      console.warn("Telegram Bot API photo upload failed:", {
        listing_id: listing.id,
        error: photoErr.message,
      })
    }
  }

  const now = new Date().toISOString()
  const normalizedUsername = cleanUsername(chat.username)

  const { error: updateError } = await supabaseAdmin
    .from("channel_listings")
    .update({
      telegram_chat_id: String(chat.id),
      telegram_username: normalizedUsername,
      telegram_title: chat.title || null,
      telegram_description:
        chat.description ||
        chat.bio ||
        listing.telegram_description ||
        null,
      member_count: memberCount,
      icon_url: iconUrl,
      listing_type: listingType,
      last_synced_at: now,
      telegram_metadata_synced_at: now,
      last_member_scraped_at: now,
      last_metadata_scraped_at: now,
      ...(refreshIcon ? { last_icon_scraped_at: now } : {}),
      scrape_source: "telegram_bot_api_fallback",
      scrape_failure_count: 0,
      updated_at: now,
    })
    .eq("id", listing.id)

  if (updateError) throw updateError

  if (insertSnapshot) {
    const { error: snapshotError } = await supabaseAdmin
      .from("channel_member_snapshots")
      .insert({
        listing_id: listing.id,
        member_count: memberCount,
        created_at: now,
      })

    if (snapshotError) {
      console.warn("Member snapshot insert failed:", {
        listing_id: listing.id,
        error: snapshotError.message,
      })
    }
  }

  console.log("Telegram Bot API fallback succeeded:", {
    listing_id: listing.id,
    target: successfulTarget,
    member_count: memberCount,
    listing_type: listingType,
    source: "telegram_bot_api_fallback",
  })

  return {
    chat,
    memberCount,
    iconUrl,
    listingType,
    successfulTarget,
    source: "telegram_bot_api_fallback",
  }
}

const TELEGRAM_SYNC_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.TELEGRAM_SYNC_CONCURRENCY || 3), 12)
)

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function runWorker() {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return

      try {
        results[index] = {
          ok: true,
          value: await worker(items[index], index),
        }
      } catch (err) {
        results[index] = {
          ok: false,
          error: err.message || "Unknown sync error",
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, Math.max(items.length, 1)) },
      () => runWorker()
    )
  )

  return results
}


const TELEGRAM_METADATA_REFRESH_MS = Math.max(
  24 * 60 * 60 * 1000,
  Number(
    process.env.TELEGRAM_METADATA_REFRESH_MS ||
      7 * 24 * 60 * 60 * 1000
  )
)

const TELEGRAM_ICON_REFRESH_MS = Math.max(
  24 * 60 * 60 * 1000,
  Number(
    process.env.TELEGRAM_ICON_REFRESH_MS ||
      30 * 24 * 60 * 60 * 1000
  )
)

function isTelegramRefreshDue(lastRefreshAt, intervalMs) {
  if (!lastRefreshAt) return true

  const value = new Date(lastRefreshAt).getTime()
  if (!Number.isFinite(value)) return true

  return Date.now() - value >= intervalMs
}

function scheduledTelegramRefreshPlan(listing) {
  const metadataTimestamp =
    listing.last_metadata_scraped_at ||
    listing.telegram_metadata_synced_at ||
    null

  const iconTimestamp =
    listing.last_icon_scraped_at ||
    listing.telegram_metadata_synced_at ||
    null

  return {
    refreshMetadata: isTelegramRefreshDue(
      metadataTimestamp,
      TELEGRAM_METADATA_REFRESH_MS
    ),
    refreshIcon: isTelegramRefreshDue(
      iconTimestamp,
      TELEGRAM_ICON_REFRESH_MS
    ),
  }
}

// Lightweight scheduled member-count path:
// - Scrapes the public t.me page first.
// - Uses getChatMemberCount only as a fallback.
// - Does not refresh metadata or avatars.
// - Does not connect to Framer.
// - Inserts one member snapshot per scheduled run.
async function syncListingMemberCountFast(listing, options = {}) {
  const plan = {
    ...scheduledTelegramRefreshPlan(listing),
    ...options,
  }

  let memberCount = null
  let successfulTarget = null
  let source = null
  let scraped = null
  let botChat = null
  let scrapeError = null

  try {
    scraped = await fetchPublicTelegramPage(listing)

    console.log("Daily Telegram public-page scrape succeeded:", {
      listing_id: listing.id,
      username: scraped.telegramUsername,
      member_count: scraped.memberCount,
      listing_type: scraped.listingType,
      refresh_metadata: plan.refreshMetadata,
      refresh_icon: plan.refreshIcon,
      source: scraped.source,
      raw_display: scraped.rawDisplay,
    })

    memberCount = scraped.memberCount
    successfulTarget = scraped.telegramUsername
    source = scraped.source
  } catch (err) {
    scrapeError = err
    console.warn("Daily t.me scrape failed; trying Bot API fallback:", {
      listing_id: listing.id,
      channel_name: listing.channel_name,
      code: err.code,
      error: err.message,
    })
  }

  if (memberCount === null) {
    const possibleTargets = [
      listing.telegram_chat_id
        ? String(listing.telegram_chat_id).trim()
        : null,
      listing.telegram_username
        ? cleanUsername(listing.telegram_username)
        : null,
      extractUsernameFromLink(listing.telegram_link),
    ].filter(Boolean)

    const uniqueTargets = [...new Set(possibleTargets)]

    if (!uniqueTargets.length) {
      await recordTelegramScrapeFailure(listing, scrapeError)
      throw scrapeError || new Error(
        "No Telegram chat ID, username, or public link found"
      )
    }

    let lastError = scrapeError

    for (const target of uniqueTargets) {
      try {
        if (plan.refreshMetadata || plan.refreshIcon) {
          botChat = await tg("getChat", { chat_id: target })
          memberCount = await tg("getChatMemberCount", {
            chat_id: botChat.id,
          })
        } else {
          memberCount = await tg("getChatMemberCount", {
            chat_id: target,
          })
        }

        successfulTarget = target
        source = "telegram_bot_api_fallback"
        break
      } catch (err) {
        lastError = err

        if (err?.code === "TELEGRAM_RATE_LIMITED") {
          await recordTelegramScrapeFailure(listing, err)
          throw err
        }
      }
    }

    if (memberCount === null) {
      await recordTelegramScrapeFailure(listing, lastError)
      if (lastError) throw lastError
      throw new Error(
        "Telegram member count could not be loaded from t.me or the Bot API."
      )
    }
  }

  const now = new Date().toISOString()
  const updatePayload = {
    member_count: memberCount,
    last_synced_at: now,
    last_member_scraped_at: now,
    scrape_source: source,
    scrape_failure_count: 0,
  }

  let iconUrl = listing.icon_url || null

  if (plan.refreshMetadata) {
    if (scraped) {
      updatePayload.telegram_username = scraped.telegramUsername
      updatePayload.telegram_title =
        scraped.title || listing.telegram_title || listing.channel_name
      updatePayload.telegram_description =
        scraped.description ||
        listing.telegram_description ||
        null
      updatePayload.listing_type =
        scraped.listingType || listing.listing_type || null
    } else if (botChat) {
      updatePayload.telegram_chat_id = String(botChat.id)
      updatePayload.telegram_username = cleanUsername(botChat.username)
      updatePayload.telegram_title =
        botChat.title || listing.telegram_title || listing.channel_name
      updatePayload.telegram_description =
        botChat.description ||
        botChat.bio ||
        listing.telegram_description ||
        null
      updatePayload.listing_type =
        normalizeTelegramType(botChat.type) ||
        listing.listing_type ||
        null
    }

    updatePayload.telegram_metadata_synced_at = now
    updatePayload.last_metadata_scraped_at = now
  }

  if (plan.refreshIcon) {
    try {
      if (scraped?.iconUrl) {
        iconUrl = await uploadRemoteTelegramPhoto(
          scraped.iconUrl,
          listing.id
        )
      } else if (botChat?.photo?.big_file_id) {
        iconUrl = await uploadTelegramPhoto(
          botChat.photo.big_file_id,
          listing.id
        )
      }

      if (iconUrl) updatePayload.icon_url = iconUrl
      updatePayload.last_icon_scraped_at = now
    } catch (photoErr) {
      console.warn("Scheduled Telegram icon refresh failed:", {
        listing_id: listing.id,
        error: photoErr.message,
      })
    }
  }

  const { error: updateError } = await supabaseAdmin
    .from("channel_listings")
    .update(updatePayload)
    .eq("id", listing.id)

  if (updateError) throw updateError

  const { error: snapshotError } = await supabaseAdmin
    .from("channel_member_snapshots")
    .insert({
      listing_id: listing.id,
      member_count: memberCount,
      created_at: now,
    })

  if (snapshotError) {
    console.warn("Member snapshot insert failed:", {
      listing_id: listing.id,
      error: snapshotError.message,
    })
  }

  if (source === "telegram_bot_api_fallback") {
    console.log("Daily Telegram Bot API fallback succeeded:", {
      listing_id: listing.id,
      target: successfulTarget,
      member_count: memberCount,
      refresh_metadata: plan.refreshMetadata,
      refresh_icon: plan.refreshIcon,
      source,
    })
  }

  return {
    listingId: listing.id,
    memberCount,
    successfulTarget,
    source,
    metadataRefreshed: Boolean(plan.refreshMetadata),
    iconRefreshed: Boolean(plan.refreshIcon),
  }
}

const MEMBER_COUNT_STALE_MS = Math.max(
  60 * 1000,
  Number(process.env.MEMBER_COUNT_STALE_MS || 60 * 60 * 1000)
)

// Prevent simultaneous visitors from creating duplicate Telegram requests
// for the same listing while the first refresh is still running.
const memberRefreshLocks = new Map()

function isMemberCountStale(lastSyncedAt) {
  if (!lastSyncedAt) return true

  const syncedAtMs = new Date(lastSyncedAt).getTime()
  if (!Number.isFinite(syncedAtMs)) return true

  return Date.now() - syncedAtMs >= MEMBER_COUNT_STALE_MS
}

async function refreshListingMemberCountOnDemand(listing) {
  const existingLock = memberRefreshLocks.get(listing.id)
  if (existingLock) return existingLock

  const refreshPromise = (async () => {
    const result = await syncListingMemberCountFast(listing)

    return {
      listing_id: listing.id,
      member_count: result.memberCount,
      last_synced_at: new Date().toISOString(),
      refreshed: true,
      stale: false,
    }
  })()

  memberRefreshLocks.set(listing.id, refreshPromise)

  try {
    return await refreshPromise
  } finally {
    if (memberRefreshLocks.get(listing.id) === refreshPromise) {
      memberRefreshLocks.delete(listing.id)
    }
  }
}


// Legacy compatibility endpoint.
// It now returns cached Supabase data only and never calls Telegram.
app.post("/api/listings/refresh-member-count", async (req, res) => {
  try {
    const listingId = String(req.body?.listing_id || "").trim()

    if (!listingId) {
      return res.status(400).json({ error: "Missing listing_id." })
    }

    const { data: listing, error } = await supabaseAdmin
      .from("channel_listings")
      .select("id, member_count, last_synced_at, status, is_banned")
      .eq("id", listingId)
      .single()

    if (
      error ||
      !listing ||
      listing.status !== "approved" ||
      listing.is_banned
    ) {
      return res.status(404).json({ error: "Listing is unavailable." })
    }

    return res.json({
      ok: true,
      listing_id: listing.id,
      member_count: Number(listing.member_count || 0),
      last_synced_at: listing.last_synced_at,
      refreshed: false,
      cached: true,
    })
  } catch (err) {
    console.error("Cached member count route failed:", err)
    return res.status(500).json({
      error: err.message || "Could not load cached member count.",
    })
  }
})

function isPermanentTelegramListingFailure(errorMessage) {
  const message = String(errorMessage || "").toLowerCase()

  return [
    "chat not found",
    "user not found",
    "username not occupied",
    "chat_id is empty",
    "not enough rights",
    "bot was blocked",
    "kicked from",
  ].some((needle) => message.includes(needle))
}

async function removeBrokenListingFromPublic(listing, errorMessage) {
  const now = new Date().toISOString()

  const { error: statusError } = await supabaseAdmin
    .from("channel_listings")
    .update({
      status: "needs_update",
      admin_reviewed: false,
      framer_sync_status: "removed",
      framer_sync_error: String(errorMessage || "Telegram invite is no longer valid."),
      updated_at: now,
    })
    .eq("id", listing.id)

  if (statusError) throw statusError

  let framerResult = null

  try {
    framerResult = await deleteListingFromFramerCMS(listing, {
      publish: false,
    })
  } catch (framerError) {
    await supabaseAdmin
      .from("channel_listings")
      .update({
        framer_sync_status: "failed",
        framer_sync_error: `Telegram invite failed: ${errorMessage}. Framer removal failed: ${framerError.message}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listing.id)

    throw framerError
  }

  return {
    listing_id: listing.id,
    framer: framerResult,
  }
}

async function runHourlyTelegramSync(options = {}) {
  const startedAt = Date.now()

  const { data: listings, error } = await supabaseAdmin
    .from("channel_listings")
    .select(
      "id, telegram_chat_id, telegram_username, telegram_link, telegram_title, telegram_description, listing_type, member_count, icon_url, short_invite, slug, framer_cms_item_id, telegram_metadata_synced_at, last_member_scraped_at, last_metadata_scraped_at, last_icon_scraped_at, scrape_source, scrape_failure_count"
    )
    .eq("status", "approved")
    .or("is_banned.is.null,is_banned.eq.false")

  if (error) throw error

  const workerResults = await runWithConcurrency(
    listings || [],
    TELEGRAM_SYNC_CONCURRENCY,
    (listing) => syncListingMemberCountFast(listing)
  )

  const results = workerResults.map((result, index) => {
    const listing = listings[index]

    if (result.ok) {
      return {
        id: listing.id,
        ok: true,
        member_count: result.value.memberCount,
        source: result.value.source,
        metadata_refreshed: result.value.metadataRefreshed,
        icon_refreshed: result.value.iconRefreshed,
      }
    }

    return {
      id: listing.id,
      ok: false,
      error: result.error,
      permanent_failure: isPermanentTelegramListingFailure(result.error),
    }
  })

  const removedListings = []
  const removalFailures = []
  let anyCmsItemRemoved = false

  // Handle permanent failures only after the Telegram scan completes.
  // This keeps temporary network errors and rate limits from hiding listings.
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const listing = listings[index]

    if (result.ok || !result.permanent_failure) continue

    try {
      const removal = await queueFramerSync(() =>
        removeBrokenListingFromPublic(listing, result.error)
      )

      const deleted = removal?.framer?.deleted === true
      if (deleted) anyCmsItemRemoved = true

      result.removed_from_public = true
      result.framer_cms_deleted = deleted
      removedListings.push({
        id: listing.id,
        error: result.error,
        framer_cms_deleted: deleted,
      })
    } catch (removeError) {
      result.removed_from_public = false
      result.removal_error = removeError.message

      removalFailures.push({
        id: listing.id,
        error: result.error,
        removal_error: removeError.message,
      })
    }
  }

  let framerDeployed = false

  // deleteListingFromFramerCMS was called with publish:false for each item.
  // Publish and deploy once after every broken CMS item has been removed.
  if (
    anyCmsItemRemoved &&
    options.publish !== false &&
    process.env.FRAMER_AUTO_DEPLOY !== "false"
  ) {
    const { connect } = await import("framer-api")
    const framer = await connect(
      process.env.FRAMER_PROJECT_URL,
      process.env.FRAMER_API_KEY
    )

    try {
      const publication = await framer.publish()
      await framer.deploy(publication.deployment.id)
      framerDeployed = true
    } finally {
      await framer.disconnect()
    }
  }

  let homepageCache = null

  try {
    homepageCache = await updateHomepageListingCache()
  } catch (cacheErr) {
    console.error("Homepage cache refresh after hourly sync failed:", cacheErr)
  }

  return {
    ok: true,
    count: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    permanently_invalid: results.filter(
      (item) => !item.ok && item.permanent_failure
    ).length,
    removed_from_public: removedListings.length,
    removal_failed: removalFailures.length,
    framer_deployed: framerDeployed,
    concurrency: TELEGRAM_SYNC_CONCURRENCY,
    metadata_refreshed: results.filter(
      (item) => item.ok && item.metadata_refreshed
    ).length,
    icons_refreshed: results.filter(
      (item) => item.ok && item.icon_refreshed
    ).length,
    duration_ms: Date.now() - startedAt,
    results,
    removed_listings: removedListings,
    removal_failures: removalFailures,
    homepage_cache: homepageCache
      ? {
          updated_at: homepageCache.updated_at,
          count: homepageCache.listings.length,
        }
      : null,
  }
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


// Authenticated voting endpoint used by the Framer listing page.
// Normal users may cast one vote across TeleHub every 24 hours.
// Admins may vote without the 24-hour restriction.
app.post("/api/listings/vote", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "")
    const token = authHeader.replace(/^Bearer\s+/i, "").trim()
    const listingId = String(req.body?.listing_id || "").trim()

    if (!token) {
      return res.status(401).json({ error: "You must be logged in to vote." })
    }

    if (!listingId) {
      return res.status(400).json({ error: "Missing listing_id." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: "Your login session is invalid." })
    }

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select(
        "id, slug, short_invite, channel_name, telegram_title, description, telegram_description, telegram_link, icon_url, image_url, member_count, votes_count, categories, status, is_banned"
      )
      .eq("id", listingId)
      .single()

    if (
      listingError ||
      !listing ||
      listing.status !== "approved" ||
      listing.is_banned
    ) {
      return res.status(404).json({ error: "Listing not found or unavailable." })
    }

    const email = String(user.email || "").toLowerCase()
    const isAdmin = ADMIN_EMAILS.includes(email)

    if (!isAdmin) {
      const cutoff = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString()

      const { data: recentVote, error: recentVoteError } = await supabaseAdmin
        .from("channel_votes")
        .select("id, created_at")
        .eq("user_id", user.id)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (recentVoteError) throw recentVoteError

      if (recentVote) {
        const nextVoteAt = new Date(
          new Date(recentVote.created_at).getTime() +
            24 * 60 * 60 * 1000
        ).toISOString()

        return res.status(429).json({
          error: "You can vote again after 24 hours.",
          code: "VOTE_COOLDOWN",
          next_vote_at: nextVoteAt,
        })
      }
    }

    const { error: insertError } = await supabaseAdmin
      .from("channel_votes")
      .insert({
        user_id: user.id,
        listing_id: listing.id,
      })

    if (insertError) {
      if (insertError.code === "23505") {
        return res.status(409).json({
          error: "This vote was already recorded.",
          code: "DUPLICATE_VOTE",
        })
      }

      throw insertError
    }

    // Count the source-of-truth vote rows after insertion, then mirror that
    // total onto channel_listings for fast directory/ranking reads.
    const { count: voteCount, error: countError } = await supabaseAdmin
      .from("channel_votes")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listing.id)

    if (countError) throw countError

    const newVoteCount = Number(voteCount || 0)

    const { error: listingUpdateError } = await supabaseAdmin
      .from("channel_listings")
      .update({
        votes_count: newVoteCount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listing.id)

    if (listingUpdateError) throw listingUpdateError

    // Keep ranking/homepage data current, but do not block a successful vote
    // if the cache refresh has a separate problem.
    updateHomepageListingCache().catch((cacheError) => {
      console.error("Homepage cache refresh after vote failed:", cacheError)
    })

    // Send the Discord notification directly from the backend. This is
    // best-effort and never makes a valid vote fail.
    const webhookUrl = process.env.DISCORD_VOTE_WEBHOOK_URL

    if (webhookUrl) {
      const listingUrl = listing.short_invite
        ? `https://telehub.to/channel/${encodeURIComponent(listing.short_invite)}`
        : `https://telehub.to/channel?slug=${encodeURIComponent(
            listing.slug || listing.id
          )}`

      const discordPayload = {
        username: "TeleHub",
        content: `🔥 **${
          listing.telegram_title ||
          listing.channel_name ||
          "A Telegram channel"
        }** was just voted on TeleHub!`,
        embeds: [
          {
            title:
              listing.telegram_title ||
              listing.channel_name ||
              "Telegram Channel",
            url: listingUrl,
            description: String(
              listing.telegram_description ||
              listing.description ||
              "A Telegram community was recently voted on TeleHub."
            ).slice(0, 250),
            color: 2260697,
            image: listing.image_url
              ? { url: listing.image_url }
              : undefined,
            fields: [
              {
                name: "Votes",
                value: String(newVoteCount),
                inline: true,
              },
              {
                name: "Members",
                value: listing.member_count
                  ? Number(listing.member_count).toLocaleString()
                  : "Updating",
                inline: true,
              },
              {
                name: "Categories",
                value:
                  Array.isArray(listing.categories) &&
                  listing.categories.length
                    ? listing.categories.slice(0, 5).join(", ")
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
                url: listingUrl,
              },
              {
                type: 2,
                style: 5,
                label: "Join Telegram",
                url: listing.telegram_link,
              },
            ],
          },
        ],
      }

      fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(discordPayload),
      }).catch((discordError) => {
        console.error("Discord vote notification failed:", discordError)
      })
    }

    return res.json({
      ok: true,
      listing_id: listing.id,
      votes_count: newVoteCount,
      is_admin: isAdmin,
      message: isAdmin ? "Admin vote added." : "Vote added.",
    })
  } catch (err) {
    console.error("Vote route error:", err)
    return res.status(500).json({
      error: err.message || "Vote failed.",
    })
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
const sharp = require("sharp")

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


// ========================================
// FRAMER CMS SYNC v8 - clean URLs, CMS images, and CMS deletion
// ========================================

const FRAMER_COLLECTION_NAME = process.env.FRAMER_COLLECTION_NAME || "Channel Listings"
let framerSyncChain = Promise.resolve()

function queueFramerSync(work) {
  const next = framerSyncChain.then(work, work)
  framerSyncChain = next.catch(() => {})
  return next
}


const FRAMER_CONTENT_FIELDS = new Set([
  "channel_name",
  "telegram_title",
  "description",
  "long_description",
  "telegram_description",
  "categories",
  "image_url",
  "icon_url",
  "telegram_username",
  "telegram_link",
  "listing_type",
  "is_nsfw",
  "paid_rank",
  "paid_rank_status",
  "status",
])

function shouldSyncFramerForChangedFields(changedFields) {
  return (changedFields || []).some((field) =>
    FRAMER_CONTENT_FIELDS.has(String(field || "").trim())
  )
}

function cleanCmsSlug(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function stripTelegramHandle(linkOrUsername) {
  if (!linkOrUsername) return ""
  return String(linkOrUsername)
    .replace("https://t.me/", "")
    .replace("http://t.me/", "")
    .replace("t.me/", "")
    .replace("@", "")
    .split("?")[0]
    .split("/")[0]
    .trim()
}

function boolValue(value) {
  return value === true || String(value).toLowerCase() === "true"
}

function compactCmsString(value, fallback = "") {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function getFieldByName(fields, name) {
  const target = String(name || "").trim().toLowerCase()
  return fields.find((field) => String(field.name || "").trim().toLowerCase() === target)
}

function addCmsField(fieldData, fields, fieldName, value) {
  const field = getFieldByName(fields, fieldName)
  if (!field) return
  if (value === undefined || value === null) return

  const fieldType = field.type || "string"
  if (fieldType === "unsupported") return

  // Image fields must be handled by addCmsImageField so the typed CMS value is correct.
  if (fieldType === "image") return

  let finalValue = value

  if (fieldType === "number") {
    finalValue = Number(value || 0)
    if (!Number.isFinite(finalValue)) finalValue = 0
  } else if (fieldType === "boolean") {
    finalValue = boolValue(value)
  } else if (fieldType === "date") {
    try {
      finalValue = value ? new Date(value).toISOString() : undefined
      if (!finalValue || finalValue === "Invalid Date") return
    } catch {
      return
    }
  } else {
    finalValue = compactCmsString(value)
  }

  fieldData[field.id] = {
    type: fieldType,
    value: finalValue,
  }
}

async function addCmsImageField(fieldData, fields, framer, fieldName, imageUrl, altText, options = {}) {
  const required = options.required === true
  const field = getFieldByName(fields, fieldName)

  if (!field) {
    const message = `Framer image field not found: ${fieldName}`
    console.warn(message)
    return { ok: false, skipped: !required, error: message }
  }

  if (!imageUrl) {
    const message = `No image URL provided for ${fieldName}`

    // Optional fields like Background Image can be blank without failing the sync.
    if (required) console.warn(message)

    // Clear image fields when there is no optional image instead of leaving stale data.
    if (field.type === "image" && !required) {
      fieldData[field.id] = {
        type: "image",
        value: null,
      }
    }

    return { ok: false, skipped: !required, error: message }
  }

  const cleanImageUrl = String(imageUrl).trim()

  if (!/^https?:\/\//i.test(cleanImageUrl)) {
    const message = `Invalid image URL for ${fieldName}: ${cleanImageUrl}`
    console.warn(message)
    return { ok: false, skipped: !required, error: message }
  }

  // If this CMS field is URL/text instead of Image, save the URL normally.
  if (field.type !== "image") {
    addCmsField(fieldData, fields, fieldName, cleanImageUrl)
    return {
      ok: true,
      warning: `${fieldName} is ${field.type}, so the image URL was saved as text/URL.`,
      value: cleanImageUrl,
    }
  }

  try {
    // Framer CMS image fields currently expect the typed value to be null or a string.
    // Sending the full ImageAsset object causes the typia "expect null | string" error.
    // The Supabase Storage URL is public, so pass the public URL string directly.
    fieldData[field.id] = {
      type: "image",
      value: cleanImageUrl,
    }

    console.log(`Prepared Framer image field ${fieldName}:`, cleanImageUrl)

    return { ok: true, value: cleanImageUrl }
  } catch (err) {
    const message = `Could not prepare Framer image for ${fieldName}: ${err.message}`
    console.error(message, err)
    return { ok: false, skipped: !required, error: message }
  }
}

function buildCmsText(listing) {
  const name =
    listing.channel_name ||
    listing.telegram_title ||
    "Telegram Listing"

  const listingType = String(
    listing.listing_type || "channel"
  ).toLowerCase()

  const typeTitle =
    listingType.charAt(0).toUpperCase() + listingType.slice(1)

  const categories = Array.isArray(listing.categories)
    ? listing.categories.filter(Boolean).join(", ")
    : compactCmsString(listing.categories, "General")

  const description =
    listing.long_description ||
    listing.telegram_description ||
    listing.description ||
    `${name} is a Telegram ${listingType} listed on TeleHub.`

  const shortDescription =
    listing.description ||
    listing.telegram_description ||
    `View ${name} on TeleHub.`

  const memberCount = Number(listing.member_count || 0)

  return {
    name,
    listingType,
    typeTitle,
    categories,
    description,
    shortDescription,
    memberCount,
    seoTitle: `${name} Telegram ${typeTitle}`,
    seoDescription: `View ${name} on TeleHub, including its Telegram link, description, category, member count, and listing details.`,
    introText: `${name} is a Telegram ${listingType} listed on TeleHub. View its description, category, member count, and Telegram join link.`,
    safetyNote:
      "TeleHub helps users discover Telegram communities, but users should review each community before joining. Report misleading, unsafe, or inappropriate listings.",
    faq1Question: `How do I join ${name}?`,
    faq1Answer: `Click the join button to open ${name} on Telegram.`,
    faq2Question: `Is ${name} NSFW?`,
    faq2Answer: boolValue(listing.is_nsfw)
      ? `Yes, ${name} is marked as NSFW. This means it may contain adult, mature, or sensitive content.`
      : `No, ${name} is not marked as NSFW. Users should still review the community before joining.`,
    faq3Question: `What category is ${name} in?`,
    faq3Answer: `${name} is listed under ${
      categories || "General"
    } on TeleHub.`,
  }
}
async function ensureUniqueShortInvite(listing) {
  const displayName = listing.telegram_title || listing.channel_name || "telegram-listing"
  let base = cleanCmsSlug(listing.short_invite || displayName)

  if (!base) {
    base = `telegram-listing-${String(listing.id || Date.now()).replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
  }

  let candidate = base
  let counter = 2

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("channel_listings")
      .select("id")
      .eq("short_invite", candidate)
      .neq("id", listing.id)
      .maybeSingle()

    if (error) throw error
    if (!data) break

    candidate = `${base}-${counter}`
    counter += 1
  }

  if (candidate !== listing.short_invite) {
    const { error } = await supabaseAdmin
      .from("channel_listings")
      .update({
        short_invite: candidate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listing.id)

    if (error) throw error
  }

  return candidate
}

async function getFramerCollection(framer) {
  const collections = await framer.getCollections()
  const collection = collections.find(
    (item) => String(item.name || "").trim().toLowerCase() === FRAMER_COLLECTION_NAME.toLowerCase()
  )

  if (!collection) {
    throw new Error(`Framer CMS collection not found: ${FRAMER_COLLECTION_NAME}`)
  }

  return collection
}



async function buildFullFramerFieldData(listing, fields, framer) {
  const cmsSlug = cleanCmsSlug(
    listing.short_invite ||
      listing.slug ||
      listing.telegram_title ||
      listing.channel_name ||
      listing.id
  )

  const cms = buildCmsText({ ...listing, short_invite: cmsSlug })
  const telegramUsername =
    listing.telegram_username ||
    (stripTelegramHandle(listing.telegram_link)
      ? `@${stripTelegramHandle(listing.telegram_link)}`
      : "")

  const telegramIconUrl = String(listing.icon_url || "").trim()
  const uploadedBackgroundUrl = String(listing.image_url || "").trim()
  const fieldData = {}

  addCmsField(fieldData, fields, "Name", cms.name)
  addCmsField(fieldData, fields, "Supabase Listing ID", String(listing.id))
  addCmsField(fieldData, fields, "Original App Slug", listing.slug || "")
  addCmsField(fieldData, fields, "Description", cms.description)
  addCmsField(fieldData, fields, "Short Description", cms.shortDescription)
  addCmsField(fieldData, fields, "Telegram URL", listing.telegram_link || "")
  addCmsField(fieldData, fields, "Telegram Username", telegramUsername)
  addCmsField(fieldData, fields, "Listing Type", cms.listingType)
  addCmsField(fieldData, fields, "Category", cms.categories || "General")

  const iconImageResult = await addCmsImageField(
    fieldData,
    fields,
    framer,
    "Icon Image",
    telegramIconUrl,
    `${cms.name} Telegram icon`,
    { required: true }
  )

  const backgroundImageResult = await addCmsImageField(
    fieldData,
    fields,
    framer,
    "Background Image URL",
    uploadedBackgroundUrl,
    `${cms.name} background image`,
    { required: false }
  )

  addCmsField(fieldData, fields, "Icon Image URL", telegramIconUrl)
  addCmsField(fieldData, fields, "Telegram Icon URL", telegramIconUrl)
  addCmsField(fieldData, fields, "Icon URL", telegramIconUrl)
  addCmsField(
    fieldData,
    fields,
    "Background Image URL Text",
    uploadedBackgroundUrl
  )

  addCmsField(fieldData, fields, "Member Count", cms.memberCount)
  addCmsField(
    fieldData,
    fields,
    "Votes Count",
    Number(listing.votes_count || 0)
  )
  addCmsField(fieldData, fields, "Paid Rank", listing.paid_rank || "free")
  addCmsField(fieldData, fields, "Status", listing.status || "approved")
  addCmsField(fieldData, fields, "Is NSFW", boolValue(listing.is_nsfw))
  addCmsField(fieldData, fields, "Short Invite", cmsSlug)
  addCmsField(
    fieldData,
    fields,
    "Created At",
    listing.created_at || new Date().toISOString()
  )
  addCmsField(
    fieldData,
    fields,
    "Last Synced At",
    listing.last_synced_at || new Date().toISOString()
  )
  addCmsField(fieldData, fields, "SEO Title", cms.seoTitle)
  addCmsField(fieldData, fields, "SEO Description", cms.seoDescription)
  addCmsField(fieldData, fields, "Intro Text", cms.introText)
  addCmsField(fieldData, fields, "Safety Note", cms.safetyNote)
  addCmsField(fieldData, fields, "FAQ 1 Question", cms.faq1Question)
  addCmsField(fieldData, fields, "FAQ 1 Answer", cms.faq1Answer)
  addCmsField(fieldData, fields, "FAQ 2 Question", cms.faq2Question)
  addCmsField(fieldData, fields, "FAQ 2 Answer", cms.faq2Answer)
  addCmsField(fieldData, fields, "FAQ 3 Question", cms.faq3Question)
  addCmsField(fieldData, fields, "FAQ 3 Answer", cms.faq3Answer)

  const warnings = []

  if (!iconImageResult.ok) {
    warnings.push(`Icon Image warning: ${iconImageResult.error}`)
  }

  if (!backgroundImageResult.ok && !backgroundImageResult.skipped) {
    warnings.push(
      `Background Image warning: ${backgroundImageResult.error}`
    )
  }

  return {
    cmsSlug,
    fieldData,
    warnings,
  }
}

// Performs the entire scheduled Framer update through one connection:
// - due listings receive a complete CMS payload
// - all other listings receive member count + last synced only
// - every item is sent at most once
// - payloads are uploaded as arrays in configurable batches
// - Framer publishes and deploys once at the end
async function syncScheduledListingsToFramerCMS(
  listings,
  fullSyncListingIds,
  options = {}
) {
  if (!process.env.FRAMER_API_KEY || !process.env.FRAMER_PROJECT_URL) {
    throw new Error(
      "Missing FRAMER_API_KEY or FRAMER_PROJECT_URL in Render environment variables."
    )
  }

  const approvedListings = (listings || []).filter(
    (listing) =>
      listing &&
      listing.status === "approved" &&
      !listing.is_banned &&
      (listing.framer_cms_item_id || listing.short_invite)
  )

  if (!approvedListings.length) {
    return {
      ok: true,
      updated: 0,
      full_updated: 0,
      member_only_updated: 0,
      image_skipped: 0,
      skipped: 0,
      failed: 0,
      deployed: false,
      batches: 0,
      results: [],
    }
  }

  const fullIdSet = new Set(
    [...(fullSyncListingIds || [])].map((value) => String(value))
  )

  const { connect } = await import("framer-api")
  const framer = await connect(
    process.env.FRAMER_PROJECT_URL,
    process.env.FRAMER_API_KEY
  )

  try {
    const collection = await getFramerCollection(framer)
    const fields = await collection.getFields()
    const existingItems = await collection.getItems()
    const existingById = new Map(existingItems.map((item) => [item.id, item]))
    const existingBySlug = new Map(
      existingItems.map((item) => [item.slug, item])
    )
    const imageFieldIds = new Set(
      fields
        .filter((field) => field.type === "image")
        .map((field) => field.id)
    )

    console.log("Bulk scheduled Framer sync started:", {
      listings: approvedListings.length,
      full_sync_listings: fullIdSet.size,
      cms_items: existingItems.length,
    })

    const entries = []
    const results = []

    for (const listing of approvedListings) {
      const isFullSync = fullIdSet.has(String(listing.id))
      const existingItem =
        (listing.framer_cms_item_id
          ? existingById.get(listing.framer_cms_item_id)
          : null) ||
        (listing.short_invite
          ? existingBySlug.get(cleanCmsSlug(listing.short_invite))
          : null)

      if (!existingItem?.id) {
        results.push({
          id: listing.id,
          ok: false,
          skipped: true,
          full_sync: isFullSync,
          error: "Framer CMS item not found.",
        })
        continue
      }

      try {
        let fieldData
        let warnings = []
        let cmsSlug = existingItem.slug

        if (isFullSync) {
          const fullPayload = await buildFullFramerFieldData(
            listing,
            fields,
            framer
          )
          fieldData = fullPayload.fieldData
          warnings = fullPayload.warnings
          cmsSlug = existingItem.slug || fullPayload.cmsSlug
        } else {
          fieldData = {}
          addCmsField(
            fieldData,
            fields,
            "Member Count",
            Number(listing.member_count || 0)
          )
          addCmsField(
            fieldData,
            fields,
            "Last Synced At",
            listing.last_synced_at || new Date().toISOString()
          )
        }

        const result = {
          id: listing.id,
          ok: null,
          full_sync: isFullSync,
          cms_item_id: existingItem.id,
          warnings,
          image_skipped: false,
        }

        results.push(result)
        entries.push({
          listing,
          result,
          payload: {
            id: existingItem.id,
            slug: cmsSlug,
            fieldData,
          },
        })
      } catch (err) {
        results.push({
          id: listing.id,
          ok: false,
          full_sync: isFullSync,
          error: err.message,
        })
      }
    }

    const chunkSize = Math.max(
      1,
      Math.min(
        Number(process.env.FRAMER_SCHEDULED_SYNC_BATCH_SIZE || 100),
        250
      )
    )

    let batches = 0
    let uploadedCount = 0

    async function uploadEntriesResilient(batchEntries, depth = 0) {
      if (!batchEntries.length) return

      batches += 1

      try {
        await collection.addItems(
          batchEntries.map((entry) => entry.payload)
        )

        for (const entry of batchEntries) {
          entry.result.ok = true
          uploadedCount += 1
        }

        console.log("Bulk scheduled Framer batch uploaded:", {
          batch: batches,
          batch_size: batchEntries.length,
          uploaded_so_far: uploadedCount,
          total: entries.length,
          split_depth: depth,
        })

        return
      } catch (err) {
        console.warn("Bulk Framer batch failed; isolating item:", {
          batch_size: batchEntries.length,
          split_depth: depth,
          error: err.message,
        })

        if (batchEntries.length > 1) {
          const midpoint = Math.ceil(batchEntries.length / 2)

          await uploadEntriesResilient(
            batchEntries.slice(0, midpoint),
            depth + 1
          )
          await uploadEntriesResilient(
            batchEntries.slice(midpoint),
            depth + 1
          )
          return
        }

        const entry = batchEntries[0]
        const originalFieldData = entry.payload.fieldData || {}
        const fieldDataWithoutImages = {}

        for (const [fieldId, value] of Object.entries(originalFieldData)) {
          if (!imageFieldIds.has(fieldId)) {
            fieldDataWithoutImages[fieldId] = value
          }
        }

        const removedImageFieldCount =
          Object.keys(originalFieldData).length -
          Object.keys(fieldDataWithoutImages).length

        if (removedImageFieldCount > 0) {
          try {
            batches += 1

            await collection.addItems([
              {
                ...entry.payload,
                fieldData: fieldDataWithoutImages,
              },
            ])

            entry.result.ok = true
            entry.result.image_skipped = true
            entry.result.warnings = [
              ...(entry.result.warnings || []),
              `Framer could not decode one of this listing's images, so existing CMS images were preserved. Original error: ${err.message}`,
            ]
            uploadedCount += 1

            console.warn(
              "Framer listing uploaded without image fields:",
              {
                listing_id: entry.listing.id,
                cms_item_id: entry.payload.id,
                removed_image_fields: removedImageFieldCount,
              }
            )
            return
          } catch (retryErr) {
            entry.result.ok = false
            entry.result.error =
              `Full payload failed: ${err.message}. ` +
              `Retry without images also failed: ${retryErr.message}`
            return
          }
        }

        entry.result.ok = false
        entry.result.error = err.message
      }
    }

    for (let index = 0; index < entries.length; index += chunkSize) {
      await uploadEntriesResilient(
        entries.slice(index, index + chunkSize)
      )
    }

    let deployed = false

    if (
      uploadedCount > 0 &&
      options.publish !== false &&
      process.env.FRAMER_AUTO_DEPLOY !== "false"
    ) {
      const publication = await framer.publish()
      await framer.deploy(publication.deployment.id)
      deployed = true
    }

    const now = new Date().toISOString()
    const successfulFullSyncs = results.filter(
      (item) => item.full_sync && item.ok === true
    )
    const failedFullSyncs = results.filter(
      (item) => item.full_sync && item.ok === false
    )

    for (const result of successfulFullSyncs) {
      const warningText =
        Array.isArray(result.warnings) && result.warnings.length
          ? result.warnings.join(" | ")
          : null

      const { error } = await supabaseAdmin
        .from("channel_listings")
        .update({
          framer_sync_status: "synced",
          framer_synced_at: now,
          framer_sync_error: warningText,
          updated_at: now,
        })
        .eq("id", result.id)

      if (error) {
        console.warn("Could not save successful bulk Framer status:", {
          listing_id: result.id,
          error: error.message,
        })
      }
    }

    for (const result of failedFullSyncs) {
      const { error } = await supabaseAdmin
        .from("channel_listings")
        .update({
          framer_sync_status: "failed",
          framer_sync_error: result.error,
          updated_at: now,
        })
        .eq("id", result.id)

      if (error) {
        console.warn("Could not save failed bulk Framer status:", {
          listing_id: result.id,
          error: error.message,
        })
      }
    }

    return {
      ok: results.every(
        (item) => item.ok === true || item.skipped === true
      ),
      updated: results.filter((item) => item.ok === true).length,
      full_updated: successfulFullSyncs.length,
      member_only_updated: results.filter(
        (item) => !item.full_sync && item.ok === true
      ).length,
      image_skipped: results.filter(
        (item) => item.image_skipped === true
      ).length,
      skipped: results.filter((item) => item.skipped).length,
      failed: results.filter((item) => item.ok === false).length,
      deployed,
      batches,
      batch_size: chunkSize,
      results,
    }
  } finally {
    await framer.disconnect()
  }
}

async function syncMemberCountsToFramerCMS(listings, options = {}) {
  if (!process.env.FRAMER_API_KEY || !process.env.FRAMER_PROJECT_URL) {
    throw new Error(
      "Missing FRAMER_API_KEY or FRAMER_PROJECT_URL in Render environment variables."
    )
  }

  const approvedListings = (listings || []).filter(
    (listing) =>
      listing &&
      listing.status === "approved" &&
      !listing.is_banned &&
      (listing.framer_cms_item_id || listing.short_invite)
  )

  if (!approvedListings.length) {
    return {
      ok: true,
      updated: 0,
      skipped: 0,
      deployed: false,
      results: [],
    }
  }

  const { connect } = await import("framer-api")
  const framer = await connect(
    process.env.FRAMER_PROJECT_URL,
    process.env.FRAMER_API_KEY
  )

  try {
    const collection = await getFramerCollection(framer)
    const fields = await collection.getFields()
    const existingItems = await collection.getItems()
    const existingById = new Map(existingItems.map((item) => [item.id, item]))
    const existingBySlug = new Map(existingItems.map((item) => [item.slug, item]))

    const results = []
    const payloads = []

    for (const listing of approvedListings) {
      const existingItem =
        (listing.framer_cms_item_id
          ? existingById.get(listing.framer_cms_item_id)
          : null) ||
        (listing.short_invite
          ? existingBySlug.get(cleanCmsSlug(listing.short_invite))
          : null)

      if (!existingItem?.id) {
        results.push({
          id: listing.id,
          ok: false,
          skipped: true,
          error: "Framer CMS item not found.",
        })
        continue
      }

      const fieldData = {}
      addCmsField(
        fieldData,
        fields,
        "Member Count",
        Number(listing.member_count || 0)
      )
      addCmsField(
        fieldData,
        fields,
        "Last Synced At",
        listing.last_synced_at || new Date().toISOString()
      )

      payloads.push({
        id: existingItem.id,
        slug: existingItem.slug,
        fieldData,
      })
      results.push({
        id: listing.id,
        ok: true,
        cms_item_id: existingItem.id,
      })
    }

    const chunkSize = Math.max(
      1,
      Math.min(Number(process.env.FRAMER_MEMBER_SYNC_BATCH_SIZE || 100), 250)
    )

    for (let index = 0; index < payloads.length; index += chunkSize) {
      await collection.addItems(payloads.slice(index, index + chunkSize))
    }

    let deployed = false

    if (
      payloads.length &&
      options.publish !== false &&
      process.env.FRAMER_AUTO_DEPLOY !== "false"
    ) {
      const publication = await framer.publish()
      await framer.deploy(publication.deployment.id)
      deployed = true
    }

    return {
      ok: true,
      updated: payloads.length,
      skipped: results.filter((item) => item.skipped).length,
      deployed,
      results,
    }
  } finally {
    await framer.disconnect()
  }
}

async function syncListingToFramerCMS(listingId, options = {}) {
  if (!process.env.FRAMER_API_KEY || !process.env.FRAMER_PROJECT_URL) {
    throw new Error("Missing FRAMER_API_KEY or FRAMER_PROJECT_URL in Render environment variables.")
  }

  const { data: existingListing, error: listingError } = await supabaseAdmin
    .from("channel_listings")
    .select("*")
    .eq("id", listingId)
    .single()

  if (listingError) throw listingError
  if (!existingListing) throw new Error("Listing not found.")
  if (existingListing.status !== "approved") {
    throw new Error("Only approved listings can be synced to Framer CMS.")
  }
  if (existingListing.is_banned) {
    throw new Error("Banned listings cannot be synced to Framer CMS.")
  }

  await supabaseAdmin
    .from("channel_listings")
    .update({
      framer_sync_status: "syncing",
      framer_sync_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId)

  let telegramSyncWarning = null

  if (options.skipTelegramSync !== true) {
    try {
      await syncListingTelegramData(existingListing)
    } catch (err) {
      telegramSyncWarning = err.message
      console.warn("Telegram sync before Framer CMS sync failed:", err.message)
    }
  }

  const { data: listing, error: freshError } = await supabaseAdmin
    .from("channel_listings")
    .select("*")
    .eq("id", listingId)
    .single()

  if (freshError) throw freshError

  const cmsSlug = await ensureUniqueShortInvite(listing)
  const cms = buildCmsText({ ...listing, short_invite: cmsSlug })
  const telegramUsername =
    listing.telegram_username ||
    (stripTelegramHandle(listing.telegram_link)
      ? `@${stripTelegramHandle(listing.telegram_link)}`
      : "")
  // Telegram icon is the actual channel/group avatar pulled from Telegram.
  // Uploaded user image remains separate as the optional background/banner image.
  const telegramIconUrl = String(listing.icon_url || "").trim()
  const uploadedBackgroundUrl = String(listing.image_url || "").trim()

  const { connect } = await import("framer-api")
  const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY)

  try {
    const collection = await getFramerCollection(framer)
    const fields = await collection.getFields()

    console.log(
      "FRAMER CMS FIELDS:",
      fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
      }))
    )
    console.log("TELEGRAM ICON URL FOR CMS:", telegramIconUrl)
    console.log("BACKGROUND IMAGE URL FOR CMS:", uploadedBackgroundUrl)

    const fieldData = {}

    addCmsField(fieldData, fields, "Name", cms.name)
    addCmsField(fieldData, fields, "Supabase Listing ID", String(listing.id))
    addCmsField(fieldData, fields, "Original App Slug", listing.slug || "")
    addCmsField(fieldData, fields, "Description", cms.description)
    addCmsField(fieldData, fields, "Short Description", cms.shortDescription)
    addCmsField(fieldData, fields, "Telegram URL", listing.telegram_link || "")
    addCmsField(fieldData, fields, "Telegram Username", telegramUsername)
    addCmsField(fieldData, fields, "Listing Type", cms.listingType)
    addCmsField(fieldData, fields, "Category", cms.categories || "General")

    // IMPORTANT:
    // Icon Image = Telegram channel/group avatar from listing.icon_url.
    // Background Image URL = optional user-uploaded background/banner from listing.image_url.
    // Both can be Framer Image fields. For Image fields, we pass the public image URL string.
    const iconImageResult = await addCmsImageField(
      fieldData,
      fields,
      framer,
      "Icon Image",
      telegramIconUrl,
      `${cms.name} Telegram icon`,
      { required: true }
    )

    const backgroundImageResult = await addCmsImageField(
      fieldData,
      fields,
      framer,
      "Background Image URL",
      uploadedBackgroundUrl,
      `${cms.name} background image`,
      { required: false }
    )

    // Extra URL/text fallbacks if those fields exist in your CMS.
    addCmsField(fieldData, fields, "Icon Image URL", telegramIconUrl)
    addCmsField(fieldData, fields, "Telegram Icon URL", telegramIconUrl)
    addCmsField(fieldData, fields, "Icon URL", telegramIconUrl)
    addCmsField(fieldData, fields, "Background Image URL Text", uploadedBackgroundUrl)

    addCmsField(fieldData, fields, "Member Count", cms.memberCount)
    addCmsField(fieldData, fields, "Votes Count", Number(listing.votes_count || 0))
    addCmsField(fieldData, fields, "Paid Rank", listing.paid_rank || "free")
    addCmsField(fieldData, fields, "Status", listing.status || "approved")
    addCmsField(fieldData, fields, "Is NSFW", boolValue(listing.is_nsfw))
    addCmsField(fieldData, fields, "Short Invite", cmsSlug)
    addCmsField(fieldData, fields, "Created At", listing.created_at || new Date().toISOString())
    addCmsField(fieldData, fields, "Last Synced At", listing.last_synced_at || new Date().toISOString())
    addCmsField(fieldData, fields, "SEO Title", cms.seoTitle)
    addCmsField(fieldData, fields, "SEO Description", cms.seoDescription)
    addCmsField(fieldData, fields, "Intro Text", cms.introText)
    addCmsField(fieldData, fields, "Safety Note", cms.safetyNote)
    addCmsField(fieldData, fields, "FAQ 1 Question", cms.faq1Question)
    addCmsField(fieldData, fields, "FAQ 1 Answer", cms.faq1Answer)
    addCmsField(fieldData, fields, "FAQ 2 Question", cms.faq2Question)
    addCmsField(fieldData, fields, "FAQ 2 Answer", cms.faq2Answer)
    addCmsField(fieldData, fields, "FAQ 3 Question", cms.faq3Question)
    addCmsField(fieldData, fields, "FAQ 3 Answer", cms.faq3Answer)

    // Framer unmanaged CMS collections create new items when no item id is provided.
    // Only include an id when we have confirmed that item already exists in Framer.
    const existingItems = await collection.getItems()
    const existingCmsItem =
      existingItems.find((item) => item.slug === cmsSlug) ||
      (listing.framer_cms_item_id
        ? existingItems.find((item) => item.id === listing.framer_cms_item_id)
        : null)

    const itemPayload = {
      slug: cmsSlug,
      fieldData,
    }

    if (existingCmsItem?.id) {
      itemPayload.id = existingCmsItem.id
    }

    await collection.addItems([itemPayload])

    let framerCmsItemId = existingCmsItem?.id || null

    if (!framerCmsItemId) {
      const itemsAfterCreate = await collection.getItems()
      const createdItem = itemsAfterCreate.find((item) => item.slug === cmsSlug)
      framerCmsItemId = createdItem?.id || null
    }

    let deployed = false

    if (process.env.FRAMER_AUTO_DEPLOY !== "false" && options.publish !== false) {
      const publication = await framer.publish()
      await framer.deploy(publication.deployment.id)
      deployed = true
    }

    const now = new Date().toISOString()
    const framerWarnings = []

    if (telegramSyncWarning) {
      framerWarnings.push(`Telegram sync warning: ${telegramSyncWarning}`)
    }

    if (!iconImageResult.ok) {
      framerWarnings.push(`Icon Image warning: ${iconImageResult.error}`)
    }

    if (!backgroundImageResult.ok && !backgroundImageResult.skipped) {
      framerWarnings.push(`Background Image warning: ${backgroundImageResult.error}`)
    }

    await supabaseAdmin
      .from("channel_listings")
      .update({
        short_invite: cmsSlug,
        framer_cms_item_id: framerCmsItemId,
        framer_sync_status: "synced",
        framer_synced_at: now,
        framer_sync_error: framerWarnings.length ? framerWarnings.join(" | ") : null,
        updated_at: now,
      })
      .eq("id", listing.id)

    return {
      ok: true,
      slug: cmsSlug,
      url: `https://telehub.to/channel/${cmsSlug}`,
      deployed,
      framer_cms_item_id: framerCmsItemId,
      icon_image: iconImageResult,
      background_image: backgroundImageResult,
      framer_sync_warning: framerWarnings.length ? framerWarnings.join(" | ") : null,
      telegram_sync_warning: telegramSyncWarning,
    }
  } catch (err) {
    await supabaseAdmin
      .from("channel_listings")
      .update({
        framer_sync_status: "failed",
        framer_sync_error: err.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listing.id)

    throw err
  } finally {
    await framer.disconnect()
  }
}


function getCmsItemFieldValue(item, fieldId) {
  if (!item || !fieldId) return null
  const fieldData = item.fieldData || {}
  const rawValue = fieldData[fieldId]

  if (rawValue && typeof rawValue === "object" && "value" in rawValue) {
    return rawValue.value
  }

  return rawValue ?? null
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "").map((value) => String(value).trim()))]
}

async function findFramerCmsItemForListing(collection, fields, listing) {
  const items = await collection.getItems()
  const supabaseIdField = getFieldByName(fields, "Supabase Listing ID")

  const possibleIds = uniqueValues([
    listing.framer_cms_item_id,
  ])

  const possibleSlugs = uniqueValues([
    listing.short_invite,
    cleanCmsSlug(listing.short_invite),
    listing.slug,
    cleanCmsSlug(listing.slug),
  ])

  const possibleSupabaseIds = uniqueValues([
    listing.id,
  ])

  const itemById = items.find((item) => possibleIds.includes(String(item.id || "")))
  if (itemById) return itemById

  const itemBySlug = items.find((item) => possibleSlugs.includes(String(item.slug || "")))
  if (itemBySlug) return itemBySlug

  if (supabaseIdField?.id) {
    const itemBySupabaseId = items.find((item) =>
      possibleSupabaseIds.includes(String(getCmsItemFieldValue(item, supabaseIdField.id) || ""))
    )
    if (itemBySupabaseId) return itemBySupabaseId
  }

  return null
}

async function publishFramerIfNeeded(framer, options = {}) {
  if (process.env.FRAMER_AUTO_DEPLOY === "false" || options.publish === false) {
    return false
  }

  const publication = await framer.publish()
  await framer.deploy(publication.deployment.id)
  return true
}

async function deleteListingFromFramerCMS(listing, options = {}) {
  if (!process.env.FRAMER_API_KEY || !process.env.FRAMER_PROJECT_URL) {
    throw new Error("Missing FRAMER_API_KEY or FRAMER_PROJECT_URL in Render environment variables.")
  }

  const { connect } = await import("framer-api")
  const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY)

  try {
    const collection = await getFramerCollection(framer)
    const fields = await collection.getFields()
    const cmsItem = await findFramerCmsItemForListing(collection, fields, listing)

    if (!cmsItem?.id) {
      console.warn("No matching Framer CMS item found for deleted listing:", {
        id: listing.id,
        short_invite: listing.short_invite,
        slug: listing.slug,
        framer_cms_item_id: listing.framer_cms_item_id,
      })

      return {
        ok: true,
        found: false,
        deleted: false,
        deployed: false,
        message: "No matching Framer CMS item was found. Supabase listing can still be deleted.",
      }
    }

    if (typeof collection.removeItems !== "function") {
      throw new Error("Framer collection.removeItems is unavailable. Update framer-api or check the collection type.")
    }

    await collection.removeItems([cmsItem.id])
    const deployed = await publishFramerIfNeeded(framer, options)

    return {
      ok: true,
      found: true,
      deleted: true,
      deployed,
      framer_cms_item_id: cmsItem.id,
      framer_slug: cmsItem.slug || null,
    }
  } finally {
    await framer.disconnect()
  }
}

async function safeDeleteRelatedRows(tableName, listingId) {
  const { error } = await supabaseAdmin
    .from(tableName)
    .delete()
    .eq("listing_id", listingId)

  if (error) {
    // Do not make the delete fail just because an optional related table does not exist
    // or does not use listing_id. The final channel_listings delete will catch real FK problems.
    if (["42P01", "42703"].includes(error.code)) {
      console.warn(`Skipping optional related delete for ${tableName}:`, error.message)
      return { table: tableName, ok: false, skipped: true, error: error.message }
    }

    throw error
  }

  return { table: tableName, ok: true }
}

async function deleteListingEverywhere(listing, options = {}) {
  const framerResult = await deleteListingFromFramerCMS(listing, options)

  const relatedTables = [
    "listing_referral_clicks",
    "channel_member_snapshots",
    "channel_votes",
    "channel_listing_changes",
  ]

  const relatedDeletes = []

  for (const tableName of relatedTables) {
    relatedDeletes.push(await safeDeleteRelatedRows(tableName, listing.id))
  }

  const { error: listingDeleteError } = await supabaseAdmin
    .from("channel_listings")
    .delete()
    .eq("id", listing.id)

  if (listingDeleteError) throw listingDeleteError

  let homepageCache = null

  try {
    homepageCache = await updateHomepageListingCache()
  } catch (cacheErr) {
    console.error("Homepage cache refresh after listing delete failed:", cacheErr.message)
  }

  return {
    ok: true,
    listing_id: listing.id,
    short_invite: listing.short_invite || null,
    framer: framerResult,
    related_deletes: relatedDeletes,
    homepage_cache: homepageCache
      ? {
          updated_at: homepageCache.updated_at,
          count: homepageCache.listings.length,
        }
      : null,
  }
}

app.post("/api/framer/sync-listing", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const token = authHeader.replace("Bearer ", "")
    const { listing_id } = req.body || {}

    if (!token) {
      return res.status(401).json({ error: "Missing auth token." })
    }

    if (!listing_id) {
      return res.status(400).json({ error: "Missing listing_id." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid auth token." })
    }

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select("id, user_id")
      .eq("id", listing_id)
      .single()

    if (listingError || !listing) {
      return res.status(404).json({ error: "Listing not found." })
    }

    const email = (user.email || "").toLowerCase()
    const isAdmin = ADMIN_EMAILS.includes(email)

    if (listing.user_id !== user.id && !isAdmin) {
      return res.status(403).json({ error: "You do not own this listing." })
    }

    const result = await queueFramerSync(() =>
      syncListingToFramerCMS(listing_id, {
        // Newly created listings need Telegram metadata before the CMS item is built.
        // This fills telegram_title, telegram_username, icon_url, member_count,
        // telegram_chat_id, and listing_type before Framer publishes the page.
        skipTelegramSync: false,
        publish: true,
      })
    )

    return res.json(result)
  } catch (err) {
    console.error("Framer listing sync error:", err)
    return res.status(500).json({ error: err.message })
  }
})


// Call this after an existing listing edit is saved.
// It skips Framer when only dynamic values such as member_count or votes_count changed.
app.post("/api/framer/sync-content-change", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const token = authHeader.replace("Bearer ", "")
    const { listing_id, changed_fields } = req.body || {}

    if (!token) {
      return res.status(401).json({ error: "Missing auth token." })
    }

    if (!listing_id) {
      return res.status(400).json({ error: "Missing listing_id." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid auth token." })
    }

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select("id, user_id, status, is_banned")
      .eq("id", listing_id)
      .single()

    if (listingError || !listing) {
      return res.status(404).json({ error: "Listing not found." })
    }

    const email = (user.email || "").toLowerCase()
    const isAdmin = ADMIN_EMAILS.includes(email)

    if (listing.user_id !== user.id && !isAdmin) {
      return res.status(403).json({ error: "You do not own this listing." })
    }

    const cleanChangedFields = Array.isArray(changed_fields)
      ? changed_fields.map((field) => String(field || "").trim()).filter(Boolean)
      : []

    if (listing.status !== "approved" || listing.is_banned) {
      return res.json({
        ok: true,
        synced: false,
        reason: "Listing is not currently eligible for Framer CMS sync.",
        changed_fields: cleanChangedFields,
      })
    }

    const result = await queueFramerSync(() =>
      syncListingToFramerCMS(listing_id, {
        skipTelegramSync: true,
        publish: true,
      })
    )

    return res.json({
      ok: true,
      synced: true,
      changed_fields: cleanChangedFields,
      framer: result,
    })
  } catch (err) {
    console.error("Framer content-change sync error:", err)
    return res.status(500).json({ error: err.message })
  }
})



// Admin-only CMS lifecycle endpoint.
// Reject/ban removes the public CMS page. Unban recreates and publishes it.
app.post("/api/admin/listings/lifecycle", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const token = authHeader.replace("Bearer ", "")
    const { listing_id, action, reason } = req.body || {}

    if (!token) return res.status(401).json({ error: "Missing auth token." })
    if (!listing_id) return res.status(400).json({ error: "Missing listing_id." })

    const cleanAction = String(action || "").trim().toLowerCase()
    if (!["reject", "ban", "unban"].includes(cleanAction)) {
      return res.status(400).json({ error: "Invalid lifecycle action." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid auth token." })
    }

    const email = (user.email || "").toLowerCase()
    if (!ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("id", listing_id)
      .single()

    if (listingError || !listing) {
      return res.status(404).json({ error: "Listing not found." })
    }

    if (cleanAction === "reject" || cleanAction === "ban") {
      const framer = await queueFramerSync(() =>
        deleteListingFromFramerCMS(listing, { publish: true })
      )

      const updatePayload = cleanAction === "reject"
        ? {
            status: "rejected",
            admin_reviewed: true,
            framer_cms_item_id: null,
            framer_sync_status: "not_synced",
            framer_sync_error: null,
            updated_at: new Date().toISOString(),
          }
        : {
            is_banned: true,
            admin_reviewed: true,
            ban_reason: String(reason || "Temporarily banned by admin."),
            framer_cms_item_id: null,
            framer_sync_status: "not_synced",
            framer_sync_error: null,
            updated_at: new Date().toISOString(),
          }

      const { error: updateError } = await supabaseAdmin
        .from("channel_listings")
        .update(updatePayload)
        .eq("id", listing_id)

      if (updateError) throw updateError

      return res.json({
        ok: true,
        action: cleanAction,
        listing_id,
        framer,
      })
    }

    const { error: unbanError } = await supabaseAdmin
      .from("channel_listings")
      .update({
        is_banned: false,
        ban_reason: null,
        status: "approved",
        framer_sync_status: "not_synced",
        framer_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", listing_id)

    if (unbanError) throw unbanError

    const framer = await queueFramerSync(() =>
      syncListingToFramerCMS(listing_id, {
        skipTelegramSync: true,
        publish: true,
      })
    )

    return res.json({
      ok: true,
      action: cleanAction,
      listing_id,
      framer,
    })
  } catch (err) {
    console.error("Admin listing lifecycle error:", err)
    return res.status(500).json({ error: err.message })
  }
})

app.post("/api/listings/delete", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const token = authHeader.replace("Bearer ", "")
    const { listing_id } = req.body || {}

    if (!token) {
      return res.status(401).json({ error: "Missing auth token." })
    }

    if (!listing_id) {
      return res.status(400).json({ error: "Missing listing_id." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid auth token." })
    }

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("id", listing_id)
      .single()

    if (listingError || !listing) {
      return res.status(404).json({ error: "Listing not found." })
    }

    const email = (user.email || "").toLowerCase()
    const isAdmin = ADMIN_EMAILS.includes(email)

    if (listing.user_id !== user.id && !isAdmin) {
      return res.status(403).json({ error: "You do not own this listing." })
    }

    const result = await queueFramerSync(() => deleteListingEverywhere(listing))

    return res.json(result)
  } catch (err) {
    console.error("Delete listing everywhere error:", err)
    return res.status(500).json({ error: err.message })
  }
})

app.post("/api/framer/delete-listing", async (req, res) => {
  try {
    // Backward-compatible alias for the same delete behavior.
    const authHeader = req.headers.authorization || ""
    const token = authHeader.replace("Bearer ", "")
    const { listing_id } = req.body || {}

    if (!token) {
      return res.status(401).json({ error: "Missing auth token." })
    }

    if (!listing_id) {
      return res.status(400).json({ error: "Missing listing_id." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid auth token." })
    }

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("id", listing_id)
      .single()

    if (listingError || !listing) {
      return res.status(404).json({ error: "Listing not found." })
    }

    const email = (user.email || "").toLowerCase()
    const isAdmin = ADMIN_EMAILS.includes(email)

    if (listing.user_id !== user.id && !isAdmin) {
      return res.status(403).json({ error: "You do not own this listing." })
    }

    const result = await queueFramerSync(() => deleteListingEverywhere(listing))

    return res.json(result)
  } catch (err) {
    console.error("Framer delete listing error:", err)
    return res.status(500).json({ error: err.message })
  }
})

app.post("/api/framer/sync-all-listings", async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { data: listings, error } = await supabaseAdmin
      .from("channel_listings")
      .select("id")
      .eq("status", "approved")
      .or("is_banned.is.null,is_banned.eq.false")

    if (error) throw error

    const results = []

    for (const listing of listings || []) {
      try {
        const result = await queueFramerSync(() =>
          syncListingToFramerCMS(listing.id, { publish: false, skipTelegramSync: false })
        )
        results.push({ id: listing.id, ok: true, slug: result.slug })
      } catch (err) {
        results.push({ id: listing.id, ok: false, error: err.message })
      }
    }

    let deployed = false

    if (process.env.FRAMER_AUTO_DEPLOY !== "false") {
      const { connect } = await import("framer-api")
      const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY)
      try {
        const publication = await framer.publish()
        await framer.deploy(publication.deployment.id)
        deployed = true
      } finally {
        await framer.disconnect()
      }
    }

    return res.json({ ok: true, deployed, count: results.length, results })
  } catch (err) {
    console.error("Framer sync-all error:", err)
    return res.status(500).json({ error: err.message })
  }
})

// Schedule this endpoint once per day at 12:00 AM America/Phoenix.
// Render cron uses UTC, so Phoenix midnight is 07:00 UTC year-round.
// It refreshes member counts daily, metadata weekly, and icons monthly.
// Telegram public pages are scraped first, with Bot API fallback.
// Framer receives daily member fields plus full CMS refreshes for listings
// whose weekly metadata or monthly icon changed, then publishes once.
app.get("/api/cron/daily-full-sync", async (req, res) => {
  try {
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const startedAt = Date.now()

    // Defer any Framer deployment until the final member-field update.
    const telegramResult = await runHourlyTelegramSync({ publish: false })

    const { data: freshListings, error: listingsError } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("status", "approved")
      .or("is_banned.is.null,is_banned.eq.false")

    if (listingsError) throw listingsError

    const metadataListingIds = telegramResult.results
      .filter(
        (item) =>
          item.ok &&
          (item.metadata_refreshed || item.icon_refreshed)
      )
      .map((item) => item.id)

    const framerResult = await queueFramerSync(() =>
      syncScheduledListingsToFramerCMS(
        freshListings || [],
        metadataListingIds,
        { publish: true }
      )
    )

    const metadataFramerResults = framerResult.results.filter(
      (item) => item.full_sync
    )

    let homepageCache = null

    try {
      homepageCache = await updateHomepageListingCache()
    } catch (cacheErr) {
      console.error(
        "Homepage cache refresh after daily member sync failed:",
        cacheErr
      )
    }

    return res.json({
      ok: true,
      member_count_only: false,
      schedule: {
        member_counts: "daily",
        metadata: "weekly",
        icons: "monthly",
      },
      telegram: telegramResult,
      metadata_framer: {
        attempted: metadataListingIds.length,
        succeeded: metadataFramerResults.filter((item) => item.ok).length,
        failed: metadataFramerResults.filter((item) => !item.ok).length,
        results: metadataFramerResults,
      },
      framer: framerResult,
      duration_ms: Date.now() - startedAt,
      homepage_cache: homepageCache
        ? {
            updated_at: homepageCache.updated_at,
            count: homepageCache.listings.length,
          }
        : null,
    })
  } catch (err) {
    console.error("Daily member sync error:", err)
    return res.status(500).json({ error: err.message })
  }
})


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


async function buildHomepageListings(limit = 18) {
  const cleanLimit = Math.min(Math.max(Number(limit) || 18, 1), 30)

  const { data: listings, error: listingsError } = await supabaseAdmin
    .from("channel_listings")
    .select(`
      id,
      slug,
      channel_name,
      telegram_title,
      listing_type,
      telegram_username,
      telegram_link,
      description,
      categories,
      image_url,
      icon_url,
      member_count,
      votes_count,
      referral_boost_score,
      paid_rank,
      paid_rank_status,
      is_nsfw,
      is_banned,
      status,
      created_at,
      updated_at,
      last_synced_at
      `)
    .eq("status", "approved")
    .or("is_banned.is.null,is_banned.eq.false")
    .or("is_nsfw.is.null,is_nsfw.eq.false")

  if (listingsError) throw listingsError

  const listingIds = (listings || []).map((item) => item.id)

  let snapshots = []

  if (listingIds.length > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const snapshotIdBatchSize = Math.max(
      10,
      Math.min(
        Number(process.env.HOMEPAGE_SNAPSHOT_ID_BATCH_SIZE || 75),
        150
      )
    )

    for (
      let index = 0;
      index < listingIds.length;
      index += snapshotIdBatchSize
    ) {
      const idBatch = listingIds.slice(index, index + snapshotIdBatchSize)

      const { data: snapshotData, error: snapshotError } =
        await supabaseAdmin
          .from("channel_member_snapshots")
          .select("listing_id, member_count, created_at")
          .in("listing_id", idBatch)
          .gte("created_at", since)
          .order("created_at", { ascending: true })

      if (snapshotError) throw snapshotError

      snapshots.push(...(snapshotData || []))
    }
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

    const oldMembers = Number(
      firstSnapshot?.member_count || listing.member_count || 0
    )

    const latestMembers = Number(
      latestSnapshot?.member_count || listing.member_count || 0
    )

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
      ...listingsWithGrowth.map((item) =>
        Number(item.member_growth_24h || 0)
      )
    ),
  }

  function getPaidRankPriority(item) {
    const rank = String(item.paid_rank || "free").toLowerCase()
    const status = String(item.paid_rank_status || "inactive").toLowerCase()

    if (status !== "active" && status !== "trialing") return 0
    if (rank === "sponsor") return 3
    if (rank === "gold") return 2
    if (rank === "silver") return 1

    return 0
  }

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000

  const homepageListings = listingsWithGrowth
    .map((listing) => {
      const ranking = calculateRankingScore(listing, maxStats)

      const createdAt = new Date(listing.created_at).getTime()
      const ageMs = Date.now() - createdAt
      const isNew = ageMs >= 0 && ageMs < threeDaysMs

      const newnessScore = isNew
        ? Math.max(0, (threeDaysMs - ageMs) / threeDaysMs) * 1000
        : 0

      return {
        ...listing,
        ...ranking,
        _paid_priority: getPaidRankPriority(listing),
        _homepage_score: Number(ranking.ranking_score || 0) + newnessScore,
      }
    })
    .sort((a, b) => {
      if (b._paid_priority !== a._paid_priority) {
        return b._paid_priority - a._paid_priority
      }

      if (b._homepage_score !== a._homepage_score) {
        return b._homepage_score - a._homepage_score
      }

      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
    .slice(0, cleanLimit)
    .map(({ _paid_priority, _homepage_score, ...item }) => item)

  return homepageListings
}

async function updateHomepageListingCache() {
  const listings = await buildHomepageListings(18)
  const updatedAt = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from("homepage_listing_cache")
    .upsert({
      id: "homepage_top_18",
      listings,
      updated_at: updatedAt,
    })

  if (error) throw error

  return {
    listings,
    updated_at: updatedAt,
  }
}


// ========================================
// TELEGRAM TEMPLATE COPIER — MTProto source + Bot API destination
// Reads one public/joined source through the user's authorized Telegram session.
// Writes only supported settings to a destination where @teleg_sync_bot is admin.
// No messages, members, usernames, or actual administrators are transferred.
// ========================================

const TELEGRAM_TEMPLATE_SESSION_TTL_HOURS = 24
const TELEGRAM_MT_API_ID = Number(process.env.TELEGRAM_API_ID || 0)
const TELEGRAM_MT_API_HASH = String(process.env.TELEGRAM_API_HASH || "").trim()
const TELEGRAM_TEMPLATE_ENCRYPTION_KEY = String(
  process.env.TELEGRAM_TEMPLATE_ENCRYPTION_KEY || ""
).trim()
let telegramBotIdentity = null

function hashTemplateToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex")
}

function createTemplateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex")
}

function createTemplateConnectionCode() {
  return `TH-${crypto.randomInt(100000, 1000000)}`
}

function normalizeTemplateChatType(type) {
  if (type === "channel") return "channel"
  if (type === "supergroup") return "supergroup"
  return null
}

function assertMtProtoConfigured() {
  if (!TELEGRAM_MT_API_ID || !TELEGRAM_MT_API_HASH) {
    const error = new Error("Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in Render.")
    error.statusCode = 500
    throw error
  }
  if (!TELEGRAM_TEMPLATE_ENCRYPTION_KEY) {
    const error = new Error("Missing TELEGRAM_TEMPLATE_ENCRYPTION_KEY in Render.")
    error.statusCode = 500
    throw error
  }
}

function getTemplateCipherKey() {
  assertMtProtoConfigured()
  return crypto.createHash("sha256").update(TELEGRAM_TEMPLATE_ENCRYPTION_KEY).digest()
}

function encryptTemplateSecret(value) {
  if (!value) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", getTemplateCipherKey(), iv)
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

function decryptTemplateSecret(value) {
  if (!value) return ""
  const packed = Buffer.from(String(value), "base64")
  if (packed.length < 29) throw new Error("Stored Telegram session is invalid.")
  const iv = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const encrypted = packed.subarray(28)
  const decipher = crypto.createDecipheriv("aes-256-gcm", getTemplateCipherKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
}

function serializeBotPermissions(member) {
  if (!member || member.status !== "administrator") return {}
  const keys = [
    "can_manage_chat",
    "can_change_info",
    "can_delete_messages",
    "can_invite_users",
    "can_restrict_members",
    "can_pin_messages",
    "can_manage_topics",
    "can_promote_members",
    "can_post_messages",
    "can_edit_messages",
    "can_manage_video_chats",
  ]
  return Object.fromEntries(keys.map((key) => [key, member[key] === true]))
}

async function getTelegramBotIdentity() {
  if (!telegramBotIdentity) telegramBotIdentity = await tg("getMe")
  return telegramBotIdentity
}

async function requireTemplateSession(req) {
  const rawToken = String(req.headers["x-template-session"] || "").trim()
  if (!rawToken) {
    const error = new Error("Missing template session.")
    error.statusCode = 401
    throw error
  }

  const tokenHash = hashTemplateToken(rawToken)
  const now = new Date().toISOString()
  const { data: session, error } = await supabaseAdmin
    .from("telegram_template_sessions")
    .select("*")
    .eq("session_token_hash", tokenHash)
    .gt("expires_at", now)
    .maybeSingle()

  if (error) throw error
  if (!session) {
    const authError = new Error("Template session expired. Refresh the page to start again.")
    authError.statusCode = 401
    throw authError
  }

  await supabaseAdmin
    .from("telegram_template_sessions")
    .update({ last_used_at: now })
    .eq("id", session.id)

  return session
}

async function updateTemplateSession(sessionId, values) {
  const { data, error } = await supabaseAdmin
    .from("telegram_template_sessions")
    .update({ ...values, last_used_at: new Date().toISOString() })
    .eq("id", sessionId)
    .select("*")
    .single()
  if (error) throw error
  return data
}

async function getTemplateConnectedChat(sessionId, connectedChatId) {
  const { data, error } = await supabaseAdmin
    .from("telegram_template_chats")
    .select("*")
    .eq("id", connectedChatId)
    .eq("session_id", sessionId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function createMtProtoClient(encryptedSession = "") {
  assertMtProtoConfigured()
  const { TelegramClient } = require("telegram")
  const { StringSession } = require("telegram/sessions")
  const stringSession = encryptedSession ? decryptTemplateSecret(encryptedSession) : ""
  const client = new TelegramClient(
    new StringSession(stringSession),
    TELEGRAM_MT_API_ID,
    TELEGRAM_MT_API_HASH,
    {
      connectionRetries: 5,
      requestRetries: 3,
      floodSleepThreshold: 10,
      autoReconnect: false,
    }
  )
  await client.connect()
  return client
}

async function safelyDisconnectMt(client) {
  if (!client) return

  try {
    if (typeof client.destroy === "function") {
      await client.destroy()
      return
    }
  } catch (destroyError) {
    console.warn("MTProto destroy warning:", destroyError.message)
  }

  try {
    await client.disconnect()
  } catch (disconnectError) {
    console.warn(
      "MTProto disconnect warning:",
      disconnectError.message
    )
  }
}



function cleanTelegramSourceReference(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  if (/^https?:\/\/t\.me\//i.test(raw)) return raw
  if (/^t\.me\//i.test(raw)) return `https://${raw}`
  if (raw.startsWith("@")) return raw
  if (/^[a-zA-Z0-9_]{5,}$/.test(raw)) return `@${raw}`
  return raw
}

function mtBool(value) {
  return value === true
}

function mtAllowedPermissions(defaultBannedRights) {
  if (!defaultBannedRights) return null
  // MTProto stores default restrictions as banned rights; Bot API expects allowed rights.
  return {
    can_send_messages: !mtBool(defaultBannedRights.sendMessages),
    can_send_audios: !mtBool(defaultBannedRights.sendAudios),
    can_send_documents: !mtBool(defaultBannedRights.sendDocs),
    can_send_photos: !mtBool(defaultBannedRights.sendPhotos),
    can_send_videos: !mtBool(defaultBannedRights.sendVideos),
    can_send_video_notes: !mtBool(defaultBannedRights.sendRoundvideos),
    can_send_voice_notes: !mtBool(defaultBannedRights.sendVoices),
    can_send_polls: !mtBool(defaultBannedRights.sendPolls),
    can_send_other_messages: !mtBool(defaultBannedRights.sendStickers),
    can_add_web_page_previews: !mtBool(defaultBannedRights.embedLinks),
    can_change_info: !mtBool(defaultBannedRights.changeInfo),
    can_invite_users: !mtBool(defaultBannedRights.inviteUsers),
    can_pin_messages: !mtBool(defaultBannedRights.pinMessages),
    can_manage_topics: !mtBool(defaultBannedRights.manageTopics),
  }
}


function telegramCloneError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function telegramCloneType(entity) {
  if (!entity || entity.className !== "Channel") return null
  return entity.broadcast ? "channel" : "supergroup"
}

function telegramCloneAdminRights(entity) {
  const rights = entity?.adminRights || {}
  return {
    is_creator: entity?.creator === true,
    can_change_info:
      entity?.creator === true ||
      rights.changeInfo === true,
    can_ban_users:
      entity?.creator === true ||
      rights.banUsers === true,
    can_manage_topics:
      entity?.creator === true ||
      rights.manageTopics === true ||
      rights.changeInfo === true,
  }
}

function telegramCloneCanManageDestination(entity) {
  const rights = telegramCloneAdminRights(entity)
  return rights.is_creator || rights.can_change_info
}

function telegramClonePublicEntity(entity) {
  const type = telegramCloneType(entity)
  const rights = telegramCloneAdminRights(entity)

  return {
    id: String(entity.id),
    title: entity.title || "Telegram Community",
    username: entity.username || null,
    type,
    creator: rights.is_creator,
    admin_rights: rights,
  }
}

async function requireLinkedTelegramClient(req) {
  const user = await requireTelehubUser(req)
  const connection = await getTelegramAccountConnection(user.id)

  if (
    !connection ||
    connection.auth_status !== "connected" ||
    !connection.encrypted_mtproto_session
  ) {
    throw telegramCloneError(
      "Link your Telegram account from your TeleHub profile first.",
      401
    )
  }

  const client = await createMtProtoClient(
    connection.encrypted_mtproto_session
  )

  if (!(await client.checkAuthorization())) {
    await safelyDisconnectMt(client)
    throw telegramCloneError(
      "Your Telegram connection expired. Reconnect it from your profile.",
      401
    )
  }

  return { user, connection, client }
}

async function resolveTelegramCloneEntity(client, reference, label) {
  const cleanReference = cleanTelegramSourceReference(reference)

  if (!cleanReference) {
    throw telegramCloneError(`Enter a ${label} Telegram link or username.`)
  }

  let entity

  try {
    entity = await client.getEntity(cleanReference)
  } catch (error) {
    throw telegramCloneError(
      `Could not access the ${label}. Make sure it is public or joined by your linked Telegram account.`
    )
  }

  if (!telegramCloneType(entity)) {
    throw telegramCloneError(
      `The ${label} must be a Telegram channel or supergroup.`
    )
  }

  return entity
}


function normalizeTelegramForumTopic(topic) {
  if (!topic || topic.className !== "ForumTopic") return null

  return {
    id: Number(topic.id),
    title: String(topic.title || "Topic"),
    icon_color:
      topic.iconColor === null || topic.iconColor === undefined
        ? null
        : Number(topic.iconColor),
    icon_emoji_id:
      topic.iconEmojiId === null || topic.iconEmojiId === undefined
        ? null
        : String(topic.iconEmojiId),
    pinned: topic.pinned === true,
    closed: topic.closed === true,
    hidden: topic.hidden === true,
    is_general: Number(topic.id) === 1,
  }
}

async function getAllTelegramForumTopics(client, channelInput) {
  const { Api } = require("telegram")
  const topics = []
  const seen = new Set()

  let offsetDate = 0
  let offsetId = 0
  let offsetTopic = 0

  for (let page = 0; page < 10; page += 1) {
    const result = await client.invoke(
      new Api.channels.GetForumTopics({
        channel: channelInput,
        q: "",
        offsetDate,
        offsetId,
        offsetTopic,
        limit: 100,
      })
    )

    const pageTopics = (result.topics || [])
      .map(normalizeTelegramForumTopic)
      .filter(Boolean)

    for (const topic of pageTopics) {
      if (!seen.has(topic.id)) {
        seen.add(topic.id)
        topics.push(topic)
      }
    }

    if (pageTopics.length < 100) break

    const lastTopic = pageTopics[pageTopics.length - 1]
    offsetTopic = Number(lastTopic.id || 0)

    const lastMessage = (result.messages || []).find(
      (message) => Number(message.id) === Number(lastTopic.id)
    )

    offsetId = Number(lastMessage?.id || 0)
    offsetDate = Number(lastMessage?.date || 0)

    if (!offsetTopic) break
  }

  return topics
}

function extractCreatedForumTopicId(updates) {
  const updateList = updates?.updates || []

  for (const update of updateList) {
    const message = update?.message
    const action = message?.action

    if (
      message?.id &&
      action &&
      (
        action.className === "MessageActionTopicCreate" ||
        action.className === "MessageActionTopicEdit"
      )
    ) {
      return Number(message.id)
    }
  }

  return null
}

async function ensureDestinationForumEnabled(
  client,
  destinationInput,
  destinationEntity
) {
  const { Api } = require("telegram")

  if (destinationEntity.forum === true) {
    return { enabled: false, already_enabled: true }
  }

  await client.invoke(
    new Api.channels.ToggleForum({
      channel: destinationInput,
      enabled: true,
    })
  )

  return { enabled: true, already_enabled: false }
}

async function cloneTelegramForumTopics(
  client,
  destinationInput,
  sourceTopics
) {
  const { Api } = require("telegram")

  const results = []
  const createdTopicIds = []
  const pinnedCreatedIds = []

  const generalTopic = (sourceTopics || []).find(
    (topic) => topic.is_general
  )

  if (generalTopic && generalTopic.title !== "General") {
    try {
      await client.invoke(
        new Api.channels.EditForumTopic({
          channel: destinationInput,
          topicId: 1,
          title: generalTopic.title,
          iconEmojiId: generalTopic.icon_emoji_id
            ? BigInt(generalTopic.icon_emoji_id)
            : undefined,
        })
      )

      results.push({
        key: "topic_general",
        label: generalTopic.title,
        ok: true,
        general: true,
      })
    } catch (error) {
      results.push({
        key: "topic_general",
        label: generalTopic.title,
        ok: false,
        general: true,
        message: error.message,
      })
    }
  }

  for (const topic of sourceTopics || []) {
    if (topic.is_general) continue

    try {
      const createResult = await client.invoke(
        new Api.channels.CreateForumTopic({
          channel: destinationInput,
          title: topic.title,
          iconColor:
            topic.icon_color === null
              ? undefined
              : topic.icon_color,
          iconEmojiId: topic.icon_emoji_id
            ? BigInt(topic.icon_emoji_id)
            : undefined,
          randomId: BigInt(
            "0x" + crypto.randomBytes(8).toString("hex")
          ),
        })
      )

      const createdId = extractCreatedForumTopicId(createResult)

      if (createdId) {
        createdTopicIds.push(createdId)
        if (topic.pinned) pinnedCreatedIds.push(createdId)
      }

      results.push({
        key: `topic_${topic.id}`,
        label: topic.title,
        ok: true,
        topic_id: createdId,
      })

      if (createdId && topic.closed) {
        try {
          await client.invoke(
            new Api.channels.EditForumTopic({
              channel: destinationInput,
              topicId: createdId,
              closed: true,
            })
          )
        } catch (closeError) {
          results.push({
            key: `topic_close_${topic.id}`,
            label: `${topic.title} closed state`,
            ok: false,
            message: closeError.message,
          })
        }
      }
    } catch (error) {
      results.push({
        key: `topic_${topic.id}`,
        label: topic.title,
        ok: false,
        message: error.message,
      })
    }
  }

  if (pinnedCreatedIds.length > 0) {
    try {
      await client.invoke(
        new Api.channels.ReorderPinnedForumTopics({
          channel: destinationInput,
          force: true,
          order: pinnedCreatedIds,
        })
      )

      results.push({
        key: "topic_pinned_order",
        label: "Pinned topic order",
        ok: true,
      })
    } catch (error) {
      results.push({
        key: "topic_pinned_order",
        label: "Pinned topic order",
        ok: false,
        message: error.message,
      })
    }
  }

  return {
    results,
    created_topic_ids: createdTopicIds,
  }
}

async function inspectTelegramCloneEntity(client, entity, includePhoto = false) {
  const { Api } = require("telegram")

  const input = await client.getInputEntity(entity)
  const fullResult = await client.invoke(
    new Api.channels.GetFullChannel({ channel: input })
  )

  const full = fullResult.fullChat || {}
  const chat =
    (fullResult.chats || []).find(
      (item) => String(item.id) === String(entity.id)
    ) || entity

  let photoBuffer = null

  if (
    includePhoto &&
    chat.photo &&
    chat.photo.className !== "ChatPhotoEmpty"
  ) {
    try {
      photoBuffer = await client.downloadProfilePhoto(chat, {
        isBig: true,
      })
    } catch (error) {
      console.warn(
        "Telegram clone source-photo download warning:",
        error.message
      )
    }
  }

  const type = telegramCloneType(chat)

  let topics = []

  // GramJS does not always populate chat.forum reliably on the entity
  // returned by GetFullChannel. Try reading forum topics for every
  // supergroup and treat a successful non-empty result as forum mode.
  if (type === "supergroup") {
    try {
      topics = await getAllTelegramForumTopics(client, input)
    } catch (topicError) {
      const message = String(topicError?.message || topicError || "")

      // A normal non-forum supergroup can reject GetForumTopics. That is
      // expected and should not make the whole preview fail.
      if (
        !message.includes("CHAT_NOT_FORUM") &&
        !message.includes("CHANNEL_FORUM_MISSING")
      ) {
        console.warn(
          "Telegram clone source-topic inspection warning:",
          message
        )
      }
    }
  }

  return {
    entity: chat,
    input,
    type,
    title: chat.title || "Telegram Community",
    username: chat.username || null,
    description: full.about || "",
    photo_available:
      Boolean(chat.photo) &&
      chat.photo.className !== "ChatPhotoEmpty",
    photo_buffer: photoBuffer,
    permissions:
      type === "supergroup"
        ? mtAllowedPermissions(chat.defaultBannedRights)
        : null,
    default_banned_rights: chat.defaultBannedRights || null,
    topics,
    settings: {
      slow_mode_seconds: Number(full.slowmodeSeconds || 0),
      protected_content: chat.noforwards === true,
      forum_mode: chat.forum === true || topics.length > 0,
      linked_chat_id: full.linkedChatId
        ? String(full.linkedChatId)
        : null,
      history_hidden:
        chat.defaultBannedRights?.viewMessages === true,
      anti_spam: full.antispam === true,
      auto_delete_seconds: Number(full.ttlPeriod || 0),
    },
    rights: telegramCloneAdminRights(chat),
  }
}

function buildTelegramClonePreview(source, destination) {
  if (source.type !== destination.type) {
    throw telegramCloneError(
      "Source and destination must both be channels or both be supergroups."
    )
  }

  if (!telegramCloneCanManageDestination(destination.entity)) {
    throw telegramCloneError(
      "Your linked Telegram account must be an administrator with permission to change the destination."
    )
  }

  const automatic = [
    {
      key: "title",
      label: "Name",
      supported: destination.rights.can_change_info,
      source_value: source.title,
      destination_value: destination.title,
    },
    {
      key: "description",
      label: "Description",
      supported: destination.rights.can_change_info,
      source_value: source.description,
      destination_value: destination.description,
    },
    {
      key: "photo",
      label: "Profile photo",
      supported:
        destination.rights.can_change_info &&
        source.photo_available,
      source_value: source.photo_available
        ? "Source photo detected"
        : "No source photo",
      destination_value: destination.photo_available
        ? "Destination has a photo"
        : "No destination photo",
    },
  ]

  if (source.type === "supergroup") {
    automatic.push({
      key: "permissions",
      label: "Default member permissions",
      supported:
        destination.rights.can_ban_users &&
        Boolean(source.default_banned_rights),
      source_value: source.permissions,
      destination_value: destination.permissions,
    })

    automatic.push({
      key: "topics",
      label: "Forum topics",
      supported:
        (source.settings.forum_mode === true || source.topics.length > 0) &&
        destination.rights.can_manage_topics === true,
      source_value:
        source.topics.length > 0
          ? `${source.topics.length} topics detected`
          : source.settings.forum_mode === true
            ? "Forum enabled, but no named topics were returned"
            : "Source does not use topics",
      destination_value:
        destination.settings.forum_mode === true
          ? `${destination.topics.length} existing topics`
          : "Topics disabled",
    })
  }

  return {
    source: {
      id: String(source.entity.id),
      title: source.title,
      username: source.username,
      type: source.type,
    },
    destination: {
      id: String(destination.entity.id),
      title: destination.title,
      username: destination.username,
      type: destination.type,
      rights: destination.rights,
    },
    automatic,
    topics: source.topics || [],
    manual: [
      {
        key: "slow_mode",
        label: "Slow mode",
        value: source.settings.slow_mode_seconds,
      },
      {
        key: "protected_content",
        label: "Content protection",
        value: source.settings.protected_content,
      },
      {
        key: "forum_mode",
        label: "Forum/topics mode",
        value: source.settings.forum_mode,
      },
      {
        key: "linked_chat",
        label: "Linked discussion chat",
        value: source.settings.linked_chat_id,
      },
      {
        key: "anti_spam",
        label: "Aggressive anti-spam",
        value: source.settings.anti_spam,
      },
      {
        key: "auto_delete",
        label: "Message auto-delete",
        value: source.settings.auto_delete_seconds,
      },
    ],
  }
}

async function applyTelegramClonePhoto(
  client,
  destinationInput,
  photoBuffer
) {
  if (!photoBuffer || !photoBuffer.length) {
    return {
      ok: false,
      skipped: true,
      message: "Source profile photo could not be downloaded.",
    }
  }

  const { Api } = require("telegram")
  const { CustomFile } = require("telegram/client/uploads")

  const file = new CustomFile(
    `telehub-clone-${Date.now()}.jpg`,
    photoBuffer.length,
    "",
    photoBuffer
  )

  const uploadedFile = await client.uploadFile({
    file,
    workers: 1,
  })

  await client.invoke(
    new Api.channels.EditPhoto({
      channel: destinationInput,
      photo: new Api.InputChatUploadedPhoto({
        file: uploadedFile,
      }),
    })
  )

  return { ok: true }
}

async function applyTelegramClonePermissions(
  client,
  destinationInput,
  bannedRights
) {
  if (!bannedRights) {
    return {
      ok: false,
      skipped: true,
      message: "No source permissions were available.",
    }
  }

  const { Api } = require("telegram")

  await client.invoke(
    new Api.messages.EditChatDefaultBannedRights({
      peer: destinationInput,
      bannedRights,
    })
  )

  return { ok: true }
}

app.get("/api/telegram-clone/status", async (req, res) => {
  try {
    const user = await requireTelehubUser(req)
    const connection = await getTelegramAccountConnection(user.id)

    return res.json({
      ok: true,
      connected:
        connection?.auth_status === "connected" &&
        Boolean(connection?.encrypted_mtproto_session),
      telegram: connection
        ? {
            username: connection.telegram_username || null,
            first_name: connection.telegram_first_name || null,
            last_name: connection.telegram_last_name || null,
          }
        : null,
    })
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message })
  }
})

app.get("/api/telegram-clone/destinations", async (req, res) => {
  let client

  try {
    const linked = await requireLinkedTelegramClient(req)
    client = linked.client

    const dialogs = await client.getDialogs({ limit: 200 })
    const destinations = []
    const seen = new Set()

    for (const dialog of dialogs || []) {
      const entity = dialog.entity
      const type = telegramCloneType(entity)

      if (!type || !telegramCloneCanManageDestination(entity)) {
        continue
      }

      const id = String(entity.id)
      if (seen.has(id)) continue
      seen.add(id)

      destinations.push(telegramClonePublicEntity(entity))
    }

    destinations.sort((a, b) =>
      String(a.title).localeCompare(String(b.title))
    )

    return res.json({
      ok: true,
      destinations,
    })
  } catch (error) {
    console.error(
      "Telegram clone destinations error:",
      error
    )
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-clone/preview", async (req, res) => {
  let client

  try {
    const linked = await requireLinkedTelegramClient(req)
    client = linked.client

    const { source, destination } = req.body || {}

    const sourceEntity = await resolveTelegramCloneEntity(
      client,
      source,
      "source"
    )
    const destinationEntity =
      await resolveTelegramCloneEntity(
        client,
        destination,
        "destination"
      )

    const [sourceInspection, destinationInspection] =
      await Promise.all([
        inspectTelegramCloneEntity(
          client,
          sourceEntity,
          false
        ),
        inspectTelegramCloneEntity(
          client,
          destinationEntity,
          false
        ),
      ])

    const preview = buildTelegramClonePreview(
      sourceInspection,
      destinationInspection
    )

    return res.json({ ok: true, preview })
  } catch (error) {
    console.error("Telegram clone preview error:", error)
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-clone/apply", async (req, res) => {
  let client

  try {
    const linked = await requireLinkedTelegramClient(req)
    client = linked.client

    const {
      source,
      destination,
      copy = {},
    } = req.body || {}

    const sourceEntity = await resolveTelegramCloneEntity(
      client,
      source,
      "source"
    )
    const destinationEntity =
      await resolveTelegramCloneEntity(
        client,
        destination,
        "destination"
      )

    const [sourceInspection, destinationInspection] =
      await Promise.all([
        inspectTelegramCloneEntity(
          client,
          sourceEntity,
          copy.photo !== false
        ),
        inspectTelegramCloneEntity(
          client,
          destinationEntity,
          false
        ),
      ])

    const preview = buildTelegramClonePreview(
      sourceInspection,
      destinationInspection
    )

    const { Api } = require("telegram")
    const destinationInput =
      await client.getInputEntity(destinationEntity)

    const results = []

    if (copy.title !== false) {
      if (!destinationInspection.rights.can_change_info) {
        results.push({
          key: "title",
          ok: false,
          skipped: true,
          message: "Missing permission to change destination information.",
        })
      } else {
        try {
          await client.invoke(
            new Api.channels.EditTitle({
              channel: destinationInput,
              title: sourceInspection.title,
            })
          )
          results.push({ key: "title", ok: true })
        } catch (error) {
          results.push({
            key: "title",
            ok: false,
            message: error.message,
          })
        }
      }
    }

    if (copy.description !== false) {
      if (!destinationInspection.rights.can_change_info) {
        results.push({
          key: "description",
          ok: false,
          skipped: true,
          message: "Missing permission to change destination information.",
        })
      } else {
        try {
          await client.invoke(
            new Api.channels.EditAbout({
              channel: destinationInput,
              about: sourceInspection.description || "",
            })
          )
          results.push({
            key: "description",
            ok: true,
          })
        } catch (error) {
          results.push({
            key: "description",
            ok: false,
            message: error.message,
          })
        }
      }
    }

    if (copy.photo !== false) {
      if (!destinationInspection.rights.can_change_info) {
        results.push({
          key: "photo",
          ok: false,
          skipped: true,
          message: "Missing permission to change destination information.",
        })
      } else if (!sourceInspection.photo_available) {
        results.push({
          key: "photo",
          ok: false,
          skipped: true,
          message: "The source has no profile photo.",
        })
      } else {
        try {
          const photoResult =
            await applyTelegramClonePhoto(
              client,
              destinationInput,
              sourceInspection.photo_buffer
            )
          results.push({
            key: "photo",
            ...photoResult,
          })
        } catch (error) {
          results.push({
            key: "photo",
            ok: false,
            message: error.message,
          })
        }
      }
    }

    if (
      sourceInspection.type === "supergroup" &&
      copy.permissions !== false
    ) {
      if (!destinationInspection.rights.can_ban_users) {
        results.push({
          key: "permissions",
          ok: false,
          skipped: true,
          message: "Missing permission to manage destination member permissions.",
        })
      } else {
        try {
          const permissionResult =
            await applyTelegramClonePermissions(
              client,
              destinationInput,
              sourceInspection.default_banned_rights
            )
          results.push({
            key: "permissions",
            ...permissionResult,
          })
        } catch (error) {
          results.push({
            key: "permissions",
            ok: false,
            message: error.message,
          })
        }
      }
    }


    if (
      sourceInspection.type === "supergroup" &&
      (sourceInspection.settings.forum_mode === true ||
        sourceInspection.topics.length > 0) &&
      copy.topics !== false
    ) {
      if (!destinationInspection.rights.can_manage_topics) {
        results.push({
          key: "topics",
          ok: false,
          skipped: true,
          message:
            "Missing permission to manage Topics in the destination.",
        })
      } else {
        try {
          const forumResult =
            await ensureDestinationForumEnabled(
              client,
              destinationInput,
              destinationInspection.entity
            )

          results.push({
            key: "forum_mode",
            ok: true,
            message: forumResult.already_enabled
              ? "Topics were already enabled."
              : "Topics enabled on destination.",
          })

          const topicCloneResult =
            await cloneTelegramForumTopics(
              client,
              destinationInput,
              sourceInspection.topics
            )

          results.push(...topicCloneResult.results)
        } catch (error) {
          results.push({
            key: "topics",
            ok: false,
            message: error.message,
          })
        }
      }
    }

    return res.json({
      ok: results.some((item) => item.ok),
      preview,
      results,
    })
  } catch (error) {
    console.error("Telegram clone apply error:", error)
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.get("/api/listings/newest-safe", async (req, res) => {
  try {
    const { data: listing, error } = await supabaseAdmin
      .from("channel_listings")
      .select(`
        id,
        channel_name,
        telegram_title,
        telegram_username,
        telegram_link,
        description,
        telegram_description,
        member_count,
        icon_url,
        image_url,
        listing_type,
        short_invite,
        created_at
      `)
      .eq("status", "approved")
      .or("is_banned.is.null,is_banned.eq.false")
      .or("is_nsfw.is.null,is_nsfw.eq.false")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    if (!listing) {
      return res.status(404).json({
        error: "No safe listing is currently available.",
      })
    }

    return res.json({
      ok: true,
      listing: {
        ...listing,
        url: listing.short_invite
          ? `https://telehub.to/channel/${encodeURIComponent(
                listing.short_invite
            )}`
          : listing.telegram_link,
      },
    })
  } catch (err) {
    console.error("Newest safe listing error:", err)

    return res.status(500).json({
      error: err.message || "Could not load the newest listing.",
    })
  }
})

async function inspectMtProtoSource(session, sourceReference, options = {}) {
  const { Api } = require("telegram")
  const client = await createMtProtoClient(session.mtproto_session_encrypted)
  try {
    if (!(await client.checkAuthorization())) {
      const error = new Error("Connect your Telegram account before selecting a source.")
      error.statusCode = 401
      throw error
    }

    const reference = cleanTelegramSourceReference(sourceReference)
    if (!reference) {
      const error = new Error("Paste a public or joined Telegram channel/group link.")
      error.statusCode = 400
      throw error
    }

    const entity = await client.getEntity(reference)
    if (!entity || entity.className !== "Channel") {
      const error = new Error("The source must be a Telegram channel or supergroup.")
      error.statusCode = 400
      throw error
    }

    const input = await client.getInputEntity(entity)
    const fullResult = await client.invoke(new Api.channels.GetFullChannel({ channel: input }))
    const full = fullResult.fullChat || {}
    const chat = (fullResult.chats || []).find(
      (item) => String(item.id) === String(entity.id)
    ) || entity

    let photoBuffer = null
    if (options.includePhoto && chat.photo && chat.photo.className !== "ChatPhotoEmpty") {
      try {
        photoBuffer = await client.downloadProfilePhoto(entity, { isBig: true })
      } catch (photoError) {
        console.warn("Could not download MTProto source photo:", photoError.message)
      }
    }

    const sourceType = chat.broadcast ? "channel" : "supergroup"
    return {
      chat_type: sourceType,
      title: chat.title || "Telegram Community",
      username: chat.username || null,
      description: full.about || "",
      photo_available: Boolean(chat.photo && chat.photo.className !== "ChatPhotoEmpty"),
      photo_buffer: photoBuffer,
      permissions: sourceType === "supergroup" ? mtAllowedPermissions(chat.defaultBannedRights) : null,
      manual: [
        { key: "slow_mode", label: "Slow mode", value: Number(full.slowmodeSeconds || 0) },
        { key: "protected_content", label: "Content protection", value: chat.noforwards === true },
        { key: "forum_mode", label: "Forum/topics mode", value: chat.forum === true },
        { key: "linked_chat", label: "Linked discussion chat", value: full.linkedChatId ? String(full.linkedChatId) : null },
        { key: "visible_history", label: "History hidden for new members", value: chat.defaultBannedRights?.viewMessages === true },
        { key: "anti_spam", label: "Aggressive anti-spam", value: full.antispam === true },
        { key: "auto_delete", label: "Message auto-delete", value: Number(full.ttlPeriod || 0) },
      ],
      admin_presets: [],
      admin_note: "Administrator roles are not exposed unless the connected account is an administrator of the source.",
    }
  } finally {
    await safelyDisconnectMt(client)
  }
}

async function inspectDestinationChat(chatId) {
  const bot = await getTelegramBotIdentity()
  const [chat, botMember] = await Promise.all([
    tg("getChat", { chat_id: chatId }),
    tg("getChatMember", { chat_id: chatId, user_id: bot.id }),
  ])
  const chatType = normalizeTemplateChatType(chat.type)
  if (!chatType) throw new Error("Destination must be a Telegram channel or supergroup.")
  if (botMember.status !== "administrator") {
    throw new Error("@teleg_sync_bot must be an administrator in the destination.")
  }
  return {
    chat,
    chat_type: chatType,
    bot_member: botMember,
    bot_permissions: serializeBotPermissions(botMember),
  }
}

function buildMtTemplatePreview(source, destinationInspection) {
  const destination = destinationInspection.chat
  if (source.chat_type !== destinationInspection.chat_type) {
    throw new Error("Source and destination must both be channels or both be supergroups.")
  }

  const automatic = [
    {
      key: "title",
      label: "Name",
      supported: destinationInspection.bot_permissions.can_change_info === true,
      source_value: source.title || "",
      destination_value: destination.title || "",
    },
    {
      key: "description",
      label: "Description",
      supported: destinationInspection.bot_permissions.can_change_info === true,
      source_value: source.description || "",
      destination_value: destination.description || "",
    },
    {
      key: "photo",
      label: "Profile photo",
      supported:
        destinationInspection.bot_permissions.can_change_info === true &&
        source.photo_available === true,
      source_value: source.photo_available ? "Source photo detected" : "No source photo",
      destination_value: destination.photo?.big_file_id ? "Destination has a photo" : "No destination photo",
    },
  ]

  if (source.chat_type === "supergroup") {
    automatic.push({
      key: "permissions",
      label: "Default member permissions",
      supported:
        destinationInspection.bot_permissions.can_restrict_members === true &&
        Boolean(source.permissions),
      source_value: source.permissions,
      destination_value: destination.permissions || null,
    })
  }

  return {
    source: {
      title: source.title,
      username: source.username,
      type: source.chat_type,
    },
    destination: {
      id: String(destination.id),
      title: destination.title,
      username: destination.username || null,
      type: destinationInspection.chat_type,
    },
    automatic,
    admin_presets: source.admin_presets,
    admin_note: source.admin_note,
    manual: source.manual,
  }
}

async function setDestinationPhotoFromBuffer(destinationChatId, photoBuffer) {
  if (!photoBuffer || !photoBuffer.length) {
    return { ok: false, skipped: true, reason: "Source photo could not be downloaded." }
  }
  const form = new FormData()
  form.append("chat_id", String(destinationChatId))
  form.append("photo", new Blob([photoBuffer], { type: "image/jpeg" }), "telegram-source-photo.jpg")
  const response = await fetch(`${TELEGRAM_API}/setChatPhoto`, { method: "POST", body: form })
  const json = await response.json()
  if (!json.ok) throw new Error(json.description || "Could not copy the profile photo.")
  return { ok: true }
}

function filterChatPermissions(permissions) {
  if (!permissions || typeof permissions !== "object") return null
  const keys = [
    "can_send_messages",
    "can_send_audios",
    "can_send_documents",
    "can_send_photos",
    "can_send_videos",
    "can_send_video_notes",
    "can_send_voice_notes",
    "can_send_polls",
    "can_send_other_messages",
    "can_add_web_page_previews",
    "can_change_info",
    "can_invite_users",
    "can_pin_messages",
    "can_manage_topics",
  ]
  return Object.fromEntries(keys.map((key) => [key, permissions[key] === true]))
}

app.post("/api/telegram-template/session", async (req, res) => {
  try {
    const rawToken = createTemplateToken()
    const tokenHash = hashTemplateToken(rawToken)
    let connectionCode = createTemplateConnectionCode()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data: existing } = await supabaseAdmin
        .from("telegram_template_sessions")
        .select("id")
        .eq("connection_code", connectionCode)
        .maybeSingle()
      if (!existing) break
      connectionCode = createTemplateConnectionCode()
    }

    const expiresAt = new Date(
      Date.now() + TELEGRAM_TEMPLATE_SESSION_TTL_HOURS * 60 * 60 * 1000
    ).toISOString()
    const { data: session, error } = await supabaseAdmin
      .from("telegram_template_sessions")
      .insert({
        session_token_hash: tokenHash,
        connection_code: connectionCode,
        expires_at: expiresAt,
        mtproto_auth_status: "disconnected",
      })
      .select("id, connection_code, expires_at")
      .single()
    if (error) throw error

    return res.json({
      ok: true,
      session_token: rawToken,
      connection_code: session.connection_code,
      expires_at: session.expires_at,
    })
  } catch (err) {
    console.error("Telegram template session error:", err)
    return res.status(500).json({ error: err.message })
  }
})

app.get("/api/telegram-template/auth/status", async (req, res) => {
  try {
    const session = await requireTemplateSession(req)
    return res.json({
      ok: true,
      status: session.mtproto_auth_status || "disconnected",
      connected: session.mtproto_auth_status === "connected",
      telegram_user: session.mtproto_user_json || null,
    })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.post("/api/telegram-template/auth/send-code", async (req, res) => {
  let client
  try {
    const session = await requireTemplateSession(req)
    const phoneNumber = String(req.body?.phone_number || "").trim()
    if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
      return res.status(400).json({ error: "Enter the phone number in international format, such as +16025551234." })
    }

    client = await createMtProtoClient("")
    const sent = await client.sendCode(
      { apiId: TELEGRAM_MT_API_ID, apiHash: TELEGRAM_MT_API_HASH },
      phoneNumber
    )
    const serialized = client.session.save()
    await updateTemplateSession(session.id, {
      mtproto_session_encrypted: encryptTemplateSecret(serialized),
      mtproto_phone_encrypted: encryptTemplateSecret(phoneNumber),
      mtproto_phone_code_hash_encrypted: encryptTemplateSecret(sent.phoneCodeHash),
      mtproto_auth_status: "code_sent",
      mtproto_user_json: null,
    })

    return res.json({ ok: true, status: "code_sent", delivery: sent.isCodeViaApp ? "telegram" : "sms" })
  } catch (err) {
    console.error("Telegram MTProto send-code error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-template/auth/verify-code", async (req, res) => {
  let client
  try {
    const { Api } = require("telegram")
    const session = await requireTemplateSession(req)
    const phoneCode = String(req.body?.code || "").replace(/\s+/g, "").trim()
    if (!phoneCode) return res.status(400).json({ error: "Enter the Telegram login code." })
    if (!session.mtproto_session_encrypted || !session.mtproto_phone_encrypted || !session.mtproto_phone_code_hash_encrypted) {
      return res.status(400).json({ error: "Request a new Telegram login code first." })
    }

    client = await createMtProtoClient(session.mtproto_session_encrypted)
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: decryptTemplateSecret(session.mtproto_phone_encrypted),
          phoneCodeHash: decryptTemplateSecret(session.mtproto_phone_code_hash_encrypted),
          phoneCode,
        })
      )
    } catch (signInError) {
      const message = String(signInError?.errorMessage || signInError?.message || "")
      if (message.includes("SESSION_PASSWORD_NEEDED")) {
        await updateTemplateSession(session.id, {
          mtproto_session_encrypted: encryptTemplateSecret(client.session.save()),
          mtproto_auth_status: "password_needed",
        })
        return res.json({ ok: true, status: "password_needed", password_needed: true })
      }
      throw signInError
    }

    const me = await client.getMe()
    await updateTemplateSession(session.id, {
      mtproto_session_encrypted: encryptTemplateSecret(client.session.save()),
      mtproto_phone_code_hash_encrypted: null,
      mtproto_auth_status: "connected",
      mtproto_user_json: {
        id: String(me.id),
        username: me.username || null,
        first_name: me.firstName || null,
        last_name: me.lastName || null,
      },
    })
    return res.json({ ok: true, status: "connected", connected: true })
  } catch (err) {
    console.error("Telegram MTProto verify-code error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-template/auth/verify-password", async (req, res) => {
  let client
  try {
    const session = await requireTemplateSession(req)
    const password = String(req.body?.password || "")
    if (!password) return res.status(400).json({ error: "Enter your Telegram two-step verification password." })
    if (!session.mtproto_session_encrypted) return res.status(400).json({ error: "Telegram login session not found." })

    client = await createMtProtoClient(session.mtproto_session_encrypted)
    await client.signInWithPassword(
      { apiId: TELEGRAM_MT_API_ID, apiHash: TELEGRAM_MT_API_HASH },
      {
        password: async () => password,
        onError: async (error) => {
          throw error
        },
      }
    )
    const me = await client.getMe()
    await updateTemplateSession(session.id, {
      mtproto_session_encrypted: encryptTemplateSecret(client.session.save()),
      mtproto_phone_code_hash_encrypted: null,
      mtproto_auth_status: "connected",
      mtproto_user_json: {
        id: String(me.id),
        username: me.username || null,
        first_name: me.firstName || null,
        last_name: me.lastName || null,
      },
    })
    return res.json({ ok: true, status: "connected", connected: true })
  } catch (err) {
    console.error("Telegram MTProto verify-password error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-template/auth/disconnect", async (req, res) => {
  let client
  try {
    const session = await requireTemplateSession(req)
    if (session.mtproto_session_encrypted) {
      try {
        client = await createMtProtoClient(session.mtproto_session_encrypted)
        if (await client.checkAuthorization()) await client.invoke(new (require("telegram").Api.auth.LogOut)({}))
      } catch (logoutError) {
        console.warn("Telegram remote logout warning:", logoutError.message)
      }
    }
    await updateTemplateSession(session.id, {
      mtproto_session_encrypted: null,
      mtproto_phone_encrypted: null,
      mtproto_phone_code_hash_encrypted: null,
      mtproto_auth_status: "disconnected",
      mtproto_user_json: null,
    })
    return res.json({ ok: true, status: "disconnected" })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})



async function requireTelehubUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim()
  if (!token) {
    const error = new Error("Sign in to continue.")
    error.statusCode = 401
    throw error
  }

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) {
    const authError = new Error("Your session is invalid or expired.")
    authError.statusCode = 401
    throw authError
  }
  return user
}

async function getTelegramAccountConnection(userId) {
  const { data, error } = await supabaseAdmin
    .from("telegram_account_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function upsertTelegramAccountConnection(userId, values) {
  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin
    .from("telegram_account_connections")
    .upsert({ user_id: userId, ...values, updated_at: now, last_used_at: now }, { onConflict: "user_id" })
    .select("*")
    .single()
  if (error) throw error
  return data
}

function publicTelegramConnection(connection) {
  return {
    connected: connection?.auth_status === "connected",
    status: connection?.auth_status || "disconnected",
    telegram_user: connection?.auth_status === "connected" ? {
      id: connection.telegram_user_id || null,
      username: connection.telegram_username || null,
      first_name: connection.telegram_first_name || null,
      last_name: connection.telegram_last_name || null,
    } : null,
  }
}

app.get("/api/profile", async (req, res) => {
  try {
    const user = await requireTelehubUser(req)
    const { data: existing, error: readError } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle()
    if (readError) throw readError

    let profile = existing
    if (!profile) {
      const suggested = String(user.user_metadata?.username || "")
        .replace(/[^A-Za-z0-9_]/g, "")
        .slice(0, 30)
      const { data, error } = await supabaseAdmin
        .from("profiles")
        .insert({ id: user.id, username: suggested.length >= 3 ? suggested : null })
        .select("*")
        .single()
      if (error) throw error
      profile = data
    }

    return res.json({
      ok: true,
      profile: { ...profile, email: user.email || null },
    })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.post("/api/profile/username", async (req, res) => {
  try {
    const user = await requireTelehubUser(req)
    const username = String(req.body?.username || "").trim()
    if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3–30 letters, numbers, or underscores." })
    }

    const { data: taken, error: takenError } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .ilike("username", username)
      .neq("id", user.id)
      .maybeSingle()
    if (takenError) throw takenError
    if (taken) return res.status(409).json({ error: "That username is already taken." })

    const now = new Date().toISOString()
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .upsert({ id: user.id, username, updated_at: now }, { onConflict: "id" })
      .select("*")
      .single()
    if (error) throw error

    await supabaseAdmin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...(user.user_metadata || {}), username },
    })

    return res.json({ ok: true, profile: { ...profile, email: user.email || null } })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.get("/api/profile/favorites", async (req, res) => {
  try {
    const user = await requireTelehubUser(req)
    const { data, error } = await supabaseAdmin
      .from("listing_favorites")
      .select(`
        listing_id,
        created_at,
        listing:channel_listings (
          id,
          channel_name,
          telegram_title,
          description,
          telegram_description,
          icon_url,
          image_url,
          telegram_link,
          listing_type,
          member_count,
          votes_count,
          short_invite,
          categories,
          paid_rank,
          status,
          is_banned
        )
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
    if (error) throw error

    const favorites = (data || []).filter((item) => item.listing && item.listing.status === "approved" && !item.listing.is_banned)
    return res.json({ ok: true, favorites })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.post("/api/profile/favorites/toggle", async (req, res) => {
  try {
    const user = await requireTelehubUser(req)
    const listingId = String(req.body?.listing_id || "").trim()
    if (!listingId) return res.status(400).json({ error: "Missing listing_id." })

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select("id, status, is_banned")
      .eq("id", listingId)
      .maybeSingle()
    if (listingError) throw listingError
    if (!listing || listing.status !== "approved" || listing.is_banned) {
      return res.status(404).json({ error: "Listing not found." })
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("listing_favorites")
      .select("id")
      .eq("user_id", user.id)
      .eq("listing_id", listingId)
      .maybeSingle()
    if (existingError) throw existingError

    if (existing) {
      const { error } = await supabaseAdmin.from("listing_favorites").delete().eq("id", existing.id)
      if (error) throw error
      return res.json({ ok: true, favorited: false })
    }

    const { error } = await supabaseAdmin
      .from("listing_favorites")
      .insert({ user_id: user.id, listing_id: listingId })
    if (error) throw error
    return res.json({ ok: true, favorited: true })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.delete("/api/profile/favorites/:listingId", async (req, res) => {
  try {
    const user = await requireTelehubUser(req)
    const { error } = await supabaseAdmin
      .from("listing_favorites")
      .delete()
      .eq("user_id", user.id)
      .eq("listing_id", req.params.listingId)
    if (error) throw error
    return res.json({ ok: true })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.get("/api/telegram-account/status", async (req, res) => {
  try {
    const user = await requireTelehubUser(req)
    const connection = await getTelegramAccountConnection(user.id)
    return res.json({ ok: true, ...publicTelegramConnection(connection) })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.post("/api/telegram-account/send-code", async (req, res) => {
  let client
  try {
    const user = await requireTelehubUser(req)
    const phoneNumber = String(req.body?.phone_number || "").trim()
    if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
      return res.status(400).json({ error: "Enter a valid international phone number, such as +16025551234." })
    }

    client = await createMtProtoClient("")
    const sent = await client.sendCode(
      { apiId: TELEGRAM_MT_API_ID, apiHash: TELEGRAM_MT_API_HASH },
      phoneNumber
    )

    await upsertTelegramAccountConnection(user.id, {
      encrypted_mtproto_session: encryptTemplateSecret(client.session.save()),
      encrypted_phone_number: encryptTemplateSecret(phoneNumber),
      encrypted_phone_code_hash: encryptTemplateSecret(sent.phoneCodeHash),
      auth_status: "code_sent",
      telegram_user_id: null,
      telegram_username: null,
      telegram_first_name: null,
      telegram_last_name: null,
      connected_at: null,
    })

    return res.json({ ok: true, status: "code_sent" })
  } catch (err) {
    console.error("Persistent Telegram send-code error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-account/verify-code", async (req, res) => {
  let client
  try {
    const { Api } = require("telegram")
    const user = await requireTelehubUser(req)
    const connection = await getTelegramAccountConnection(user.id)
    const phoneCode = String(req.body?.code || "").replace(/\s+/g, "").trim()
    if (!phoneCode) return res.status(400).json({ error: "Enter the Telegram login code." })
    if (!connection?.encrypted_mtproto_session || !connection?.encrypted_phone_number || !connection?.encrypted_phone_code_hash) {
      return res.status(400).json({ error: "Request a new Telegram login code first." })
    }

    client = await createMtProtoClient(connection.encrypted_mtproto_session)
    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: decryptTemplateSecret(connection.encrypted_phone_number),
        phoneCodeHash: decryptTemplateSecret(connection.encrypted_phone_code_hash),
        phoneCode,
      }))
    } catch (signInError) {
      const message = String(signInError?.errorMessage || signInError?.message || "")
      if (message.includes("SESSION_PASSWORD_NEEDED")) {
        await upsertTelegramAccountConnection(user.id, {
          encrypted_mtproto_session: encryptTemplateSecret(client.session.save()),
          auth_status: "password_needed",
        })
        return res.json({ ok: true, status: "password_needed", password_needed: true })
      }
      throw signInError
    }

    const me = await client.getMe()
    const connectionData = await upsertTelegramAccountConnection(user.id, {
      encrypted_mtproto_session: encryptTemplateSecret(client.session.save()),
      encrypted_phone_code_hash: null,
      auth_status: "connected",
      telegram_user_id: String(me.id),
      telegram_username: me.username || null,
      telegram_first_name: me.firstName || null,
      telegram_last_name: me.lastName || null,
      connected_at: new Date().toISOString(),
    })

    return res.json({ ok: true, ...publicTelegramConnection(connectionData) })
  } catch (err) {
    console.error("Persistent Telegram verify-code error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-account/verify-password", async (req, res) => {
  let client
  try {
    const user = await requireTelehubUser(req)
    const connection = await getTelegramAccountConnection(user.id)
    const password = String(req.body?.password || "")
    if (!password) return res.status(400).json({ error: "Enter your Telegram two-step verification password." })
    if (!connection?.encrypted_mtproto_session) return res.status(400).json({ error: "Telegram login session not found." })

    client = await createMtProtoClient(connection.encrypted_mtproto_session)
    await client.signInWithPassword(
      { apiId: TELEGRAM_MT_API_ID, apiHash: TELEGRAM_MT_API_HASH },
      { password: async () => password, onError: async (error) => { throw error } }
    )

    const me = await client.getMe()
    const connectionData = await upsertTelegramAccountConnection(user.id, {
      encrypted_mtproto_session: encryptTemplateSecret(client.session.save()),
      encrypted_phone_code_hash: null,
      auth_status: "connected",
      telegram_user_id: String(me.id),
      telegram_username: me.username || null,
      telegram_first_name: me.firstName || null,
      telegram_last_name: me.lastName || null,
      connected_at: new Date().toISOString(),
    })

    return res.json({ ok: true, ...publicTelegramConnection(connectionData) })
  } catch (err) {
    console.error("Persistent Telegram verify-password error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})

app.post("/api/telegram-account/disconnect", async (req, res) => {
  let client
  try {
    const user = await requireTelehubUser(req)
    const connection = await getTelegramAccountConnection(user.id)

    if (connection?.encrypted_mtproto_session) {
      try {
        client = await createMtProtoClient(connection.encrypted_mtproto_session)
        if (await client.checkAuthorization()) {
          const { Api } = require("telegram")
          await client.invoke(new Api.auth.LogOut({}))
        }
      } catch (logoutError) {
        console.warn("Persistent Telegram logout warning:", logoutError.message)
      }
    }

    await upsertTelegramAccountConnection(user.id, {
      encrypted_mtproto_session: null,
      encrypted_phone_number: null,
      encrypted_phone_code_hash: null,
      auth_status: "disconnected",
      telegram_user_id: null,
      telegram_username: null,
      telegram_first_name: null,
      telegram_last_name: null,
      connected_at: null,
    })

    return res.json({ ok: true, connected: false, status: "disconnected" })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  } finally {
    await safelyDisconnectMt(client)
  }
})



app.get("/api/telegram-template/chats", async (req, res) => {
  try {
    const session = await requireTemplateSession(req)
    const { data: chats, error } = await supabaseAdmin
      .from("telegram_template_chats")
      .select("*")
      .eq("session_id", session.id)
      .order("connected_at", { ascending: true })
    if (error) throw error

    const verifiedChats = []
    for (const savedChat of chats || []) {
      try {
        const inspection = await inspectDestinationChat(savedChat.telegram_chat_id)
        const now = new Date().toISOString()
        await supabaseAdmin
          .from("telegram_template_chats")
          .update({
            title: inspection.chat.title || savedChat.title,
            username: inspection.chat.username || null,
            chat_type: inspection.chat_type,
            bot_status: inspection.bot_member.status,
            bot_permissions: inspection.bot_permissions,
            last_verified_at: now,
          })
          .eq("id", savedChat.id)
        verifiedChats.push({
          ...savedChat,
          title: inspection.chat.title || savedChat.title,
          username: inspection.chat.username || null,
          chat_type: inspection.chat_type,
          bot_status: inspection.bot_member.status,
          bot_permissions: inspection.bot_permissions,
          last_verified_at: now,
        })
      } catch (chatError) {
        verifiedChats.push({ ...savedChat, bot_status: "unavailable", verification_error: chatError.message })
      }
    }

    return res.json({
      ok: true,
      connection_code: session.connection_code,
      expires_at: session.expires_at,
      auth_status: session.mtproto_auth_status || "disconnected",
      telegram_user: session.mtproto_user_json || null,
      chats: verifiedChats,
    })
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.post("/api/telegram-template/preview", async (req, res) => {
  try {
    const session = await requireTemplateSession(req)
    const { source_link, destination_chat_id } = req.body || {}
    if (!source_link || !destination_chat_id) {
      return res.status(400).json({ error: "Paste a source link and choose a destination." })
    }
    if (session.mtproto_auth_status !== "connected") {
      return res.status(401).json({ error: "Connect your Telegram account first." })
    }

    const destinationSaved = await getTemplateConnectedChat(session.id, destination_chat_id)
    if (!destinationSaved) return res.status(404).json({ error: "Destination chat was not found." })

    const [source, destinationInspection] = await Promise.all([
      inspectMtProtoSource(session, source_link),
      inspectDestinationChat(destinationSaved.telegram_chat_id),
    ])
    return res.json({ ok: true, preview: buildMtTemplatePreview(source, destinationInspection) })
  } catch (err) {
    console.error("Telegram template preview error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.post("/api/telegram-template/apply", async (req, res) => {
  try {
    const session = await requireTemplateSession(req)
    const { source_link, destination_chat_id } = req.body || {}
    if (!source_link || !destination_chat_id) {
      return res.status(400).json({ error: "Paste a source link and choose a destination." })
    }
    if (session.mtproto_auth_status !== "connected") {
      return res.status(401).json({ error: "Connect your Telegram account first." })
    }

    const destinationSaved = await getTemplateConnectedChat(session.id, destination_chat_id)
    if (!destinationSaved) return res.status(404).json({ error: "Destination chat was not found." })

    const [source, destinationInspection] = await Promise.all([
      inspectMtProtoSource(session, source_link, { includePhoto: true }),
      inspectDestinationChat(destinationSaved.telegram_chat_id),
    ])
    const preview = buildMtTemplatePreview(source, destinationInspection)
    const destinationId = destinationInspection.chat.id
    const results = []

    async function runSetting(key, label, work) {
      try {
        await work()
        results.push({ key, label, ok: true })
      } catch (settingError) {
        results.push({ key, label, ok: false, error: settingError.message })
      }
    }

    if (destinationInspection.bot_permissions.can_change_info) {
      await runSetting("title", "Name", () =>
        tg("setChatTitle", { chat_id: destinationId, title: source.title })
      )
      await runSetting("description", "Description", () =>
        tg("setChatDescription", { chat_id: destinationId, description: source.description || "" })
      )
      if (source.photo_available && source.photo_buffer) {
        await runSetting("photo", "Profile photo", () =>
          setDestinationPhotoFromBuffer(destinationId, source.photo_buffer)
        )
      } else {
        results.push({ key: "photo", label: "Profile photo", ok: false, skipped: true, error: "No downloadable source photo was available." })
      }
    } else {
      for (const [key, label] of [["title", "Name"], ["description", "Description"], ["photo", "Profile photo"]]) {
        results.push({ key, label, ok: false, skipped: true, error: "Bot needs permission to change chat information." })
      }
    }

    if (source.chat_type === "supergroup" && source.permissions) {
      if (destinationInspection.bot_permissions.can_restrict_members) {
        await runSetting("permissions", "Default member permissions", () =>
          tg("setChatPermissions", {
            chat_id: destinationId,
            permissions: filterChatPermissions(source.permissions),
            use_independent_chat_permissions: true,
          })
        )
      } else {
        results.push({ key: "permissions", label: "Default member permissions", ok: false, skipped: true, error: "Bot needs permission to restrict members." })
      }
    }

    const successful = results.filter((item) => item.ok).length
    const failed = results.filter((item) => !item.ok && !item.skipped).length
    const skipped = results.filter((item) => item.skipped).length
    return res.json({
      ok: failed === 0,
      successful,
      failed,
      skipped,
      results,
      admin_presets: preview.admin_presets,
      admin_note: preview.admin_note,
      manual: preview.manual,
    })
  } catch (err) {
    console.error("Telegram template apply error:", err)
    return res.status(err.statusCode || 500).json({ error: err.message })
  }
})

async function handleTelegramTemplateConnection(update) {
  const message = update.message || update.channel_post
  const chat = update.my_chat_member?.chat || message?.chat
  if (!chat) return false
  const normalizedType = normalizeTemplateChatType(chat.type)
  if (!normalizedType) return false

  const text = String(message?.text || message?.caption || "").trim()
  const codeMatch = text.match(/(?:^|\s)(TH-\d{6})(?:\s|$)/i)
  if (!codeMatch) return false
  const connectionCode = codeMatch[1].toUpperCase()
  const now = new Date().toISOString()

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("telegram_template_sessions")
    .select("*")
    .eq("connection_code", connectionCode)
    .gt("expires_at", now)
    .maybeSingle()
  if (sessionError) throw sessionError
  if (!session) return false

  const inspection = await inspectDestinationChat(chat.id)
  const { error: upsertError } = await supabaseAdmin
    .from("telegram_template_chats")
    .upsert(
      {
        session_id: session.id,
        telegram_chat_id: String(chat.id),
        title: inspection.chat.title || chat.title || "Telegram Community",
        username: inspection.chat.username || chat.username || null,
        chat_type: inspection.chat_type,
        bot_status: inspection.bot_member.status,
        bot_permissions: inspection.bot_permissions,
        connected_by_telegram_user_id: message?.from?.id ? String(message.from.id) : null,
        connected_at: now,
        last_verified_at: now,
      },
      { onConflict: "session_id,telegram_chat_id" }
    )
  if (upsertError) throw upsertError

  if (message?.message_id && inspection.bot_permissions.can_delete_messages) {
    try {
      await tg("deleteMessage", { chat_id: chat.id, message_id: message.message_id })
    } catch (deleteError) {
      console.warn("Could not remove Telegram template verification message:", deleteError.message)
    }
  }
  return true
}

app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const configuredSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim()
    const receivedSecret = String(req.headers["x-telegram-bot-api-secret-token"] || "")
    if (configuredSecret && receivedSecret !== configuredSecret) {
      return res.status(401).json({ error: "Invalid Telegram webhook secret." })
    }

    const update = req.body || {}
    try {
      const connected = await handleTelegramTemplateConnection(update)
      if (connected) return res.json({ ok: true, template_connected: true })
    } catch (templateError) {
      console.error("Telegram template connection error:", templateError)
    }

    const chat = update.my_chat_member?.chat || update.message?.chat || update.channel_post?.chat
    if (!chat) return res.json({ ok: true })
    const username = cleanUsername(chat.username)
    if (!username) return res.json({ ok: true, message: "Bot detected chat, but no public username found." })

    const { data: listings } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .or(`telegram_username.eq.${username},telegram_link.ilike.%${username.replace("@", "")}%`)
    for (const listing of listings || []) {
      await syncListingTelegramData({
        ...listing,
        telegram_chat_id: String(chat.id),
        telegram_username: username,
      })
    }
    return res.json({ ok: true })
  } catch (err) {
    console.error("Telegram webhook error:", err)
    return res.status(500).json({ error: err.message })
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
      listing_type: result.listingType,
    })
  } catch (err) {
    console.error("Manual sync error:", err)
    res.status(500).json({ error: err.message })
  }
})






app.post("/api/admin/test-telegram-scrape", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "")
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim()
    const cronSecret = String(req.body?.secret || req.query?.secret || "")
    const listingId = String(req.body?.listing_id || "").trim()
    const telegramLink = String(req.body?.telegram_link || "").trim()

    let authorized = false

    if (cronSecret && cronSecret === process.env.CRON_SECRET) {
      authorized = true
    }

    if (!authorized && bearerToken) {
      const {
        data: { user },
      } = await supabaseAdmin.auth.getUser(bearerToken)

      const email = String(user?.email || "").toLowerCase()
      authorized = Boolean(user && ADMIN_EMAILS.includes(email))
    }

    if (!authorized) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    let listing = null

    if (listingId) {
      const { data, error } = await supabaseAdmin
        .from("channel_listings")
        .select(
          "id, channel_name, telegram_username, telegram_link, telegram_chat_id"
        )
        .eq("id", listingId)
        .single()

      if (error || !data) {
        return res.status(404).json({ error: "Listing not found." })
      }

      listing = data
    } else if (telegramLink) {
      listing = {
        id: "scrape-test",
        channel_name: "Scrape test",
        telegram_link: telegramLink,
        telegram_username: extractUsernameFromLink(telegramLink),
        telegram_chat_id: null,
      }
    } else {
      return res.status(400).json({
        error: "Provide listing_id or telegram_link.",
      })
    }

    const scraped = await fetchPublicTelegramPage(listing)

    console.log("Manual Telegram scrape test succeeded:", {
      listing_id: listing.id,
      username: scraped.telegramUsername,
      member_count: scraped.memberCount,
      source: scraped.source,
      raw_display: scraped.rawDisplay,
    })

    return res.json({
      ok: true,
      used_bot_api: false,
      scraped,
    })
  } catch (err) {
    console.error("Manual Telegram scrape test failed:", {
      code: err.code,
      error: err.message,
      status: err.status,
    })

    return res.status(err.status || 500).json({
      ok: false,
      error: err.message,
      code: err.code || "TME_SCRAPE_TEST_FAILED",
    })
  }
})

const TELEGRAM_METADATA_REFRESH_COOLDOWN_MS = Math.max(
  60 * 60 * 1000,
  Number(
    process.env.TELEGRAM_METADATA_REFRESH_COOLDOWN_MS ||
      24 * 60 * 60 * 1000
  )
)

app.post("/api/listings/refresh-telegram-info", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "")
    const token = authHeader.replace(/^Bearer\s+/i, "").trim()
    const listingId = String(req.body?.listing_id || "").trim()

    if (!token) {
      return res.status(401).json({ error: "You must be logged in." })
    }

    if (!listingId) {
      return res.status(400).json({ error: "Missing listing_id." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid login session." })
    }

    const { data: listing, error: listingError } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("id", listingId)
      .single()

    if (listingError || !listing) {
      return res.status(404).json({ error: "Listing not found." })
    }

    const email = String(user.email || "").toLowerCase()
    const isAdmin = ADMIN_EMAILS.includes(email)

    if (listing.user_id !== user.id && !isAdmin) {
      return res.status(403).json({ error: "You do not own this listing." })
    }

    const lastMetadataSync = listing.telegram_metadata_synced_at
      ? new Date(listing.telegram_metadata_synced_at).getTime()
      : 0
    const nextAllowedAt =
      lastMetadataSync + TELEGRAM_METADATA_REFRESH_COOLDOWN_MS

    if (
      !isAdmin &&
      Number.isFinite(lastMetadataSync) &&
      lastMetadataSync > 0 &&
      Date.now() < nextAllowedAt
    ) {
      return res.status(429).json({
        error: "Telegram info can be refreshed once every 24 hours.",
        code: "TELEGRAM_METADATA_REFRESH_COOLDOWN",
        next_allowed_at: new Date(nextAllowedAt).toISOString(),
      })
    }

    await syncListingTelegramData(listing)

    const framerResult = await queueFramerSync(() =>
      syncListingToFramerCMS(listing.id, {
        publish: true,
        skipTelegramSync: true,
      })
    )

    const { data: refreshedListing, error: refreshedError } =
      await supabaseAdmin
        .from("channel_listings")
        .select(
          "id, telegram_title, telegram_username, telegram_description, telegram_chat_id, icon_url, member_count, listing_type, last_synced_at, telegram_metadata_synced_at, last_member_scraped_at, last_metadata_scraped_at, last_icon_scraped_at, scrape_source, scrape_failure_count"
        )
        .eq("id", listing.id)
        .single()

    if (refreshedError) throw refreshedError

    updateHomepageListingCache().catch((cacheErr) => {
      console.error(
        "Homepage cache refresh after Telegram info refresh failed:",
        cacheErr
      )
    })

    return res.json({
      ok: true,
      listing: refreshedListing,
      framer: framerResult,
    })
  } catch (err) {
    console.error("Owner Telegram info refresh failed:", err)

    if (err?.code === "TELEGRAM_RATE_LIMITED") {
      return res.status(429).json({
        error: err.message,
        code: err.code,
        retry_after_seconds: Number(err.retry_after_seconds || 0),
      })
    }

    return res.status(500).json({
      error: err.message || "Could not refresh Telegram info.",
    })
  }
})

app.post("/api/telegram/sync-hourly", async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const result = await runHourlyTelegramSync()
    return res.json(result)
  } catch (err) {
    console.error("Hourly sync error:", err)
    return res.status(500).json({ error: err.message })
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

    // Sync Telegram data, then create/update the Framer CMS page.
    await syncListingTelegramData(listing)
    const framerResult = await queueFramerSync(() => syncListingToFramerCMS(listing.id))

    res.json({ ok: true, framer: framerResult })
  } catch (err) {
    console.error("Approve listing error:", err)
    res.status(500).json({ error: err.message })
  }
})



async function fetchMemberSnapshotsInBatches(listingIds, since) {
  const ids = Array.from(new Set((listingIds || []).filter(Boolean)))
  const batchSize = 100
  const allSnapshots = []

  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize)

    const { data, error } = await supabaseAdmin
      .from("channel_member_snapshots")
      .select("listing_id, member_count, created_at")
      .in("listing_id", batch)
      .gte("created_at", since)
      .order("created_at", { ascending: true })

    if (error) throw error
    allSnapshots.push(...(data || []))
  }

  return allSnapshots
}

app.get("/api/listings/ranked", async (req, res) => {
  try {
    const { data: listings, error: listingsError } = await supabaseAdmin
      .from("channel_listings")
      .select("*")
      .eq("status", "approved")
      .eq("is_banned", false)

    if (listingsError) throw listingsError

    const listingIds = (listings || []).map((item) => item.id)

    let snapshots = []

    if (listingIds.length > 0) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

      snapshots = await fetchMemberSnapshotsInBatches(listingIds, since)
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

app.get("/api/listings/homepage-static", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("homepage_listing_cache")
      .select("listings, updated_at")
      .eq("id", "homepage_top_18")
      .maybeSingle()

    if (error) throw error

    res.set("Cache-Control", "public, max-age=300, s-maxage=3600")

    return res.json({
      ok: true,
      cached: true,
      listings: data?.listings || [],
      updated_at: data?.updated_at || null,
    })
  } catch (err) {
    console.error("Homepage static listings error:", err)

    return res.status(500).json({
      ok: false,
      error: err.message,
      listings: [],
    })
  }
})


app.get("/api/cron/update-homepage-cache", async (req, res) => {
  try {
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const result = await updateHomepageListingCache()

    return res.json({
      ok: true,
      count: result.listings.length,
      updated_at: result.updated_at,
    })
  } catch (err) {
    console.error("Update homepage cache error:", err)

    return res.status(500).json({
      ok: false,
      error: err.message,
    })
  }
})


app.get("/api/listings/homepage", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || 18, 1),
      30
    )

    // Reuse your ranked listings logic
    const { data: listings, error: listingsError } =
      await supabaseAdmin
        .from("channel_listings")
        .select("*")
        .eq("status", "approved")
        .eq("is_banned", false)

    if (listingsError) throw listingsError

    const listingIds = (listings || []).map((item) => item.id)

    let snapshots = []

    if (listingIds.length > 0) {
      const since = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString()

      snapshots = await fetchMemberSnapshotsInBatches(listingIds, since)
    }

    const snapshotsByListing = {}

    snapshots.forEach((snapshot) => {
      if (!snapshotsByListing[snapshot.listing_id]) {
        snapshotsByListing[snapshot.listing_id] = []
      }

      snapshotsByListing[snapshot.listing_id].push(snapshot)
    })

    const listingsWithGrowth = (listings || []).map((listing) => {
      const listingSnapshots =
        snapshotsByListing[listing.id] || []

      const firstSnapshot = listingSnapshots[0]
      const latestSnapshot =
        listingSnapshots[listingSnapshots.length - 1]

      const oldMembers = Number(
        firstSnapshot?.member_count ||
          listing.member_count ||
          0
      )

      const latestMembers = Number(
        latestSnapshot?.member_count ||
          listing.member_count ||
          0
      )

      const memberGrowth24h = Math.max(
        0,
        latestMembers - oldMembers
      )

      return {
        ...listing,
        member_growth_24h: memberGrowth24h,
      }
    })

    const maxStats = {
      maxVotes: Math.max(
        1,
        ...listingsWithGrowth.map((item) =>
          Number(item.votes_count || 0)
        )
      ),
      maxGrowth: Math.max(
        1,
        ...listingsWithGrowth.map((item) =>
          Number(item.member_growth_24h || 0)
        )
      ),
    }

    const homepageListings = listingsWithGrowth
      .map((listing) => ({
        ...listing,
        ...calculateRankingScore(listing, maxStats),
      }))
      .sort((a, b) => {
        if (b.ranking_score !== a.ranking_score) {
          return b.ranking_score - a.ranking_score
        }

        return (
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
        )
      })
      .slice(0, limit)

    return res.json({
      ok: true,
      listings: homepageListings,
    })
  } catch (err) {
    console.error("Homepage listings error:", err)
    return res.status(500).json({
      error: err.message,
    })
  }
})



app.get("/api/widgets/preview", async (req, res) => {
  try {
    const link = String(req.query.link || "").trim()

    if (!link) {
      return res.status(400).json({ error: "Missing Telegram link" })
    }

    const username = extractUsernameFromLink(link)

    if (!username) {
      return res.status(400).json({
        error: "This widget currently supports public t.me usernames only.",
      })
    }

    const chat = await tg("getChat", { chat_id: username })
    const memberCount = await tg("getChatMemberCount", { chat_id: chat.id })

    let iconUrl = null

    if (chat.photo?.big_file_id) {
      const file = await tg("getFile", { file_id: chat.photo.big_file_id })
      iconUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`
    }

    const listingType = normalizeTelegramType(chat.type)

    if (!listingType) {
      return res.status(400).json({
        error: "We could not detect whether this is a Telegram group or channel.",
      })
    }

    return res.json({
      ok: true,
      title: chat.title || username,
      username: cleanUsername(chat.username),
      description: chat.description || chat.bio || "",
      member_count: memberCount,
      icon_url: iconUrl,
      telegram_link: link,
      listing_type: listingType,
      theme_color: "#229ED9",
    })
  } catch (err) {
    console.error("Widget preview error:", err)
    return res.status(500).json({ error: err.message })
  }
})



app.get("/api/telegram/sync-hourly", async (req, res) => {
  try {
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const result = await runHourlyTelegramSync()
    return res.json(result)
  } catch (err) {
    console.error("Hourly sync error:", err)
    return res.status(500).json({ error: err.message })
  }
})




// ========================================
// ADMIN AI TELEGRAM LISTING IMPORT
// ========================================

const DEFAULT_ADMIN_IMPORT_LIMIT = 20
const MAX_ADMIN_IMPORT_LIMIT = 20
const ADMIN_IMPORT_DELAY_MS = Math.max(
  500,
  Number(process.env.ADMIN_IMPORT_DELAY_MS || 1500)
)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
const OPENAI_IMPORT_MODEL = process.env.OPENAI_IMPORT_MODEL || "gpt-4o-mini"
const IMPORT_CATEGORY_FALLBACKS = [
  "Crypto",
  "Gaming",
  "Technology",
  "Trading",
  "Finance",
  "Education",
  "Startups",
  "News",
  "Business",
  "Community",
  "Investing",
  "AI",
  "Marketing",
  "Entertainment",
  "Sports",
]

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "0a908330-be3d-44ad-af73-c7113fa1e41d,f63dca60-e46c-494d-9909-a4554b2ae904,eb65ec8c-ced2-4f25-807e-6a733aa75f08")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)

function isBackendAdminUser(user) {
  if (!user) return false
  const email = String(user.email || "").toLowerCase()
  return ADMIN_EMAILS.includes(email) || ADMIN_USER_IDS.includes(user.id)
}

function cleanImportTelegramLink(value) {
  let trimmed = String(value || "").trim()

  if (!trimmed) return ""

  // Allow users to paste links with commas, bullets, or extra spaces.
  trimmed = trimmed
    .replace(/^[-*•]+\s*/, "")
    .replace(/[),.;]+$/g, "")
    .trim()

  if (trimmed.startsWith("@")) {
    trimmed = `https://t.me/${trimmed.replace("@", "")}`
  }

  if (trimmed.startsWith("t.me/")) {
    trimmed = `https://${trimmed}`
  }

  trimmed = trimmed
    .replace("http://t.me/", "https://t.me/")
    .replace("https://telegram.me/", "https://t.me/")
    .replace("http://telegram.me/", "https://t.me/")
    .replace("https://t.me/s/", "https://t.me/")
    .replace(/\/+$/g, "")

  return trimmed
}


function normalizeTelegramLinkForComparison(value) {
  const cleaned = cleanImportTelegramLink(value)
  if (!cleaned) return ""

  const username = extractUsernameFromLink(cleaned)
  if (username) {
    return `https://t.me/${String(username).replace(/^@/, "").toLowerCase()}`
  }

  return cleaned
    .split("#")[0]
    .split("?")[0]
    .replace(/\/+$/g, "")
    .toLowerCase()
}

function parseTelegramImportLinks(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,]+/g)
        .map((item) => item.trim())

  return uniqueValues(rawItems.map(cleanImportTelegramLink))
}

function slugifyImportValue(value) {
  return cleanCmsSlug(value || "telegram-listing") || "telegram-listing"
}

async function generateUniqueShortInviteFromBase(baseValue) {
  const base = slugifyImportValue(baseValue).slice(0, 24) || "telegram-listing"
  let candidate = base
  let counter = 2

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("channel_listings")
      .select("id")
      .eq("short_invite", candidate)
      .maybeSingle()

    if (error) throw error
    if (!data) return candidate

    const suffix = `-${counter}`
    candidate = `${base.slice(0, 24 - suffix.length)}${suffix}`
    counter += 1
  }
}

function makeImportFallbackCategories(text, listingType) {
  const lower = String(text || "").toLowerCase()
  const matches = []

  const tests = [
    ["Crypto", ["crypto", "bitcoin", "ethereum", "solana", "memecoin", "airdrop", "web3", "token", "coin"]],
    ["Trading", ["trading", "forex", "stocks", "signals", "options", "market", "invest"]],
    ["Gaming", ["gaming", "game", "minecraft", "valorant", "cs2", "fortnite", "roblox", "xbox", "playstation"]],
    ["Technology", ["tech", "software", "app", "android", "ios", "developer", "coding"]],
    ["AI", ["ai", "artificial intelligence", "chatgpt", "bot", "automation"]],
    ["Education", ["learn", "education", "course", "study", "school", "language"]],
    ["Marketing", ["marketing", "smm", "growth", "promotion", "traffic"]],
    ["Business", ["business", "startup", "entrepreneur", "sales", "ecommerce"]],
    ["News", ["news", "updates", "announcements"]],
    ["Entertainment", ["movie", "music", "anime", "memes", "fun", "media"]],
  ]

  for (const [category, keywords] of tests) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      matches.push(category)
    }
  }

  if (!matches.length) matches.push(listingType === "group" ? "Community" : "News")
  if (!matches.includes("Telegram")) matches.push("Telegram")

  return matches.slice(0, 5)
}

function capWords(value, maxWords) {
  const words = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)

  if (words.length <= maxWords) return words.join(" ")
  return words.slice(0, maxWords).join(" ")
}

function sanitizeAiImportContent(raw, fallback) {
  const source = raw && typeof raw === "object" ? raw : {}

  let displayName = String(
    source.display_name ||
    source.displayName ||
    fallback.display_name ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()

  let description = String(
    source.description ||
    fallback.description ||
    ""
  ).trim()

  let longDescription = String(
    source.long_description ||
    source.longDescription ||
    fallback.long_description ||
    ""
  ).trim()

  let categories = Array.isArray(source.categories)
    ? source.categories
    : fallback.categories

  categories = uniqueValues(
    (categories || [])
      .map((cat) => String(cat || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((cat) => cat.charAt(0).toUpperCase() + cat.slice(1))
  ).slice(0, 5)

  if (!displayName) displayName = fallback.display_name
  if (!categories.length) categories = fallback.categories
  if (!description) description = fallback.description
  if (!longDescription) longDescription = fallback.long_description

  // Keep generated names readable in cards and Framer CMS.
  displayName = displayName
    .replace(/[|•—–:/]\s*[|•—–:/]+/g, " • ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 95)

  description = capWords(description, 250)

  longDescription = longDescription
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000)

  return {
    display_name: displayName,
    description,
    long_description: longDescription,
    categories,
    is_nsfw: source.is_nsfw === true,
  }
}

function fallbackImportContent({
  title,
  username,
  telegramDescription,
  memberCount,
  listingType,
}) {
  const typeLabel = listingType === "group" ? "group" : "channel"
  const sourceName =
    String(title || "").trim() ||
    stripTelegramHandle(username) ||
    "Telegram Community"

  const displayName = sourceName
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 95)

  const baseText = [title, username, telegramDescription]
    .filter(Boolean)
    .join(" ")

  const categories = makeImportFallbackCategories(baseText, listingType)

  const memberText = memberCount
    ? `${Number(memberCount).toLocaleString()} members`
    : "a growing audience"

  const description = telegramDescription
    ? String(telegramDescription).replace(/\s+/g, " ").slice(0, 240)
    : `${displayName} is a Telegram ${typeLabel} with ${memberText}, listed on TeleHub for easier discovery.`

  const longDescription = telegramDescription
    ? `${telegramDescription}\n\nBrowse the listing for its Telegram link, categories, member count, and other available community details before deciding whether it fits what you are looking for.`
    : `${displayName} is a Telegram ${typeLabel} listed on TeleHub. Browse its public Telegram link, member count, categories, and available community information before joining.`

  return {
    display_name: displayName,
    description: capWords(description, 250),
    long_description: longDescription.slice(0, 2000),
    categories,
    is_nsfw: false,
  }
}

async function generateAiImportContent(input) {
  const fallback = fallbackImportContent(input)

  const creativeProfiles = [
    {
      name: "clean_minimal",
      title_style:
        "Use a clean name plus one useful descriptor. No emoji and no keyword ribbon.",
      tone: "simple, confident, human",
      description_shape:
        "one compact sentence with no sales language",
      emoji_budget: "none",
      formatting_style: "plain sentence",
    },
    {
      name: "discadia_ribbon",
      title_style:
        "Use the recognizable name followed by 3 to 7 supported topics separated by a pipe and bullets.",
      tone: "energetic directory listing",
      description_shape:
        "a lively keyword-rich paragraph with short fragments",
      emoji_budget: "moderate",
      formatting_style: "pipe and bullet rhythm",
    },
    {
      name: "emoji_burst",
      title_style:
        "Use one relevant emoji in the title and a compact supported descriptor.",
      tone: "playful and energetic",
      description_shape:
        "two or three punchy fragments with varied emoji placement",
      emoji_budget: "expressive",
      formatting_style: "emoji-led fragments",
    },
    {
      name: "friendly_invite",
      title_style:
        "Use a friendly community-focused title without keyword stuffing.",
      tone: "warm, casual, welcoming",
      description_shape:
        "a natural invitation that sounds written by a community owner",
      emoji_budget: "minimal",
      formatting_style: "conversational paragraph",
    },
    {
      name: "feature_stack",
      title_style:
        "Keep the recognizable name and add a short supported feature phrase.",
      tone: "fast, useful, direct",
      description_shape:
        "stack 3 to 6 supported benefits or topics using bullets, dashes, or separators",
      emoji_budget: "moderate",
      formatting_style: "feature stack",
    },
    {
      name: "question_hook",
      title_style:
        "Use a short modern title with at most one separator.",
      tone: "curious and conversational",
      description_shape:
        "open with a question, then answer it naturally",
      emoji_budget: "minimal",
      formatting_style: "question and answer",
    },
    {
      name: "niche_expert",
      title_style:
        "Lead with the exact niche and work the original name into the title naturally.",
      tone: "specific, informed, restrained",
      description_shape:
        "topic-first explanation with concrete supported details",
      emoji_budget: "none",
      formatting_style: "informational",
    },
    {
      name: "social_hangout",
      title_style:
        "Create a lively social title using only supported activities or interests.",
      tone: "friendly, social, casual",
      description_shape:
        "short invitation plus a list-like second sentence",
      emoji_budget: "expressive",
      formatting_style: "social promo",
    },
    {
      name: "news_flash",
      title_style:
        "Use a direct topic-and-updates title with no decorative filler.",
      tone: "current, concise, informative",
      description_shape:
        "a headline-like opening followed by a clear summary",
      emoji_budget: "minimal",
      formatting_style: "headline summary",
    },
    {
      name: "brand_only",
      title_style:
        "Keep the original recognizable brand name nearly unchanged.",
      tone: "minimal, polished, understated",
      description_shape:
        "one short sentence or two tiny sentences",
      emoji_budget: "none",
      formatting_style: "brand card",
    },
    {
      name: "chaotic_fun",
      title_style:
        "Use a playful title with one supported phrase and optional emoji.",
      tone: "internet-native, fun, informal",
      description_shape:
        "use energetic fragments, varied punctuation, and a casual voice",
      emoji_budget: "expressive",
      formatting_style: "chaotic but readable",
    },
    {
      name: "resource_board",
      title_style:
        "Use the name plus supported resources, guides, discussion, updates, or media.",
      tone: "organized and helpful",
      description_shape:
        "benefit-first paragraph with a compact supported topic list",
      emoji_budget: "moderate",
      formatting_style: "resource summary",
    },
  ]

  const creativeProfile =
    creativeProfiles[Math.floor(Math.random() * creativeProfiles.length)]

  const variationSeed = Math.random().toString(36).slice(2, 10)

  if (!process.env.OPENAI_API_KEY) {
    return {
      ...fallback,
      ai_used: false,
      ai_error: "OPENAI_API_KEY is not set; used fallback content.",
      creative_profile: creativeProfile.name,
    }
  }

  try {
    const prompt = {
      telegram_title: input.title || "",
      telegram_username: input.username || "",
      telegram_description: input.telegramDescription || "",
      member_count: Number(input.memberCount || 0),
      listing_type: input.listingType || "channel",
      recent_public_posts: Array.isArray(input.recentPosts)
        ? input.recentPosts.slice(0, 20)
        : [],
      post_context_source: input.postContextSource || null,
      creative_profile: creativeProfile,
      variation_seed: variationSeed,
    }

    const systemPrompt = `
You create highly varied, natural directory listings for TeleHub, a Telegram channel and group discovery website.

The visual energy may resemble modern community-directory cards such as Discadia, but every result must be original, grounded in the Telegram source, and not copied from any example.

Follow the supplied creative_profile exactly. Each listing must feel as though a different person wrote it.

Return ONLY one valid JSON object:
{
  "display_name": string,
  "description": string,
  "long_description": string,
  "categories": string[],
  "is_nsfw": boolean
}

SOURCE GROUNDING

Use only:
- Telegram title
- Telegram username
- Telegram description or bio
- member count
- listing type
- recent public post text, when supplied
- creative_profile

Do not invent unsupported:
- active voice chat
- giveaways
- contests
- events
- staff activity
- moderation quality
- official status
- safety or trust
- discounts or pricing
- delivery speed
- bonuses
- rankings
- specific games, topics, resources, or features absent from the source

Broadly rephrasing an obvious topic is allowed. Fabricating a feature is not.

RECENT PUBLIC POSTS

Recent public post text is optional evidence from Telegram's public web preview.
Use repeated themes across posts to improve categories and explain what the community actually discusses.
Do not treat a one-off post as a permanent feature unless the profile description or multiple posts support it.
Do not quote long passages, usernames, phone numbers, wallet addresses, invite codes, or tracking links.
Do not claim that the recent posts are complete chat history.

DISPLAY NAME

Create an appealing card title, not merely a raw Telegram title.

Rules:
- preserve a recognizable part of the original name when possible
- 2 to 10 words or short phrases
- maximum 95 characters
- use only supported topics
- follow creative_profile.title_style
- vary separators between listings
- some titles should be plain
- some may use |
- some may use —
- some may use •
- some may use :
- some may use no separator
- never use more than two separator types in one title
- never force a keyword ribbon when the profile does not call for it

Possible structural inspiration:
- Name | Topic • Chat • Updates
- 🎮 Name — Gaming Community
- Name: News, Media & Discussion
- Topic Hub • Guides • Community
- Name only

Do not copy these examples word-for-word.

EMOJI VARIETY

Follow creative_profile.emoji_budget:
- none: 0 emojis
- minimal: 0 or 1 emoji across title and description
- moderate: 1 to 4 emojis across title and description
- expressive: 2 to 7 emojis across title and description

Vary placement:
- title only
- description only
- middle of a phrase
- end of a phrase
- no emoji

Do not always begin with an emoji. Do not use the same emoji repeatedly.

SHORT DESCRIPTION

description may contain 0 to 250 words, but it should usually be 12 to 70 words so it fits naturally on a directory card.

The description may be:
- one compact sentence
- two short sentences
- a short paragraph
- a question and answer
- a feature stack
- a keyword-rich community pitch
- punchy fragments separated by bullets, pipes, dashes, or emojis
- a clean factual summary
- an informal owner-style invitation

Make the rhythm visibly different across listings.

Allowed stylistic variety includes:
- sentence fragments
- selective capitalization
- tasteful emoji clusters
- short lists
- topic ribbons
- casual questions
- direct audience calls
- headline-like phrasing

Do not repeatedly begin with:
Join
Discover
Welcome to
Stay updated
Looking for
This is
A Telegram
Your go-to
Whether you're
Explore
Dive into

Do not repeatedly end with:
Join today
Check it out
Don't miss out
Everything in one place
Become part of the community

Do not use generic AI phrases:
vibrant community
like-minded individuals
valuable insights
engaging content
dynamic platform
perfect place
one-stop destination
something for everyone
thriving community
curated content

Do not force the description to use all available words. Empty descriptions are technically allowed only when the source contains almost no useful information, but a concise grounded line is strongly preferred.

LONG DESCRIPTION

long_description should usually be 80 to 220 words in 1 to 4 short paragraphs.

It should explain:
- the main topic
- what users may reasonably expect
- the likely audience
- why the listing may be useful or entertaining

Vary paragraph count and opening structure. Do not repeat the short description verbatim.

CATEGORIES

Return 2 to 5 short Title Case categories.
Put the most specific category first.
Avoid duplicates and near-duplicates.
Do not use Telegram as a category unless the channel is specifically about Telegram.

NSFW

Set is_nsfw to true only when clearly adult, sexually explicit, pornographic, drug-focused, gambling-focused, or strongly mature.

FINAL SILENT CHECK

Before returning:
- confirm all claims are source-supported
- confirm the title follows its assigned profile
- confirm emoji count fits the budget
- confirm the description structure is not generic
- confirm the short and long descriptions are different
- confirm valid JSON with all five fields

Return only the JSON object.
`.trim()

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_IMPORT_MODEL,
          response_format: { type: "json_object" },
          temperature: 1.05,
          presence_penalty: 0.85,
          frequency_penalty: 0.65,
          max_tokens: 1400,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: JSON.stringify(prompt),
            },
          ],
        }),
      }
    )

    const json = await response.json()

    if (!response.ok) {
      throw new Error(
        json?.error?.message ||
        "OpenAI request failed"
      )
    }

    const content =
      json?.choices?.[0]?.message?.content || "{}"

    const parsed = JSON.parse(content)
    const sanitized = sanitizeAiImportContent(parsed, fallback)

    return {
      ...sanitized,
      ai_used: true,
      ai_error: null,
      creative_profile: creativeProfile.name,
      variation_seed: variationSeed,
      usage: json?.usage || null,
    }
  } catch (err) {
    console.error(
      "AI import content generation failed:",
      err.message
    )

    return {
      ...fallback,
      ai_used: false,
      ai_error: err.message,
      creative_profile: creativeProfile.name,
      variation_seed: variationSeed,
    }
  }
}

async function findDuplicateImportListing({ telegramChatId, telegramUsername, telegramLink }) {
  const checks = []

  if (telegramChatId) checks.push(["telegram_chat_id", String(telegramChatId)])
  if (telegramUsername) checks.push(["telegram_username", telegramUsername])
  if (telegramLink) checks.push(["telegram_link", telegramLink])

  for (const [field, value] of checks) {
    const { data, error } = await supabaseAdmin
      .from("channel_listings")
      .select("id, channel_name, short_invite, telegram_link, telegram_username, telegram_chat_id")
      .eq(field, value)
      .limit(1)
      .maybeSingle()

    if (error) throw error
    if (data) return data
  }

  return null
}


// ========================================
// IMPORT LANGUAGE FILTER HELPERS
// ========================================

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

function countScriptLetters(value) {
  const counts = {
    latin: 0,
    cyrillic: 0,
    arabic: 0,
    hebrew: 0,
    greek: 0,
    other: 0,
  }

  for (const char of String(value || "")) {
    if (!/\p{L}/u.test(char)) continue

    if (/\p{Script=Latin}/u.test(char)) counts.latin += 1
    else if (/\p{Script=Cyrillic}/u.test(char)) counts.cyrillic += 1
    else if (/\p{Script=Arabic}/u.test(char)) counts.arabic += 1
    else if (/\p{Script=Hebrew}/u.test(char)) counts.hebrew += 1
    else if (/\p{Script=Greek}/u.test(char)) counts.greek += 1
    else counts.other += 1
  }

  counts.total =
    counts.latin +
    counts.cyrillic +
    counts.arabic +
    counts.hebrew +
    counts.greek +
    counts.other

  counts.non_latin = counts.total - counts.latin
  return counts
}

function analyzeLikelyEnglishListingContent({ title, description }) {
  const cleanTitle = cleanText(title)
  const cleanDescription = cleanText(description)
  const titleScripts = countScriptLetters(cleanTitle)
  const combinedScripts = countScriptLetters(
    `${cleanTitle} ${cleanDescription}`
  )

  if (titleScripts.total > 0 && titleScripts.latin === 0) {
    return {
      isEnglish: false,
      reason: "telegram_title_is_fully_non_latin",
      title_scripts: titleScripts,
      combined_scripts: combinedScripts,
    }
  }

  if (
    combinedScripts.total >= 20 &&
    combinedScripts.non_latin >= 15 &&
    combinedScripts.non_latin / combinedScripts.total >= 0.8
  ) {
    return {
      isEnglish: false,
      reason: "telegram_content_is_overwhelmingly_non_latin",
      title_scripts: titleScripts,
      combined_scripts: combinedScripts,
    }
  }

  return {
    isEnglish: true,
    ambiguous: true,
    reason: "latin_or_mixed_listing_allowed",
    title_scripts: titleScripts,
    combined_scripts: combinedScripts,
  }
}

async function importSingleTelegramListing(
  link,
  options,
  adminUser,
  onStage = async () => {}
) {
  const telegramLink = cleanImportTelegramLink(link)

  if (!telegramLink) {
    return { ok: false, link, error: "Empty link." }
  }

  const username = extractUsernameFromLink(telegramLink)

  if (!username) {
    return {
      ok: false,
      link: telegramLink,
      error: "Only public t.me usernames can be imported automatically.",
    }
  }

  const publicListingInput = {
    telegram_username: username,
    telegram_link: telegramLink,
  }

  let scraped = null
  let chat = null
  let profileSource = null
  let scrapeError = null

  try {
    scraped = await fetchPublicTelegramPage(publicListingInput)
    profileSource = scraped.source
  } catch (err) {
    scrapeError = err
    console.warn("AI import public profile scrape failed; trying Bot API:", {
      link: telegramLink,
      code: err.code,
      error: err.message,
    })

    chat = await tg("getChat", { chat_id: username })
    profileSource = "telegram_bot_api_fallback"
  }

  const listingType = scraped
    ? scraped.listingType
    : normalizeTelegramType(chat?.type)

  if (!listingType) {
    return {
      ok: false,
      link: telegramLink,
      error: "Could not detect whether this Telegram link is a group or channel.",
    }
  }

  const telegramUsername = scraped
    ? scraped.telegramUsername
    : cleanUsername(chat?.username) || username

  const normalizedTelegramLink = scraped
    ? scraped.telegramLink
    : chat?.username
      ? `https://t.me/${chat.username}`
      : telegramLink

  const telegramTitle =
    scraped?.title ||
    chat?.title ||
    stripTelegramHandle(telegramUsername) ||
    "Telegram Listing"

  const telegramDescription =
    scraped?.description ||
    chat?.description ||
    chat?.bio ||
    ""

  const telegramChatId = chat?.id ? String(chat.id) : null
  const memberCount = scraped
    ? Number(scraped.memberCount || 0)
    : await tg("getChatMemberCount", { chat_id: chat.id })

  const avatarAvailable = Boolean(
    scraped?.iconUrl || chat?.photo?.big_file_id
  )

  await onStage("telegram_verified", {
    telegram_username: telegramUsername,
    telegram_title: telegramTitle,
    telegram_description: telegramDescription,
    listing_type: listingType,
    telegram_chat_id: telegramChatId,
    avatar_available: avatarAvailable,
    metadata_source: profileSource,
    scrape_error: scrapeError?.message || null,
  })

  const duplicate = await findDuplicateImportListing({
    telegramChatId,
    telegramUsername,
    telegramLink: normalizedTelegramLink,
  })

  if (duplicate) {
    return {
      ok: true,
      skipped: true,
      reason: "duplicate",
      link: normalizedTelegramLink,
      existing_listing_id: duplicate.id,
      existing_name: duplicate.channel_name,
      existing_short_invite: duplicate.short_invite,
      metadata_source: profileSource,
    }
  }

  let postContext = {
    posts: [],
    postCount: 0,
    contextText: "",
    imageUrls: [],
    imageCount: 0,
    source: null,
  }
  let postContextError = null

  try {
    postContext = await fetchPublicTelegramPostContext(publicListingInput)
  } catch (err) {
    postContextError = err
    console.warn("AI import public post-context scrape failed:", {
      link: normalizedTelegramLink,
      code: err.code,
      error: err.message,
    })
  }

  await onStage("telegram_metadata", {
    telegram_username: telegramUsername,
    telegram_title: telegramTitle,
    member_count: memberCount,
    listing_type: listingType,
    avatar_available: avatarAvailable,
    metadata_source: profileSource,
    post_context_source: postContext.source,
    public_posts_found: postContext.postCount,
    public_post_images_found: postContext.imageCount || 0,
    post_context_error: postContextError?.message || null,
  })

  const languageCheck = analyzeLikelyEnglishListingContent({
    title: telegramTitle,
    description: [
      telegramDescription,
      postContext.posts.slice(0, 5).join(" "),
    ].filter(Boolean).join(" "),
  })

  if (!languageCheck.isEnglish) {
    await onStage("language_filtered", {
      telegram_username: telegramUsername,
      telegram_title: telegramTitle,
      reason: languageCheck.reason,
      language_check: languageCheck,
    })

    return {
      ok: true,
      skipped: true,
      filtered: true,
      reason: "non_english",
      error: "Listing filtered because the Telegram title is fully non-Latin or the content is overwhelmingly non-Latin.",
      link: normalizedTelegramLink,
      telegram_username: telegramUsername,
      telegram_title: telegramTitle,
      language_check: languageCheck,
      metadata_source: profileSource,
      public_posts_found: postContext.postCount,
    }
  }

  await onStage("ai_generation_started", {
    source_title: telegramTitle,
    source_description_length: telegramDescription.length,
    public_posts_found: postContext.postCount,
    post_context_characters: postContext.contextText.length,
  })

  const aiContent = await generateAiImportContent({
    title: telegramTitle,
    username: telegramUsername,
    telegramDescription,
    memberCount,
    listingType,
    recentPosts: postContext.posts,
    postContextSource: postContext.source,
  })

  await onStage("ai_generated", {
    generated_name:
      aiContent.display_name ||
      telegramTitle ||
      stripTelegramHandle(telegramUsername) ||
      "Telegram Listing",
    description: aiContent.description,
    long_description_length: String(
      aiContent.long_description || ""
    ).length,
    categories: aiContent.categories,
    is_nsfw: aiContent.is_nsfw,
    ai_used: aiContent.ai_used,
    ai_error: aiContent.ai_error || null,
    creative_profile: aiContent.creative_profile || null,
    variation_seed: aiContent.variation_seed || null,
    token_usage: aiContent.usage || null,
    metadata_source: profileSource,
    public_posts_found: postContext.postCount,
  })

  const shortInviteBase =
    stripTelegramHandle(telegramUsername) ||
    telegramTitle ||
    "telegram-listing"

  const shortInvite =
    await generateUniqueShortInviteFromBase(shortInviteBase)

  await onStage("slug_selected", {
    short_invite: shortInvite,
    public_path: `/channel/${shortInvite}`,
  })

  const now = new Date().toISOString()
  const insertPayload = {
    user_id: adminUser.id,
    listing_type: listingType,
    channel_name:
      aiContent.display_name ||
      telegramTitle ||
      stripTelegramHandle(telegramUsername) ||
      "Telegram Listing",
    telegram_link: normalizedTelegramLink,
    description: aiContent.description,
    long_description: aiContent.long_description,
    categories: aiContent.categories,
    is_nsfw: aiContent.is_nsfw,
    short_invite: shortInvite,
    slug: `${listingType}-${slugifyImportValue(telegramTitle || telegramUsername)}-${Date.now().toString().slice(-6)}`,
    status: "approved",
    admin_reviewed: false,
    telegram_chat_id: telegramChatId,
    telegram_username: telegramUsername,
    telegram_title: telegramTitle || null,
    telegram_description: telegramDescription || null,
    member_count: memberCount,
    votes_count: 0,
    last_synced_at: now,
    telegram_metadata_synced_at: now,
    last_member_scraped_at: now,
    last_metadata_scraped_at: now,
    scrape_source: profileSource,
    scrape_failure_count: 0,
    framer_sync_status: options.syncToFramer ? "not_synced" : null,
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("channel_listings")
    .insert(insertPayload)
    .select("id, short_invite")
    .single()

  if (insertError) throw insertError

  await onStage("supabase_created", {
    listing_id: inserted.id,
    channel_name: insertPayload.channel_name,
    telegram_username: telegramUsername,
    short_invite: inserted.short_invite,
    status: "approved",
    categories: aiContent.categories,
    description: aiContent.description,
    metadata_source: profileSource,
    public_posts_found: postContext.postCount,
  })

  let iconUrl = null
  let iconError = null

  try {
    if (scraped?.iconUrl) {
      iconUrl = await uploadRemoteTelegramPhoto(
        scraped.iconUrl,
        inserted.id
      )
    } else if (chat?.photo?.big_file_id) {
      iconUrl = await uploadTelegramPhoto(
        chat.photo.big_file_id,
        inserted.id
      )
    }
  } catch (err) {
    iconError = err.message
    console.error("Auto import icon upload failed:", err.message)
  }

  let backgroundResult = {
    imageUrl: null,
    source: "none",
    error: null,
  }

  try {
    backgroundResult = await chooseAndUploadImportBackground({
      mode: options.backgroundMode,
      listingId: inserted.id,
      iconUrl,
      postContext,
      aiContent,
      listingType,
      seed: `${inserted.id}:${normalizedTelegramLink}`,
    })
  } catch (err) {
    backgroundResult = {
      imageUrl: null,
      source: String(options.backgroundMode || "none"),
      error: err.message,
    }
    console.error("Auto import background selection failed:", err.message)
  }

  await onStage("listing_media_selected", {
    icon_url: iconUrl,
    image_url: backgroundResult.imageUrl,
    background_mode: options.backgroundMode,
    background_source: backgroundResult.source,
    background_error: backgroundResult.error || null,
    public_post_images_found: postContext.imageCount || 0,
    related_query: backgroundResult.query || null,
    related_provider_id: backgroundResult.providerId || null,
    metadata_source: profileSource,
  })

  if (iconUrl || backgroundResult.imageUrl) {
    const mediaUpdate = {
      icon_url: iconUrl,
      image_url: backgroundResult.imageUrl,
      updated_at: new Date().toISOString(),
    }

    if (iconUrl) {
      mediaUpdate.last_icon_scraped_at = new Date().toISOString()
    }

    const { error: imageUpdateError } = await supabaseAdmin
      .from("channel_listings")
      .update(mediaUpdate)
      .eq("id", inserted.id)

    if (imageUpdateError) throw imageUpdateError
  }

  let framerResult = null
  let framerError = null

  if (options.syncToFramer) {
    await onStage("framer_sync_started", {
      listing_id: inserted.id,
      short_invite: inserted.short_invite,
    })

    try {
      framerResult = await queueFramerSync(() =>
        syncListingToFramerCMS(inserted.id, {
          publish: false,
          skipTelegramSync: true,
        })
      )

      await onStage("framer_synced", {
        listing_id: inserted.id,
        short_invite: inserted.short_invite,
        framer_synced: Boolean(framerResult?.ok),
        public_url: `https://telehub.to/channel/${inserted.short_invite}`,
        icon_applied: Boolean(iconUrl),
        background_applied: Boolean(backgroundResult.imageUrl),
        background_source: backgroundResult.source,
        background_error: backgroundResult.error || null,
      })
    } catch (err) {
      framerError = err.message
      console.error("Auto import Framer sync failed:", err.message)

      await onStage("framer_sync_failed", {
        listing_id: inserted.id,
        short_invite: inserted.short_invite,
        error: framerError,
      })
    }
  }

  return {
    ok: true,
    created: true,
    link: normalizedTelegramLink,
    listing_id: inserted.id,
    channel_name: insertPayload.channel_name,
    short_invite: inserted.short_invite,
    url: `https://telehub.to/channel/${inserted.short_invite}`,
    listing_type: listingType,
    member_count: memberCount,
    categories: aiContent.categories,
    description: aiContent.description,
    long_description_length: String(aiContent.long_description || "").length,
    is_nsfw: aiContent.is_nsfw,
    telegram_username: telegramUsername,
    telegram_title: telegramTitle || null,
    telegram_chat_id: telegramChatId,
    avatar_available: avatarAvailable,
    metadata_source: profileSource,
    public_posts_found: postContext.postCount,
    post_context_source: postContext.source,
    post_context_error: postContextError?.message || null,
    ai_used: aiContent.ai_used,
    ai_error: aiContent.ai_error,
    creative_profile: aiContent.creative_profile || null,
    generated_display_name: aiContent.display_name,
    ai_token_usage: aiContent.usage || null,
    icon_url: iconUrl,
    icon_error: iconError,
    image_url: backgroundResult.imageUrl,
    background_mode: options.backgroundMode,
    background_source: backgroundResult.source,
    background_error: backgroundResult.error || null,
    related_background_query: backgroundResult.query || null,
    related_background_provider_id: backgroundResult.providerId || null,
    public_post_images_found: postContext.imageCount || 0,
    framer_synced: !!framerResult?.ok,
    framer_error: framerError,
  }
}

async function markManualImportQueueItemComplete(originalLink, result) {
  const cleanedOriginal = cleanImportTelegramLink(originalLink)
  const cleanedResult = cleanImportTelegramLink(result?.link || "")
  const telegramLink = cleanedResult || cleanedOriginal

  if (!telegramLink) return

  const finalStatus = result?.created
    ? "created"
    : result?.skipped
      ? "duplicate"
      : result?.ok === false
        ? "failed"
        : "completed"

  const finalStage = result?.created
    ? "completed"
    : result?.filtered
      ? "filtered"
      : result?.skipped
        ? "duplicate"
        : result?.ok === false
          ? "failed"
          : "completed"

  const updatePayload = {
    status: finalStatus,
    stage: finalStage,
    listing_id:
      result?.listing_id || result?.existing_listing_id || null,
    result: result || null,
    framer_synced: Boolean(result?.framer_synced),
    error: result?.ok === false ? result?.error || "Import failed." : null,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const candidateLinks = Array.from(
    new Set([cleanedOriginal, cleanedResult, telegramLink].filter(Boolean))
  )

  const { error } = await supabaseAdmin
    .from("scraper_queue")
    .update(updatePayload)
    .in("telegram_link", candidateLinks)
    .eq("status", "ready_for_ai")

  if (error) {
    console.error(
      "Could not mark manually imported scraper queue item complete:",
      telegramLink,
      error.message
    )
  }
}

app.post("/api/admin/import-telegram-listings", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const token = authHeader.replace("Bearer ", "")

    if (!token) {
      return res.status(401).json({ error: "Missing auth token." })
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user || !isBackendAdminUser(user)) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const links = parseTelegramImportLinks(req.body?.links || req.body?.links_text || "")
    const requestedLimit = Number(req.body?.limit || DEFAULT_ADMIN_IMPORT_LIMIT)
    const limit = Math.min(Math.max(requestedLimit || DEFAULT_ADMIN_IMPORT_LIMIT, 1), MAX_ADMIN_IMPORT_LIMIT)
    const linksToImport = links.slice(0, limit)

    if (!linksToImport.length) {
      return res.status(400).json({ error: "Paste at least one public Telegram link." })
    }

    const requestedBackgroundMode = String(
      req.body?.background_mode ||
      (req.body?.use_icon_as_background !== false ? "icon" : "none")
    ).toLowerCase()

    const allowedBackgroundModes = new Set([
      "none",
      "icon",
      "related",
      "telegram_post",
    ])

    const options = {
      syncToFramer: req.body?.sync_to_framer !== false,
      backgroundMode: allowedBackgroundModes.has(requestedBackgroundMode)
        ? requestedBackgroundMode
        : "none",
    }

    const results = []
    let rateLimit = null
    let stoppedAtIndex = null

    for (let index = 0; index < linksToImport.length; index += 1) {
      const link = linksToImport[index]

      try {
        const result = await importSingleTelegramListing(link, options, user)
        results.push(result)
        await markManualImportQueueItemComplete(link, result)
      } catch (err) {
        console.error("Auto import listing failed:", link, err)

        if (err?.code === "TELEGRAM_RATE_LIMITED") {
          rateLimit = {
            code: "TELEGRAM_RATE_LIMITED",
            retry_after_seconds: Number(err.retry_after_seconds || 0),
            telegram_method: err.telegram_method || null,
            message: err.message || "Telegram temporarily rate-limited the importer.",
          }
          stoppedAtIndex = index
          break
        }

        const failedResult = {
          ok: false,
          link,
          error: err.message || "Import failed.",
          code: err?.code || null,
        }

        results.push(failedResult)
        await markManualImportQueueItemComplete(link, failedResult)
      }

      if (index < linksToImport.length - 1) {
        await sleep(ADMIN_IMPORT_DELAY_MS)
      }
    }

    // Each item was synced with publish:false. Publish/deploy exactly once
    // after the entire import batch finishes.
    let deployed = false

    if (options.syncToFramer && process.env.FRAMER_AUTO_DEPLOY !== "false") {
      const createdNeedingDeploy = results.some((item) => item.created && item.framer_synced)

      if (createdNeedingDeploy) {
        const { connect } = await import("framer-api")
        const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY)

        try {
          const publication = await framer.publish()
          await framer.deploy(publication.deployment.id)
          deployed = true
        } finally {
          await framer.disconnect()
        }
      }
    }

    let homepageCache = null

    try {
      homepageCache = await updateHomepageListingCache()
    } catch (cacheErr) {
      console.error("Homepage cache refresh after auto import failed:", cacheErr.message)
    }

    const processedCount = results.length
    const rateLimitedRemaining = rateLimit
      ? Math.max(0, linksToImport.length - processedCount)
      : 0
    const overLimitRemaining = Math.max(0, links.length - linksToImport.length)
    const remainingNotProcessed = rateLimitedRemaining + overLimitRemaining
    const unprocessedLinks = rateLimit
      ? [
          ...linksToImport.slice(processedCount),
          ...links.slice(linksToImport.length),
        ]
      : links.slice(linksToImport.length)

    const summary = {
      total_received: links.length,
      processed: processedCount,
      created: results.filter((item) => item.created).length,
      duplicates: results.filter((item) => item.skipped).length,
      failed: results.filter((item) => item.ok === false).length,
      framer_synced: results.filter((item) => item.framer_synced).length,
      deployed,
    }

    const responsePayload = {
      ok: !rateLimit,
      ...summary,
      limit,
      import_delay_ms: ADMIN_IMPORT_DELAY_MS,
      remaining_not_processed: remainingNotProcessed,
      unprocessed_links: unprocessedLinks,
      rate_limit: rateLimit,
      code: rateLimit?.code || null,
      retry_after_seconds: rateLimit?.retry_after_seconds || 0,
      results,
      homepage_cache: homepageCache
        ? {
            updated_at: homepageCache.updated_at,
            count: homepageCache.listings.length,
          }
        : null,
    }

    if (rateLimit) {
      return res.status(429).json(responsePayload)
    }

    return res.json(responsePayload)
  } catch (err) {
    console.error("Admin Telegram import error:", err)
    return res.status(500).json({ error: err.message })
  }
})


const PORT = process.env.PORT || 3000



// ========================================
// TELEMETR DISCOVERY + PERSISTENT ROTATION
// ========================================

const SCRAPER_EVENT_LIMIT = 250
const activeTelemetrRuns = new Set()

const CONTINUOUS_AUTOMATION_ROW_ID = "global"
const CONTINUOUS_AUTOMATION_WORKER_ID =
  `render-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const CONTINUOUS_AUTOMATION_LEASE_SECONDS = Math.max(
  300,
  Number(process.env.CONTINUOUS_AUTOMATION_LEASE_SECONDS || 3600)
)
const CONTINUOUS_AUTOMATION_IDLE_MS = Math.max(
  5000,
  Number(process.env.CONTINUOUS_AUTOMATION_IDLE_MS || 15000)
)
const GRAPH_CRAWL_COOLDOWN_HOURS = Math.max(
  1,
  Number(process.env.GRAPH_CRAWL_COOLDOWN_HOURS || 168)
)
const GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS = Math.max(
  GRAPH_CRAWL_COOLDOWN_HOURS,
  Number(process.env.GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS || 720)
)

let continuousAutomationLoopPromise = null

async function getContinuousAutomationState() {
  const { data, error } = await supabaseAdmin
    .from("telehub_automation_state")
    .select("*")
    .eq("id", CONTINUOUS_AUTOMATION_ROW_ID)
    .maybeSingle()

  if (error) throw error

  return (
    data || {
      id: CONTINUOUS_AUTOMATION_ROW_ID,
      enabled: false,
      settings: {},
      current_run_id: null,
      cycle_count: 0,
    }
  )
}

async function claimContinuousAutomationLease() {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_telehub_automation_lease",
    {
      p_worker_id: CONTINUOUS_AUTOMATION_WORKER_ID,
      p_lease_seconds: CONTINUOUS_AUTOMATION_LEASE_SECONDS,
    }
  )

  if (error) throw error
  return data === true
}

async function heartbeatContinuousAutomationLease() {
  const { error } = await supabaseAdmin
    .from("telehub_automation_state")
    .update({
      last_heartbeat_at: new Date().toISOString(),
      lease_expires_at: new Date(
        Date.now() + CONTINUOUS_AUTOMATION_LEASE_SECONDS * 1000
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", CONTINUOUS_AUTOMATION_ROW_ID)
    .eq("lease_owner", CONTINUOUS_AUTOMATION_WORKER_ID)

  if (error) {
    console.warn("Continuous automation heartbeat failed:", error.message)
  }
}

async function releaseContinuousAutomationLease() {
  const { error } = await supabaseAdmin.rpc(
    "release_telehub_automation_lease",
    { p_worker_id: CONTINUOUS_AUTOMATION_WORKER_ID }
  )

  if (error) {
    console.warn("Continuous automation lease release failed:", error.message)
  }
}

async function isContinuousAutomationEnabled() {
  try {
    const state = await getContinuousAutomationState()
    return state?.enabled === true
  } catch (error) {
    console.warn("Could not read continuous automation state:", error.message)
    return false
  }
}

function continuousAutomationSettings(state) {
  const raw =
    state?.settings && typeof state.settings === "object"
      ? state.settings
      : {}

  return {
    seed_limit: Math.max(1, Math.min(Number(raw.seed_limit || 1000), 10000)),
    max_depth: Math.max(1, Math.min(Number(raw.max_depth || 2), 5)),
    max_links_per_seed: Math.max(
      1,
      Math.min(Number(raw.max_links_per_seed || 10), 100)
    ),
    request_delay_ms: Math.max(
      250,
      Math.min(Number(raw.request_delay_ms || 2000), 10000)
    ),
    target_per_cycle: Math.max(
      1,
      Math.min(Number(raw.target_per_cycle || 500), 10000)
    ),
    import_batch_size: Math.max(
      1,
      Math.min(Number(raw.import_batch_size || 20), MAX_ADMIN_IMPORT_LIMIT)
    ),
    background_mode: ["none", "icon", "related", "telegram_post"].includes(
      String(raw.background_mode || "related")
    )
      ? String(raw.background_mode || "related")
      : "related",
    sync_to_framer: raw.sync_to_framer !== false,
    cycle_delay_ms: Math.max(
      5000,
      Math.min(Number(raw.cycle_delay_ms || CONTINUOUS_AUTOMATION_IDLE_MS), 300000)
    ),
    crawl_cooldown_hours: Math.max(
      1,
      Number(raw.crawl_cooldown_hours || GRAPH_CRAWL_COOLDOWN_HOURS)
    ),
    empty_crawl_cooldown_hours: Math.max(
      1,
      Number(raw.empty_crawl_cooldown_hours || GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS)
    ),
  }
}

async function loadGraphCrawlHistory(normalizedLinks) {
  const links = Array.from(
    new Set((normalizedLinks || []).filter(Boolean))
  )

  const byLink = new Map()

  for (let index = 0; index < links.length; index += 200) {
    const batch = links.slice(index, index + 200)
    const { data, error } = await supabaseAdmin
      .from("telegram_graph_crawl_history")
      .select(
        "normalized_link, telegram_username, last_crawled_at, last_success_at, last_result_count, last_verified_count, last_new_count, crawl_count, last_status"
      )
      .in("normalized_link", batch)

    if (error) throw error

    for (const row of data || []) {
      byLink.set(row.normalized_link, row)
    }
  }

  return byLink
}

function graphHistoryEligible(history, settings, nowMs = Date.now()) {
  if (!history?.last_crawled_at) return true

  const last = new Date(history.last_crawled_at).getTime()
  if (!Number.isFinite(last)) return true

  const productive = Number(history.last_verified_count || 0) > 0
  const cooldownHours = productive
    ? Number(settings.crawl_cooldown_hours || GRAPH_CRAWL_COOLDOWN_HOURS)
    : Number(
        settings.empty_crawl_cooldown_hours ||
          GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS
      )

  return nowMs - last >= cooldownHours * 60 * 60 * 1000
}

async function recordGraphCrawlHistory({
  seedLink,
  seedUsername,
  rawCandidates = 0,
  verifiedCount = 0,
  newCount = 0,
  status = "completed",
  error = null,
}) {
  const normalizedLink = normalizeTelegramLinkForComparison(seedLink)
  if (!normalizedLink) return

  const { data: previous, error: previousError } = await supabaseAdmin
    .from("telegram_graph_crawl_history")
    .select("crawl_count")
    .eq("normalized_link", normalizedLink)
    .maybeSingle()

  if (previousError) {
    console.warn("Could not read graph crawl history:", previousError.message)
  }

  const now = new Date().toISOString()
  const payload = {
    normalized_link: normalizedLink,
    telegram_username: String(
      seedUsername || extractUsernameFromLink(seedLink) || ""
    )
      .replace(/^@/, "")
      .toLowerCase() || null,
    last_crawled_at: now,
    last_result_count: Number(rawCandidates || 0),
    last_verified_count: Number(verifiedCount || 0),
    last_new_count: Number(newCount || 0),
    crawl_count: Number(previous?.crawl_count || 0) + 1,
    last_status: status,
    last_error: error ? String(error).slice(0, 2000) : null,
    updated_at: now,
    ...(verifiedCount > 0 ? { last_success_at: now } : {}),
  }

  const { error: upsertError } = await supabaseAdmin
    .from("telegram_graph_crawl_history")
    .upsert(payload, { onConflict: "normalized_link" })

  if (upsertError) {
    console.warn("Could not save graph crawl history:", upsertError.message)
  }
}


async function getAdminUserFromRequest(req) {
  const authHeader = String(req.headers.authorization || "")
  const token = authHeader.replace(/^Bearer\s+/i, "").trim()

  if (!token) return null

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token)

  if (error || !user || !isBackendAdminUser(user)) return null
  return user
}

const TELEMETR_ROTATION_COUNTRIES = [
  "usa","afghanistan","algeria","argentina","armenia","australia","austria",
  "azerbaijan","bahrain","bangladesh","belarus","bolivia",
  "bosnia_and_herzegovina","brazil","bulgaria","cambodia","cameroon","canada",
  "chile","china","colombia","costa_rica","croatia","czech_republic",
  "dominican_republic","ecuador","egypt","salvador","estonia","ethiopia",
  "finland","france","georgia","germany","greece","guatemala","haiti",
  "honduras","india","indonesia","international","iran","iraq","israel",
  "italy","ivory_coast","japan","jordan","kazakhstan","kenya","korea",
  "kyrgyzstan","latvia","lebanon","libya","lithuania","malaysia","mexico",
  "moldova","mongolia","morocco","myanmar","netherlands","nigeria","norway",
  "oman","pakistan","palestine","panama","paraguay","peru","philippines",
  "poland","portugal","puerto_rico","qatar","romania","russia",
  "saudi_arabia","senegal","serbia","singapore","slovakia","slovenia",
  "somalia","spain","sri_lanka","sudan","sweden","syria","taiwan",
  "tajikistan","thailand","tunisia","turkey","turkmenistan","uae",
  "ukraine","united_kingdom","uruguay","uzbekistan","venezuela","vietnam",
  "yemen"
]
const TELEMETR_ROTATION_CATEGORIES = [
  "art-and-design",
  "beauty",
  "betting-and-casino",
  "blogs",
  "books",
  "business",
  "career",
  "cryptocurrencies",
  "economy-and-finance",
  "education",
  "erotic",
  "facts",
  "family-and-children",
  "food-and-drinks",
  "games",
  "healthy-lifestyle",
  "home-and-architecture",
  "humor-and-entertainment",
  "law",
  "linguistics",
  "marketing-and-pr",
  "medicine",
  "motivation-and-quotes",
  "movies",
  "music",
  "nature-and-animals",
  "news-and-media"
]
const TELEMETR_ROTATION_SUBSCRIBER_RANGES = [
  {
    "id": "0-99",
    "min": 0,
    "max": 99
  },
  {
    "id": "100-1999",
    "min": 100,
    "max": 1999
  },
  {
    "id": "2000-9999",
    "min": 2000,
    "max": 9999
  },
  {
    "id": "10000-99999",
    "min": 10000,
    "max": 99999
  },
  {
    "id": "100000-499999",
    "min": 100000,
    "max": 499999
  },
  {
    "id": "500000-999999",
    "min": 500000,
    "max": 999999
  },
  {
    "id": "1000000-plus",
    "min": 1000000,
    "max": null
  }
]

function cleanTelemetrUsername(value) {
  const clean = String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(?:www\.)?t\.me\//i, "")
    .split(/[/?#]/)[0]

  if (!/^[a-zA-Z0-9_]{3,}$/.test(clean)) return null

  const blocked = new Set([
    "peer_type_channel",
    "peer_type_group",
    "channel",
    "group",
    "supergroup",
    "telegram",
    "telemetr",
  ])

  if (blocked.has(clean.toLowerCase())) return null
  return clean
}

function telemetrCatalogUrl({
  country,
  category,
  subscriberMin,
  subscriberMax,
  page,
  term,
}) {
  const safeCountry = String(country || "usa").trim().toLowerCase()
  const params = new URLSearchParams()

  if (Number(page || 1) > 1) params.set("page", String(Number(page)))
  if (category && category !== "all") params.set("categories", category)

  if (subscriberMin || subscriberMax) {
    params.set(
      "subscribers",
      `${subscriberMin || 0},${subscriberMax || ""}`
    )
  }

  if (term) params.set("term", String(term).trim())

  const query = params.toString()
  return `https://telemetr.io/en/catalog/${encodeURIComponent(safeCountry)}${
    query ? `?${query}` : ""
  }`
}

function telemetrRscStateTree(country) {
  return encodeURIComponent(
    JSON.stringify([
      "",
      {
        children: [
          ["lng", "en", "d"],
          {
            children: [
              "(main)",
              {
                children: [
                  "(service)",
                  {
                    children: [
                      "catalog",
                      {
                        children: [
                          ["country", country, "d"],
                          {
                            children: [
                              "__PAGE__",
                              {},
                              null,
                              null,
                            ],
                          },
                          null,
                          null,
                        ],
                      },
                      null,
                      null,
                    ],
                  },
                  null,
                  null,
                ],
              },
              null,
              null,
            ],
          },
          null,
          null,
          true,
        ],
      },
      null,
      null,
    ])
  )
}

async function fetchTelemetrCatalogPage(filters) {
  const browserUrl = telemetrCatalogUrl(filters)
  const country = String(filters.country || "usa")
    .trim()
    .toLowerCase()

  const rscUrl = new URL(browserUrl)
  rscUrl.searchParams.set(
    "_rsc",
    Math.random().toString(36).slice(2, 14)
  )

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)

  try {
    const response = await fetch(rscUrl.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.TELEMETR_WEB_USER_AGENT ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        RSC: "1",
        "Next-Url": `/en/catalog/${country}`,
        "Next-Router-State-Tree": telemetrRscStateTree(country),
        Referer: `https://telemetr.io/en/catalog/${country}`,
      },
    })

    if (!response.ok) {
      const error = new Error(
        `Telemetr catalog RSC request returned HTTP ${response.status}.`
      )
      error.status = response.status
      error.code = "TELEMETR_CATALOG_RSC_ERROR"
      throw error
    }

    const body = await response.text()
    const usernames = new Set()

    const usernameRegex =
      /["\\]username["\\]?\s*:\s*["\\]([a-zA-Z0-9_]{3,})/g

    let match
    while ((match = usernameRegex.exec(body))) {
      const clean = cleanTelemetrUsername(match[1])
      if (clean) usernames.add(clean)
    }

    // Defensive fallback for rendered @username text.
    const visibleUsernameRegex = /@([a-zA-Z0-9_]{3,})/g
    while ((match = visibleUsernameRegex.exec(body))) {
      const clean = cleanTelemetrUsername(match[1])
      if (clean) usernames.add(clean)
    }

    return {
      url: browserUrl,
      rsc_url: rscUrl.toString(),
      usernames: [...usernames],
      response_length: body.length,
      source: "telemetr_next_rsc",
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function logScraperEvent({
  runId,
  level = "info",
  stage,
  message,
  telegramLink = null,
  listingId = null,
  metadata = null,
}) {
  const { error } = await supabaseAdmin.from("scraper_events").insert({
    run_id: runId,
    level,
    stage,
    message,
    telegram_link: telegramLink,
    listing_id: listingId,
    metadata,
    created_at: new Date().toISOString(),
  })

  if (error) console.error("Could not save scraper event:", error)
}

async function refreshScraperRunCounters(runId) {
  const { data, error } = await supabaseAdmin
    .from("scraper_queue")
    .select("status")
    .eq("run_id", runId)

  if (error) throw error

  const counts = {
    ready_for_ai: 0,
    duplicate: 0,
    failed: 0,
  }

  for (const row of data || []) {
    if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
      counts[row.status] += 1
    }
  }

  await supabaseAdmin
    .from("scraper_runs")
    .update({
      discovered_count: counts.ready_for_ai,
      queued_count: counts.ready_for_ai,
      processing_count: 0,
      processed_count: 0,
      created_count: 0,
      duplicate_count: counts.duplicate,
      failed_count: counts.failed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)

  return counts
}

async function telemetrListingAlreadyExists(telegramLink) {
  const username = extractUsernameFromLink(telegramLink)
  const clean = String(username || "").replace(/^@/, "").toLowerCase()

  const { data, error } = await supabaseAdmin
    .from("channel_listings")
    .select("id, channel_name, telegram_link, telegram_username")
    .or(
      `telegram_link.ilike.%${clean}%,telegram_username.ilike.%${clean}%`
    )
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function queueAlreadyContainsAnyRun(telegramLink) {
  const { data, error } = await supabaseAdmin
    .from("scraper_queue")
    .select("id")
    .eq("telegram_link", telegramLink)
    .in("status", ["ready_for_ai", "duplicate", "created"])
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return Boolean(data)
}

async function loadRotationProgress(userId) {
  const { data, error } = await supabaseAdmin
    .from("telemetr_rotation_progress")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function saveRotationProgress(userId, patch) {
  const payload = {
    user_id: userId,
    ...patch,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabaseAdmin
    .from("telemetr_rotation_progress")
    .upsert(payload, { onConflict: "user_id" })
    .select("*")
    .single()

  if (error) throw error
  return data
}

function rotationConfigFromMetadata(metadata) {
  const countries =
    Array.isArray(metadata.rotation_countries) &&
    metadata.rotation_countries.length
      ? metadata.rotation_countries
      : TELEMETR_ROTATION_COUNTRIES

  const categories =
    Array.isArray(metadata.rotation_categories) &&
    metadata.rotation_categories.length
      ? metadata.rotation_categories
      : TELEMETR_ROTATION_CATEGORIES

  const ranges =
    Array.isArray(metadata.rotation_subscriber_ranges) &&
    metadata.rotation_subscriber_ranges.length
      ? metadata.rotation_subscriber_ranges
      : TELEMETR_ROTATION_SUBSCRIBER_RANGES

  return {
    countries,
    categories,
    ranges,
    pagesPerCombination: Math.max(
      1,
      Math.min(Number(metadata.pages_per_combination || 5), 100)
    ),
    combinationsPerRun: Math.max(
      1,
      Math.min(Number(metadata.combinations_per_run || 10), 500)
    ),
  }
}

function currentRotationCombination(progress, config) {
  const country = config.countries[progress.country_index || 0]
  const category = config.categories[progress.category_index || 0]
  const range = config.ranges[progress.range_index || 0]

  return { country, category, range }
}

function advanceRotationCursor(progress, config) {
  let countryIndex = Number(progress.country_index || 0)
  let categoryIndex = Number(progress.category_index || 0)
  let rangeIndex = Number(progress.range_index || 0) + 1

  if (rangeIndex >= config.ranges.length) {
    rangeIndex = 0
    categoryIndex += 1
  }

  if (categoryIndex >= config.categories.length) {
    categoryIndex = 0
    countryIndex += 1
  }

  const complete = countryIndex >= config.countries.length

  return {
    country_index: complete ? config.countries.length : countryIndex,
    category_index: complete ? 0 : categoryIndex,
    range_index: complete ? 0 : rangeIndex,
    page: 1,
    completed_combinations:
      Number(progress.completed_combinations || 0) + 1,
    is_complete: complete,
  }
}

async function shouldStopRun(runId) {
  const { data } = await supabaseAdmin
    .from("scraper_runs")
    .select("status, discovery_stop_requested, stop_all_requested")
    .eq("id", runId)
    .single()

  return Boolean(
    data?.discovery_stop_requested ||
    data?.stop_all_requested ||
    ["stopped", "stopping"].includes(data?.status)
  )
}

async function waitWhilePaused(runId) {
  while (true) {
    const { data } = await supabaseAdmin
      .from("scraper_runs")
      .select("status, discovery_stop_requested, stop_all_requested")
      .eq("id", runId)
      .single()

    if (
      data?.discovery_stop_requested ||
      data?.stop_all_requested ||
      ["stopped", "stopping"].includes(data?.status)
    ) {
      return false
    }

    if (data?.status !== "paused") return true
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

async function addDiscoveryResult(runId, username, metadata = {}) {
  const clean = cleanTelemetrUsername(username)
  if (!clean) return { added: false, reason: "invalid" }

  const telegramLink = `https://t.me/${clean}`

  if (await queueAlreadyContainsAnyRun(telegramLink)) {
    return { added: false, reason: "already_queued" }
  }

  const existing = await telemetrListingAlreadyExists(telegramLink)

  if (existing) {
    await supabaseAdmin.from("scraper_queue").insert({
      run_id: runId,
      telegram_link: telegramLink,
      username: `@${clean}`,
      title: metadata.title || clean,
      status: "duplicate",
      stage: "duplicate",
      listing_id: existing.id,
      result: {
        reason: "duplicate",
        existing_listing_id: existing.id,
      },
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    return { added: false, reason: "duplicate" }
  }

  const { data, error } = await supabaseAdmin
    .from("scraper_queue")
    .insert({
      run_id: runId,
      telegram_link: telegramLink,
      username: `@${clean}`,
      title: metadata.title || clean,
      subscribers: Number.isFinite(Number(metadata.subscribers))
        ? Number(metadata.subscribers)
        : 0,
      category: metadata.category || null,
      status: "ready_for_ai",
      stage: "ready_for_ai",
      result: {
        source: metadata.source || "telemetr_catalog_html",
        discovered_from: metadata.discovered_from || null,
        depth: Number(metadata.depth || 0),
        filters: metadata.filters || null,
      },
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single()

  if (error) throw error

  await logScraperEvent({
    runId,
    level: "success",
    stage: "ready_for_ai",
    message: `Ready for review: @${clean}`,
    telegramLink,
    metadata: {
      queue_item_id: data.id,
      filters: metadata.filters || null,
    },
  })

  return { added: true, row: data }
}

async function runSingleFilterDiscovery(run, metadata) {
  const pages = Math.max(
    1,
    Math.min(Number(metadata.pages_per_combination || 5), 100)
  )
  const target = Math.max(1, Number(run.requested_target || 100))
  let accepted = 0

  for (let page = 1; page <= pages && accepted < target; page += 1) {
    if (!(await waitWhilePaused(run.id))) return accepted

    const result = await fetchTelemetrCatalogPage({
      country: metadata.country,
      category: metadata.category,
      subscriberMin: metadata.subscriber_min,
      subscriberMax: metadata.subscriber_max,
      page,
      term: metadata.term,
    })

    await logScraperEvent({
      runId: run.id,
      stage: "telemetr_catalog_page",
      message: `Page ${page} returned ${result.usernames.length} username(s).`,
      metadata: {
        url: result.url,
        page,
        returned: result.usernames.length,
      },
    })

    if (!result.usernames.length) break

    for (const username of result.usernames) {
      if (accepted >= target) break
      const added = await addDiscoveryResult(run.id, username, {
        category: metadata.category,
        filters: {
          country: metadata.country,
          category: metadata.category,
          subscriber_min: metadata.subscriber_min,
          subscriber_max: metadata.subscriber_max,
          page,
          term: metadata.term || "",
        },
      })
      if (added.added) accepted += 1
    }

    await refreshScraperRunCounters(run.id)
    await new Promise((resolve) => setTimeout(resolve, 900))
  }

  return accepted
}

async function runRotationDiscovery(run, metadata) {
  const config = rotationConfigFromMetadata(metadata)
  const totalCombinations =
    config.countries.length *
    config.categories.length *
    config.ranges.length

  let progress = await loadRotationProgress(run.created_by)

  const configSignature = JSON.stringify({
    countries: config.countries,
    categories: config.categories,
    ranges: config.ranges,
    pages: config.pagesPerCombination,
  })

  if (!progress || progress.config_signature !== configSignature) {
    progress = await saveRotationProgress(run.created_by, {
      config_signature: configSignature,
      country_index: 0,
      category_index: 0,
      range_index: 0,
      page: 1,
      completed_combinations: 0,
      total_combinations: totalCombinations,
      links_discovered: 0,
      is_complete: false,
      last_run_id: run.id,
      current_filters: null,
    })
  }

  let accepted = 0
  let combinationsProcessed = 0
  const target = Math.max(1, Number(run.requested_target || 100))

  while (
    !progress.is_complete &&
    accepted < target &&
    combinationsProcessed < config.combinationsPerRun
  ) {
    if (!(await waitWhilePaused(run.id))) return accepted

    const combo = currentRotationCombination(progress, config)
    if (!combo.country || !combo.category || !combo.range) break

    const filters = {
      country: combo.country,
      category: combo.category,
      subscriber_min: combo.range.min,
      subscriber_max: combo.range.max,
    }

    progress = await saveRotationProgress(run.created_by, {
      ...progress,
      last_run_id: run.id,
      current_filters: filters,
      total_combinations: totalCombinations,
    })

    await logScraperEvent({
      runId: run.id,
      stage: "rotation_combination",
      message:
        `Rotation ${Number(progress.completed_combinations || 0) + 1}/${totalCombinations}: ` +
        `${combo.country} · ${combo.category} · ${combo.range.id}`,
      metadata: filters,
    })

    let exhausted = false

    for (
      let page = Math.max(1, Number(progress.page || 1));
      page <= config.pagesPerCombination && accepted < target;
      page += 1
    ) {
      if (!(await waitWhilePaused(run.id))) return accepted

      const result = await fetchTelemetrCatalogPage({
        country: combo.country,
        category: combo.category,
        subscriberMin: combo.range.min,
        subscriberMax: combo.range.max,
        page,
      })

      await logScraperEvent({
        runId: run.id,
        stage: "telemetr_catalog_page",
        message:
          `${combo.country} / ${combo.category} / ${combo.range.id} / page ${page} ` +
          `returned ${result.usernames.length} username(s).`,
        metadata: {
          ...filters,
          page,
          url: result.url,
          returned: result.usernames.length,
        },
      })

      if (!result.usernames.length) {
        exhausted = true
        break
      }

      for (const username of result.usernames) {
        if (accepted >= target) break
        const added = await addDiscoveryResult(run.id, username, {
          category: combo.category,
          filters: { ...filters, page },
        })
        if (added.added) accepted += 1
      }

      progress = await saveRotationProgress(run.created_by, {
        ...progress,
        page: page + 1,
        links_discovered:
          Number(progress.links_discovered || 0) + accepted,
        last_run_id: run.id,
      })

      await refreshScraperRunCounters(run.id)
      await new Promise((resolve) => setTimeout(resolve, 900))
    }

    if (
      exhausted ||
      Number(progress.page || 1) > config.pagesPerCombination ||
      accepted >= target
    ) {
      progress = await saveRotationProgress(run.created_by, {
        ...progress,
        ...advanceRotationCursor(progress, config),
        last_run_id: run.id,
      })
      combinationsProcessed += 1
    }
  }

  return accepted
}


async function loadTelegramGraphSeedLinks(run, metadata) {
  const requestedSeeds = Array.isArray(metadata.seed_links)
    ? metadata.seed_links.map(cleanImportTelegramLink).filter(Boolean)
    : []

  const seedLimit = Math.max(
    1,
    Math.min(Number(metadata.seed_limit || 100), 10000)
  )

  const settings = {
    crawl_cooldown_hours: Math.max(
      1,
      Number(metadata.crawl_cooldown_hours || GRAPH_CRAWL_COOLDOWN_HOURS)
    ),
    empty_crawl_cooldown_hours: Math.max(
      1,
      Number(
        metadata.empty_crawl_cooldown_hours ||
          GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS
      )
    ),
  }

  // Pull a much larger pool than the requested frontier because recently
  // crawled channels will be skipped by persistent crawl history.
  const poolLimit = Math.max(
    seedLimit,
    Math.min(seedLimit * 10, 10000)
  )

  const { data: approved, error } = await supabaseAdmin
    .from("channel_listings")
    .select("telegram_link, telegram_username, member_count")
    .eq("status", "approved")
    .or("is_banned.is.null,is_banned.eq.false")
    .order("member_count", { ascending: false })
    .limit(poolLimit)

  if (error) throw error

  const existingSeeds = (approved || [])
    .map((listing) =>
      cleanImportTelegramLink(
        listing.telegram_link ||
          (listing.telegram_username
            ? `https://t.me/${String(listing.telegram_username).replace(/^@/, "")}`
            : "")
      )
    )
    .filter(Boolean)

  const explicitNormalized = new Set(
    requestedSeeds.map(normalizeTelegramLinkForComparison).filter(Boolean)
  )

  const candidates = Array.from(
    new Map(
      [...requestedSeeds, ...existingSeeds]
        .map((link) => [normalizeTelegramLinkForComparison(link), link])
        .filter(([normalized]) => Boolean(normalized))
    ).values()
  )

  const history = await loadGraphCrawlHistory(
    candidates.map(normalizeTelegramLinkForComparison)
  )

  const selected = []
  let skippedByHistory = 0

  for (const link of candidates) {
    if (selected.length >= seedLimit) break

    const normalized = normalizeTelegramLinkForComparison(link)
    if (!normalized) continue

    // Explicitly pasted seeds are always honored. Automatic seeds respect
    // persistent crawl history so 24/7 mode keeps moving forward.
    if (
      !explicitNormalized.has(normalized) &&
      !graphHistoryEligible(history.get(normalized), settings)
    ) {
      skippedByHistory += 1
      continue
    }

    selected.push(link)
  }

  if (skippedByHistory > 0) {
    await logScraperEvent({
      runId: run.id,
      stage: "telegram_graph_history_skip",
      message: `Crawl history skipped ${skippedByHistory} recently scanned seed(s); ${selected.length} eligible seed(s) selected.`,
      metadata: {
        skipped_by_history: skippedByHistory,
        selected: selected.length,
        requested_seed_limit: seedLimit,
        crawl_cooldown_hours: settings.crawl_cooldown_hours,
        empty_crawl_cooldown_hours: settings.empty_crawl_cooldown_hours,
      },
    })
  }

  return selected
}


function isObviousTelegramBotUsername(username) {
  const clean = String(username || "")
    .replace(/^@/, "")
    .trim()

  if (!clean) return true

  return /(?:_?bot|robot)$/i.test(clean)
}

async function verifyTelegramGraphCandidate(candidateLink) {
  const username = extractUsernameFromLink(candidateLink)

  if (!username) {
    return { ok: false, reason: "invalid_username" }
  }

  const cleanUsernameValue = String(username).replace(/^@/, "")

  // Cheap prefilter: Telegram bot usernames conventionally end in "bot".
  if (isObviousTelegramBotUsername(cleanUsernameValue)) {
    return {
      ok: false,
      reason: "filtered_bot_username",
      username: cleanUsernameValue,
    }
  }

  try {
    const profile = await fetchPublicTelegramPage({
      telegram_username: `@${cleanUsernameValue}`,
      telegram_link: `https://t.me/${cleanUsernameValue}`,
    })

    if (
      profile?.listingType !== "channel" &&
      profile?.listingType !== "group"
    ) {
      return {
        ok: false,
        reason: "not_channel_or_group",
        username: cleanUsernameValue,
      }
    }

    if (!Number.isFinite(Number(profile.memberCount))) {
      return {
        ok: false,
        reason: "missing_member_count",
        username: cleanUsernameValue,
      }
    }

    return {
      ok: true,
      username: String(profile.telegramUsername || `@${cleanUsernameValue}`).replace(/^@/, ""),
      telegramLink: profile.telegramLink || `https://t.me/${cleanUsernameValue}`,
      listingType: profile.listingType,
      memberCount: Number(profile.memberCount || 0),
      title: profile.title || cleanUsernameValue,
      description: profile.description || "",
      source: profile.source || "tme_public_page",
    }
  } catch (error) {
    const reason =
      error?.code === "TME_ENTITY_BOT"
        ? "filtered_bot"
        : error?.code === "TME_ENTITY_USER"
          ? "filtered_user"
          : error?.code === "TME_ENTITY_CHANNEL_LIKE_NO_COUNT"
            ? "filtered_channel_like_no_count"
            : error?.code === "TME_ENTITY_UNKNOWN"
              ? "filtered_unknown"
              : error?.code || "telegram_verification_failed"

    return {
      ok: false,
      reason,
      username: cleanUsernameValue,
      error: error?.message || "Telegram verification failed.",
      status: error?.status || null,
      classification_reason: error?.classification_reason || null,
    }
  }
}

async function runTelegramGraphDiscovery(run, metadata) {
  const target = Math.max(1, Number(run.requested_target || 100))
  const maxDepth = Math.max(1, Math.min(Number(metadata.max_depth || 2), 5))
  const perSeedLimit = Math.max(
    1,
    Math.min(Number(metadata.max_links_per_seed || 25), 100)
  )
  const requestDelayMs = Math.max(
    250,
    Math.min(Number(metadata.request_delay_ms || 1000), 10000)
  )

  let frontier = await loadTelegramGraphSeedLinks(run, metadata)
  const visited = new Set()
  let accepted = 0

  await logScraperEvent({
    runId: run.id,
    stage: "telegram_graph_seeded",
    message: `Telegram graph seeded with ${frontier.length} eligible public channel(s).`,
    metadata: {
      seeds: frontier.length,
      max_depth: maxDepth,
      max_links_per_seed: perSeedLimit,
    },
  })

  for (
    let depth = 0;
    depth < maxDepth && frontier.length && accepted < target;
    depth += 1
  ) {
    const nextFrontier = []

    for (const seedLink of frontier) {
      if (accepted >= target) break
      if (!(await waitWhilePaused(run.id))) return accepted

      if (metadata.continuous && !(await isContinuousAutomationEnabled())) {
        return accepted
      }

      const normalizedSeed = normalizeTelegramLinkForComparison(seedLink)
      if (!normalizedSeed || visited.has(normalizedSeed)) continue
      visited.add(normalizedSeed)

      const seedUsername = extractUsernameFromLink(seedLink)
      if (!seedUsername) continue

      await supabaseAdmin
        .from("scraper_runs")
        .update({
          current_stage: "telegram_graph",
          current_link: seedLink,
          agent_last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id)

      let rawCandidateCount = 0
      let verifiedFromSeed = 0
      let newFromSeed = 0

      try {
        const context = await fetchPublicTelegramPostContext(
          { telegram_username: seedUsername, telegram_link: seedLink },
          { maxPosts: 30, maxCharacters: 12000 }
        )

        const candidates = Array.from(
          new Set((context.telegramLinks || []).map(cleanImportTelegramLink))
        )
          .filter(Boolean)
          .filter(
            (candidate) =>
              normalizeTelegramLinkForComparison(candidate) !== normalizedSeed
          )
          .slice(
            0,
            Math.min(100, Math.max(perSeedLimit * 10, perSeedLimit))
          )

        rawCandidateCount = candidates.length

        await logScraperEvent({
          runId: run.id,
          stage: "telegram_graph_seed_scanned",
          message: `Depth ${depth + 1}: ${seedLink} exposed ${candidates.length} raw candidate link(s); seeking up to ${perSeedLimit} verified channel/group result(s).`,
          telegramLink: seedLink,
          metadata: {
            depth: depth + 1,
            raw_candidates: candidates.length,
            verified_target_per_seed: perSeedLimit,
            public_posts_found: context.postCount,
          },
        })

        for (const candidateLink of candidates) {
          if (accepted >= target || verifiedFromSeed >= perSeedLimit) break

          const candidateUsername = extractUsernameFromLink(candidateLink)
          if (!candidateUsername) continue

          const verified = await verifyTelegramGraphCandidate(candidateLink)

          if (!verified.ok) {
            await logScraperEvent({
              runId: run.id,
              level: "info",
              stage: "telegram_graph_filtered",
              message: `Filtered @${String(candidateUsername).replace(/^@/, "")}: ${verified.reason}.`,
              telegramLink: candidateLink,
              metadata: {
                depth: depth + 1,
                reason: verified.reason,
                error: verified.error || null,
                status: verified.status || null,
                discovered_from: seedLink,
              },
            })
            continue
          }

          const added = await addDiscoveryResult(run.id, verified.username, {
            source: "telegram_graph",
            discovered_from: seedLink,
            depth: depth + 1,
            title: verified.title,
            subscribers: verified.memberCount,
            category: null,
            filters: {
              source: "telegram_graph",
              seed: seedLink,
              depth: depth + 1,
              verified_type: verified.listingType,
              verification_source: verified.source,
            },
          })

          // Traversal and importing are deliberately separate. Already-known
          // verified communities are still useful graph nodes.
          verifiedFromSeed += 1

          if (added.added) {
            accepted += 1
            newFromSeed += 1
          }

          await logScraperEvent({
            runId: run.id,
            level: added.added ? "success" : "info",
            stage: added.added
              ? "telegram_graph_verified"
              : "telegram_graph_verified_existing",
            message: added.added
              ? `Verified ${verified.listingType}: @${verified.username} (${Number(
                  verified.memberCount || 0
                ).toLocaleString()} ${
                  verified.listingType === "channel"
                    ? "subscribers"
                    : "members"
                }).`
              : `Verified existing ${verified.listingType}: @${verified.username}; using it as a graph node (${added.reason || "already_known"}).`,
            telegramLink: verified.telegramLink,
            metadata: {
              depth: depth + 1,
              discovered_from: seedLink,
              listing_type: verified.listingType,
              member_count: verified.memberCount,
              verified_from_seed: verifiedFromSeed,
              new_from_seed: newFromSeed,
              per_seed_limit: perSeedLimit,
              newly_queued: Boolean(added.added),
              discovery_result:
                added.reason || (added.added ? "added" : "already_known"),
            },
          })

          if (depth + 1 < maxDepth) {
            const normalizedNext = normalizeTelegramLinkForComparison(
              verified.telegramLink
            )

            if (
              normalizedNext &&
              normalizedNext !== normalizedSeed &&
              !visited.has(normalizedNext)
            ) {
              nextFrontier.push(verified.telegramLink)
            }
          }
        }

        await recordGraphCrawlHistory({
          seedLink,
          seedUsername,
          rawCandidates: rawCandidateCount,
          verifiedCount: verifiedFromSeed,
          newCount: newFromSeed,
          status: "completed",
        })
      } catch (error) {
        await recordGraphCrawlHistory({
          seedLink,
          seedUsername,
          rawCandidates: rawCandidateCount,
          verifiedCount: verifiedFromSeed,
          newCount: newFromSeed,
          status: "failed",
          error: error.message || "Could not scan public posts.",
        })

        await logScraperEvent({
          runId: run.id,
          level: "warning",
          stage: "telegram_graph_seed_failed",
          message: `${seedLink}: ${error.message || "Could not scan public posts."}`,
          telegramLink: seedLink,
          metadata: {
            depth: depth + 1,
            code: error?.code || null,
            status: error?.status || null,
          },
        })
      }

      await refreshScraperRunCounters(run.id)
      await new Promise((resolve) => setTimeout(resolve, requestDelayMs))
    }

    frontier = Array.from(
      new Map(
        nextFrontier
          .map((link) => [normalizeTelegramLinkForComparison(link), link])
          .filter(([normalized]) => Boolean(normalized))
      ).values()
    )

    if (depth + 1 < maxDepth) {
      await logScraperEvent({
        runId: run.id,
        stage: "telegram_graph_depth_advanced",
        message: `Depth ${depth + 1} complete; ${frontier.length} verified node(s) queued for depth ${depth + 2}.`,
        metadata: {
          completed_depth: depth + 1,
          next_depth: depth + 2,
          next_frontier_size: frontier.length,
          new_links_accepted_so_far: accepted,
        },
      })
    }
  }

  return accepted
}

async function runDiscoveryImport(runId) {
  if (activeTelemetrRuns.has(runId)) return
  activeTelemetrRuns.add(runId)

  try {
    const { data: run, error } = await supabaseAdmin
      .from("scraper_runs")
      .select("*")
      .eq("id", runId)
      .single()

    if (error) throw error

    const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {}
    const provider = String(metadata.provider || "telemetr_catalog_html")

    await supabaseAdmin
      .from("scraper_runs")
      .update({
        status: "scraping",
        current_stage:
          provider === "telegram_graph"
            ? "telegram_graph"
            : metadata.rotation_mode
              ? "rotation_discovery"
              : "telemetr_catalog",
        started_at: run.started_at || new Date().toISOString(),
        agent_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)

    const accepted =
      provider === "telegram_graph"
        ? await runTelegramGraphDiscovery(run, metadata)
        : metadata.rotation_mode
          ? await runRotationDiscovery(run, metadata)
          : await runSingleFilterDiscovery(run, metadata)

    const counts = await refreshScraperRunCounters(runId)

    await supabaseAdmin
      .from("scraper_runs")
      .update({
        status: "completed",
        current_stage: "ready_for_review",
        current_link: null,
        framer_deployed: false,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)

    await logScraperEvent({
      runId,
      level: "success",
      stage: "run_completed",
      message:
        `Discovery complete: ${counts.ready_for_ai} new link(s) are ready for review. ` +
        `${counts.duplicate} duplicate(s) were skipped.`,
      metadata: { accepted, counters: counts, discovery_only: true, provider },
    })
  } catch (error) {
    console.error("Discovery failed:", error)
    await supabaseAdmin
      .from("scraper_runs")
      .update({
        status: "failed",
        current_stage: "discovery_failed",
        current_link: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)

    await logScraperEvent({
      runId,
      level: "error",
      stage: "discovery_failed",
      message: error.message || "Discovery failed.",
      metadata: { code: error?.code || null, status: error?.status || null },
    })
  } finally {
    activeTelemetrRuns.delete(runId)
  }
}

async function runTelemetrImport(runId) {
  return runDiscoveryImport(runId)
}

async function runTelemetrImportLegacy(runId) {
  if (activeTelemetrRuns.has(runId)) return
  activeTelemetrRuns.add(runId)

  try {
    const { data: run, error } = await supabaseAdmin
      .from("scraper_runs")
      .select("*")
      .eq("id", runId)
      .single()

    if (error) throw error

    const metadata =
      run.metadata && typeof run.metadata === "object"
        ? run.metadata
        : {}

    await supabaseAdmin
      .from("scraper_runs")
      .update({
        status: "scraping",
        current_stage: metadata.rotation_mode
          ? "rotation_discovery"
          : "telemetr_catalog",
        started_at: run.started_at || new Date().toISOString(),
        agent_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)

    await logScraperEvent({
      runId,
      stage: "telemetr_connecting",
      message: metadata.rotation_mode
        ? "Persistent rotation resumed from the saved cursor."
        : "Single-filter Telemetr discovery started.",
      metadata,
    })

    const accepted = metadata.rotation_mode
      ? await runRotationDiscovery(run, metadata)
      : await runSingleFilterDiscovery(run, metadata)

    const counts = await refreshScraperRunCounters(runId)

    await supabaseAdmin
      .from("scraper_runs")
      .update({
        status: "completed",
        current_stage: "ready_for_review",
        current_link: null,
        framer_deployed: false,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)

    await logScraperEvent({
      runId,
      level: "success",
      stage: "run_completed",
      message:
        `Discovery complete: ${counts.ready_for_ai} new link(s) are ready for review. ` +
        `${counts.duplicate} duplicate(s) were skipped.`,
      metadata: {
        accepted,
        counters: counts,
        discovery_only: true,
      },
    })
  } catch (error) {
    console.error("Telemetr discovery failed:", error)

    await supabaseAdmin
      .from("scraper_runs")
      .update({
        status: "failed",
        current_stage: "telemetr_failed",
        current_link: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)

    await logScraperEvent({
      runId,
      level: "error",
      stage: "telemetr_failed",
      message: error.message || "Telemetr discovery failed.",
      metadata: {
        code: error?.code || null,
        status: error?.status || null,
      },
    })
  } finally {
    activeTelemetrRuns.delete(runId)
  }
}


async function markContinuousQueueItemProcessing(item, runId) {
  const now = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from("scraper_queue")
    .update({
      status: "processing",
      stage: "ai_import",
      error: null,
      updated_at: now,
    })
    .eq("id", item.id)
    .eq("run_id", runId)

  if (error) throw error
}

async function markContinuousQueueItemComplete(item, result) {
  const finalStatus = result?.created
    ? "created"
    : result?.skipped
      ? "duplicate"
      : result?.ok === false
        ? "failed"
        : "completed"

  const finalStage = result?.created
    ? "completed"
    : result?.filtered
      ? "filtered"
      : result?.skipped
        ? "duplicate"
        : result?.ok === false
          ? "failed"
          : "completed"

  const { error } = await supabaseAdmin
    .from("scraper_queue")
    .update({
      status: finalStatus,
      stage: finalStage,
      listing_id:
        result?.listing_id || result?.existing_listing_id || null,
      result: result || null,
      framer_synced: Boolean(result?.framer_synced),
      error: result?.ok === false ? result?.error || "Import failed." : null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", item.id)

  if (error) throw error
}

async function resetContinuousQueueItemForRetry(item, error) {
  const { error: updateError } = await supabaseAdmin
    .from("scraper_queue")
    .update({
      status: "ready_for_ai",
      stage: "ready_for_ai",
      error: String(error?.message || "Temporary importer error.").slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", item.id)

  if (updateError) {
    console.warn("Could not reset queue item for retry:", updateError.message)
  }
}

function isTransientContinuousImportError(error) {
  const message = String(error?.message || "").toLowerCase()

  return (
    error?.code === "TELEGRAM_RATE_LIMITED" ||
    error?.status === 429 ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout") ||
    message.includes("fetch failed")
  )
}

async function publishContinuousFramerBatch(results) {
  const needsDeploy = (results || []).some(
    (item) => item?.created && item?.framer_synced
  )

  if (
    !needsDeploy ||
    process.env.FRAMER_AUTO_DEPLOY === "false"
  ) {
    return false
  }

  const { connect } = await import("framer-api")
  const framer = await connect(
    process.env.FRAMER_PROJECT_URL,
    process.env.FRAMER_API_KEY
  )

  try {
    const publication = await framer.publish()
    await framer.deploy(publication.deployment.id)
    return true
  } finally {
    await framer.disconnect()
  }
}

async function processContinuousAutomationQueue(runId, state) {
  const settings = continuousAutomationSettings(state)
  const adminUser = { id: state.created_by }
  let totalProcessed = 0
  let totalCreated = 0
  let totalFailed = 0
  let anyDeployed = false

  if (!adminUser.id) {
    throw new Error(
      "24/7 automation has no admin owner. Turn it off and enable it again."
    )
  }

  while (await isContinuousAutomationEnabled()) {
    const { data: queueItems, error } = await supabaseAdmin
      .from("scraper_queue")
      .select("*")
      .eq("run_id", runId)
      .eq("status", "ready_for_ai")
      .order("created_at", { ascending: true })
      .limit(settings.import_batch_size)

    if (error) throw error
    if (!(queueItems || []).length) break

    await supabaseAdmin
      .from("scraper_runs")
      .update({
        status: "importing",
        current_stage: "continuous_ai_import",
        current_link: queueItems[0]?.telegram_link || null,
        agent_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)

    const batchResults = []
    let transientBackoffSeconds = 0

    for (const item of queueItems) {
      if (!(await isContinuousAutomationEnabled())) break

      await markContinuousQueueItemProcessing(item, runId)

      try {
        const result = await importSingleTelegramListing(
          item.telegram_link,
          {
            syncToFramer: settings.sync_to_framer,
            backgroundMode: settings.background_mode,
          },
          adminUser,
          async (stage, metadata = {}) => {
            await supabaseAdmin
              .from("scraper_queue")
              .update({
                stage,
                updated_at: new Date().toISOString(),
              })
              .eq("id", item.id)

            await supabaseAdmin
              .from("scraper_runs")
              .update({
                current_stage: stage,
                current_link: item.telegram_link,
                agent_last_seen_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", runId)

            await logScraperEvent({
              runId,
              stage,
              telegramLink: item.telegram_link,
              message: `24/7 importer: ${stage.replace(/_/g, " ")} for ${item.telegram_link}.`,
              metadata,
            })
          }
        )

        batchResults.push(result)
        totalProcessed += 1
        if (result?.created) totalCreated += 1
        await markContinuousQueueItemComplete(item, result)
      } catch (error) {
        if (isTransientContinuousImportError(error)) {
          await resetContinuousQueueItemForRetry(item, error)
          transientBackoffSeconds = Math.max(
            60,
            Number(error?.retry_after_seconds || 0)
          )

          await logScraperEvent({
            runId,
            level: "warning",
            stage: "continuous_import_backoff",
            telegramLink: item.telegram_link,
            message: `24/7 importer paused for a transient error: ${error.message}`,
            metadata: {
              retry_after_seconds: transientBackoffSeconds,
              code: error?.code || null,
            },
          })
          break
        }

        const failed = {
          ok: false,
          link: item.telegram_link,
          error: error.message || "Import failed.",
          code: error?.code || null,
        }

        batchResults.push(failed)
        totalProcessed += 1
        totalFailed += 1
        await markContinuousQueueItemComplete(item, failed)
      }

      await sleep(ADMIN_IMPORT_DELAY_MS)
    }

    // Every listing in the batch synced with publish:false.
    // Framer publishes/deploys exactly once for this completed batch.
    if (settings.sync_to_framer) {
      try {
        const deployed = await publishContinuousFramerBatch(batchResults)
        anyDeployed = anyDeployed || deployed
      } catch (error) {
        console.error("Continuous Framer batch deploy failed:", error)
        await logScraperEvent({
          runId,
          level: "error",
          stage: "continuous_framer_deploy_failed",
          message: error.message || "Framer batch deployment failed.",
        })
      }
    }

    try {
      await updateHomepageListingCache()
    } catch (error) {
      console.warn("Continuous homepage cache refresh failed:", error.message)
    }

    await refreshScraperRunCounters(runId)

    if (transientBackoffSeconds > 0) {
      await sleep(transientBackoffSeconds * 1000)
    }
  }

  return {
    processed: totalProcessed,
    created: totalCreated,
    failed: totalFailed,
    deployed: anyDeployed,
  }
}

async function createContinuousAutomationRun(state) {
  const settings = continuousAutomationSettings(state)
  const now = new Date().toISOString()
  const metadata = {
    provider: "telegram_graph",
    continuous: true,
    seed_links: [],
    seed_limit: settings.seed_limit,
    max_depth: settings.max_depth,
    max_links_per_seed: settings.max_links_per_seed,
    request_delay_ms: settings.request_delay_ms,
    crawl_cooldown_hours: settings.crawl_cooldown_hours,
    empty_crawl_cooldown_hours: settings.empty_crawl_cooldown_hours,
  }

  const { data: run, error } = await supabaseAdmin
    .from("scraper_runs")
    .insert({
      source: "telegram_graph_24_7",
      status: "queued",
      requested_target: settings.target_per_cycle,
      country_id: "global",
      sort: "graph",
      sync_to_framer: settings.sync_to_framer,
      use_icon_as_background: settings.background_mode === "icon",
      created_by: state.created_by,
      discovery_stop_requested: false,
      stop_all_requested: false,
      current_stage: "queued",
      metadata,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single()

  if (error) throw error

  await supabaseAdmin
    .from("telehub_automation_state")
    .update({
      current_run_id: String(run.id),
      last_cycle_started_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq("id", CONTINUOUS_AUTOMATION_ROW_ID)

  return run
}

async function runContinuousAutomationCycle(state) {
  const run = await createContinuousAutomationRun(state)

  await logScraperEvent({
    runId: run.id,
    stage: "continuous_cycle_started",
    message: "24/7 Telegram graph + AI cycle started.",
    metadata: continuousAutomationSettings(state),
  })

  await runDiscoveryImport(run.id)

  if (!(await isContinuousAutomationEnabled())) {
    return { runId: run.id, stopped: true }
  }

  const importResult = await processContinuousAutomationQueue(run.id, state)
  const counts = await refreshScraperRunCounters(run.id)
  const now = new Date().toISOString()

  await supabaseAdmin
    .from("scraper_runs")
    .update({
      status: "completed",
      current_stage: "continuous_cycle_completed",
      current_link: null,
      framer_deployed: Boolean(importResult.deployed),
      completed_at: now,
      updated_at: now,
    })
    .eq("id", run.id)

  const { data: latestState } = await supabaseAdmin
    .from("telehub_automation_state")
    .select("cycle_count")
    .eq("id", CONTINUOUS_AUTOMATION_ROW_ID)
    .single()

  await supabaseAdmin
    .from("telehub_automation_state")
    .update({
      current_run_id: null,
      cycle_count: Number(latestState?.cycle_count || 0) + 1,
      last_cycle_completed_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq("id", CONTINUOUS_AUTOMATION_ROW_ID)

  await logScraperEvent({
    runId: run.id,
    level: "success",
    stage: "continuous_cycle_completed",
    message:
      `24/7 cycle complete: ${importResult.created} listing(s) created, ` +
      `${counts.duplicate || 0} duplicate(s), ${importResult.failed} import failure(s).`,
    metadata: {
      import: importResult,
      counters: counts,
    },
  })

  return { runId: run.id, importResult, counts }
}

async function runContinuousAutomationLoop() {
  while (true) {
    const state = await getContinuousAutomationState()
    if (!state?.enabled) break

    let claimed = false
    let heartbeatTimer = null

    try {
      claimed = await claimContinuousAutomationLease()

      if (!claimed) {
        await sleep(10000)
        continue
      }

      heartbeatTimer = setInterval(() => {
        heartbeatContinuousAutomationLease().catch((error) =>
          console.warn("Automation heartbeat error:", error.message)
        )
      }, 60000)

      await runContinuousAutomationCycle(state)
    } catch (error) {
      console.error("24/7 automation cycle failed:", error)

      await supabaseAdmin
        .from("telehub_automation_state")
        .update({
          last_error: String(error.message || "Automation cycle failed.").slice(
            0,
            4000
          ),
          last_cycle_completed_at: new Date().toISOString(),
          current_run_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", CONTINUOUS_AUTOMATION_ROW_ID)
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (claimed) await releaseContinuousAutomationLease()
    }

    const refreshed = await getContinuousAutomationState()
    if (!refreshed?.enabled) break

    const settings = continuousAutomationSettings(refreshed)
    await sleep(settings.cycle_delay_ms)
  }
}

function kickContinuousAutomationWorker() {
  if (continuousAutomationLoopPromise) return continuousAutomationLoopPromise

  continuousAutomationLoopPromise = runContinuousAutomationLoop()
    .catch((error) => {
      console.error("24/7 automation worker stopped unexpectedly:", error)
    })
    .finally(() => {
      continuousAutomationLoopPromise = null
    })

  return continuousAutomationLoopPromise
}

app.post("/api/admin/scraper/start", async (req, res) => {
  try {
    const user = await getAdminUserFromRequest(req)
    if (!user) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const automationState = await getContinuousAutomationState()
    if (automationState?.enabled) {
      return res.status(409).json({
        error:
          "24/7 automation is enabled. Turn it off before starting a manual discovery run.",
        automation_enabled: true,
        run_id: automationState.current_run_id || null,
      })
    }

    const { data: activeRun } = await supabaseAdmin
      .from("scraper_runs")
      .select("id, status")
      .in("status", ["queued", "scraping", "paused"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (activeRun) {
      return res.status(409).json({
        error: "A discovery run is already active.",
        run_id: activeRun.id,
        status: activeRun.status,
      })
    }

    const country = String(req.body?.country || "usa")
      .trim()
      .toLowerCase()

    if (!/^[a-z0-9_]+$/.test(country)) {
      return res.status(400).json({
        error: "Choose a valid country.",
      })
    }

    const requestedSource = String(req.body?.source || "telegram_graph")
      .trim()
      .toLowerCase()
    const provider =
      requestedSource === "telemetr" || requestedSource === "telemetr_catalog_html"
        ? "telemetr_catalog_html"
        : "telegram_graph"

    const metadata = {
      provider,
      rotation_mode: provider === "telemetr_catalog_html" && req.body?.rotation_mode === true,
      seed_links: parseTelegramImportLinks(req.body?.seed_links || ""),
      seed_limit: Math.max(1, Math.min(Number(req.body?.seed_limit || 100), 1000)),
      max_depth: Math.max(1, Math.min(Number(req.body?.max_depth || 2), 5)),
      max_links_per_seed: Math.max(1, Math.min(Number(req.body?.max_links_per_seed || 25), 100)),
      request_delay_ms: Math.max(250, Math.min(Number(req.body?.request_delay_ms || 1000), 10000)),
      crawl_cooldown_hours: Math.max(
        1,
        Number(req.body?.crawl_cooldown_hours || GRAPH_CRAWL_COOLDOWN_HOURS)
      ),
      empty_crawl_cooldown_hours: Math.max(
        1,
        Number(
          req.body?.empty_crawl_cooldown_hours ||
            GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS
        )
      ),
      country,
      category: String(req.body?.category || "all").trim(),
      subscriber_min:
        req.body?.subscriber_min === null ||
        req.body?.subscriber_min === undefined
          ? null
          : Math.max(0, Number(req.body.subscriber_min)),
      subscriber_max:
        req.body?.subscriber_max === null ||
        req.body?.subscriber_max === undefined ||
        req.body?.subscriber_max === ""
          ? null
          : Math.max(0, Number(req.body.subscriber_max)),
      term: String(req.body?.term || "").trim(),
      pages_per_combination: Math.max(
        1,
        Math.min(Number(req.body?.pages_per_combination || 5), 100)
      ),
      combinations_per_run: Math.max(
        1,
        Math.min(Number(req.body?.combinations_per_run || 10), 500)
      ),
      rotation_countries: Array.isArray(req.body?.rotation_countries)
        ? req.body.rotation_countries
        : null,
      rotation_categories: Array.isArray(req.body?.rotation_categories)
        ? req.body.rotation_categories
        : null,
      rotation_subscriber_ranges:
        Array.isArray(req.body?.rotation_subscriber_ranges)
          ? req.body.rotation_subscriber_ranges
          : null,
    }

    const now = new Date().toISOString()
    const { data: run, error } = await supabaseAdmin
      .from("scraper_runs")
      .insert({
        source:
          metadata.provider === "telegram_graph"
            ? "telegram_graph"
            : metadata.rotation_mode
              ? "telemetr_rotation"
              : "telemetr_filter",
        status: "queued",
        requested_target: Math.max(
          1,
          Math.min(Number(req.body?.target || 100), 10000)
        ),
        country_id: country,
        sort: "catalog",
        sync_to_framer: false,
        use_icon_as_background: false,
        created_by: user.id,
        discovery_stop_requested: false,
        stop_all_requested: false,
        current_stage: "queued",
        metadata,
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single()

    if (error) throw error

    await logScraperEvent({
      runId: run.id,
      stage: metadata.provider === "telegram_graph" ? "telegram_graph_config" : "telemetr_config",
      message:
        metadata.provider === "telegram_graph"
          ? "Telegram graph crawler configuration saved."
          : metadata.rotation_mode
            ? "Persistent rotation configuration saved."
            : "Single-filter discovery configuration saved.",
      metadata,
    })

    setImmediate(() => runTelemetrImport(run.id))
    return res.json({ ok: true, run })
  } catch (error) {
    console.error("Starting Telemetr discovery failed:", error)
    return res.status(500).json({
      error: error.message || "Could not start discovery.",
    })
  }
})

app.post("/api/admin/scraper/control", async (req, res) => {
  try {
    const user = await getAdminUserFromRequest(req)
    if (!user) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const runId = String(req.body?.run_id || "").trim()
    const action = String(req.body?.action || "").trim()

    if (!runId) return res.status(400).json({ error: "Missing run_id." })

    if (action === "pause") {
      await supabaseAdmin
        .from("scraper_runs")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", runId)
    } else if (action === "resume") {
      await supabaseAdmin
        .from("scraper_runs")
        .update({ status: "scraping", updated_at: new Date().toISOString() })
        .eq("id", runId)

      setImmediate(() => runTelemetrImport(runId))
    } else if (action === "stop_discovery") {
      await supabaseAdmin
        .from("scraper_runs")
        .update({
          status: "stopped",
          discovery_stop_requested: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId)
    } else if (action === "clear_results") {
      await supabaseAdmin
        .from("scraper_queue")
        .delete()
        .eq("run_id", runId)
    } else {
      return res.status(400).json({ error: "Unknown control action." })
    }

    return res.json({ ok: true })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

app.post("/api/admin/scraper/rotation/reset", async (req, res) => {
  try {
    const user = await getAdminUserFromRequest(req)
    if (!user) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const { error } = await supabaseAdmin
      .from("telemetr_rotation_progress")
      .delete()
      .eq("user_id", user.id)

    if (error) throw error
    return res.json({ ok: true })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})


app.get("/api/admin/automation/status", async (req, res) => {
  try {
    const user = await getAdminUserFromRequest(req)
    if (!user) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const state = await getContinuousAutomationState()

    const { count: historyCount, error: historyError } = await supabaseAdmin
      .from("telegram_graph_crawl_history")
      .select("*", { count: "exact", head: true })

    if (historyError) throw historyError

    return res.json({
      ok: true,
      automation: {
        ...state,
        settings: continuousAutomationSettings(state),
        crawl_history_count: Number(historyCount || 0),
        worker_active: Boolean(continuousAutomationLoopPromise),
      },
    })
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Could not load 24/7 automation status.",
    })
  }
})

app.post("/api/admin/automation/toggle", async (req, res) => {
  try {
    const user = await getAdminUserFromRequest(req)
    if (!user) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const enabled = req.body?.enabled === true
    const current = await getContinuousAutomationState()
    const currentSettings =
      current?.settings && typeof current.settings === "object"
        ? current.settings
        : {}

    const settings = {
      ...currentSettings,
      seed_limit: Math.max(
        1,
        Math.min(Number(req.body?.seed_limit || currentSettings.seed_limit || 1000), 10000)
      ),
      max_depth: Math.max(
        1,
        Math.min(Number(req.body?.max_depth || currentSettings.max_depth || 2), 5)
      ),
      max_links_per_seed: Math.max(
        1,
        Math.min(
          Number(
            req.body?.max_links_per_seed ||
              currentSettings.max_links_per_seed ||
              10
          ),
          100
        )
      ),
      request_delay_ms: Math.max(
        250,
        Math.min(
          Number(
            req.body?.request_delay_ms ||
              currentSettings.request_delay_ms ||
              2000
          ),
          10000
        )
      ),
      target_per_cycle: Math.max(
        1,
        Math.min(
          Number(
            req.body?.target_per_cycle ||
              currentSettings.target_per_cycle ||
              500
          ),
          10000
        )
      ),
      import_batch_size: Math.max(
        1,
        Math.min(
          Number(
            req.body?.import_batch_size ||
              currentSettings.import_batch_size ||
              20
          ),
          MAX_ADMIN_IMPORT_LIMIT
        )
      ),
      background_mode: ["none", "icon", "related", "telegram_post"].includes(
        String(
          req.body?.background_mode ||
            currentSettings.background_mode ||
            "related"
        )
      )
        ? String(
            req.body?.background_mode ||
              currentSettings.background_mode ||
              "related"
          )
        : "related",
      sync_to_framer:
        req.body?.sync_to_framer === undefined
          ? currentSettings.sync_to_framer !== false
          : req.body.sync_to_framer !== false,
      cycle_delay_ms: Math.max(
        5000,
        Math.min(
          Number(
            req.body?.cycle_delay_ms ||
              currentSettings.cycle_delay_ms ||
              CONTINUOUS_AUTOMATION_IDLE_MS
          ),
          300000
        )
      ),
      crawl_cooldown_hours: Math.max(
        1,
        Number(
          req.body?.crawl_cooldown_hours ||
            currentSettings.crawl_cooldown_hours ||
            GRAPH_CRAWL_COOLDOWN_HOURS
        )
      ),
      empty_crawl_cooldown_hours: Math.max(
        1,
        Number(
          req.body?.empty_crawl_cooldown_hours ||
            currentSettings.empty_crawl_cooldown_hours ||
            GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS
        )
      ),
    }

    const now = new Date().toISOString()

    const { data: state, error } = await supabaseAdmin
      .from("telehub_automation_state")
      .upsert(
        {
          id: CONTINUOUS_AUTOMATION_ROW_ID,
          enabled,
          created_by: user.id,
          settings,
          ...(enabled
            ? {
                last_error: null,
              }
            : {
                current_run_id: null,
                lease_owner: null,
                lease_expires_at: null,
              }),
          updated_at: now,
        },
        { onConflict: "id" }
      )
      .select("*")
      .single()

    if (error) throw error

    if (!enabled && current?.current_run_id) {
      await supabaseAdmin
        .from("scraper_runs")
        .update({
          status: "stopped",
          discovery_stop_requested: true,
          stop_all_requested: true,
          updated_at: now,
        })
        .eq("id", current.current_run_id)
    }

    if (enabled) {
      setImmediate(() => kickContinuousAutomationWorker())
    } else {
      await releaseContinuousAutomationLease()
    }

    return res.json({
      ok: true,
      automation: {
        ...state,
        settings: continuousAutomationSettings(state),
      },
    })
  } catch (error) {
    console.error("24/7 automation toggle failed:", error)
    return res.status(500).json({
      error: error.message || "Could not change 24/7 automation.",
    })
  }
})

app.get("/api/admin/scraper/status", async (req, res) => {
  try {
    const user = await getAdminUserFromRequest(req)
    if (!user) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const requestedRunId = String(req.query?.run_id || "").trim()

    let runQuery = supabaseAdmin
      .from("scraper_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)

    if (requestedRunId) {
      runQuery = supabaseAdmin
        .from("scraper_runs")
        .select("*")
        .eq("id", requestedRunId)
        .limit(1)
    }

    const { data: runs, error: runError } = await runQuery
    if (runError) throw runError

    const run = Array.isArray(runs) ? runs[0] || null : runs || null

    const { data: rotationProgress, error: progressError } =
      await supabaseAdmin
        .from("telemetr_rotation_progress")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle()

    if (progressError) throw progressError

    if (!run) {
      return res.json({
        ok: true,
        run: null,
        events: [],
        queue: [],
        rotation_progress: rotationProgress || null,
      })
    }

    const [eventsResult, queueResult] = await Promise.all([
      supabaseAdmin
        .from("scraper_events")
        .select("*")
        .eq("run_id", run.id)
        .order("created_at", { ascending: false })
        .limit(SCRAPER_EVENT_LIMIT),
      supabaseAdmin
        .from("scraper_queue")
        .select(
          "id, telegram_link, username, title, subscribers, category, avatar_url, status, stage, error, listing_id, framer_synced, result, created_at, updated_at"
        )
        .eq("run_id", run.id)
        .order("updated_at", { ascending: false })
        .limit(500),
    ])

    if (eventsResult.error) throw eventsResult.error
    if (queueResult.error) throw queueResult.error

    return res.json({
      ok: true,
      run,
      events: (eventsResult.data || []).reverse(),
      queue: queueResult.data || [],
      rotation_progress: rotationProgress || null,
    })
  } catch (error) {
    console.error("Telemetr status failed:", error)
    return res.status(500).json({ error: error.message })
  }
})

// ========================================
// GROWTH CHALLENGE FEEDBACK
// ========================================

const growthFeedbackRateLimit = new Map()

function cleanFeedbackText(value, maxLength) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength)
}

function feedbackClientIp(req) {
  return String(
    req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      ""
  )
    .split(",")[0]
    .trim()
}

app.post("/api/feedback/growth-challenge", async (req, res) => {
  try {
    const responseText = cleanFeedbackText(req.body?.response, 2000)
    const prompt = cleanFeedbackText(req.body?.prompt, 500)
    const source = cleanFeedbackText(
      req.body?.source || "growth-challenge-popup",
      100
    )
    const pageUrl = cleanFeedbackText(req.body?.page_url, 1000)
    const referrer = cleanFeedbackText(req.body?.referrer, 1000)
    const visitorId = cleanFeedbackText(req.body?.visitor_id, 200)
    const ipAddress = feedbackClientIp(req)
    const userAgent = cleanFeedbackText(req.headers["user-agent"], 500)

    if (responseText.length < 2) {
      return res.status(400).json({
        error: "Please enter a little more detail before submitting.",
      })
    }

    const rateKey = visitorId || ipAddress || "unknown"
    const now = Date.now()
    const lastSubmission = growthFeedbackRateLimit.get(rateKey) || 0

    if (now - lastSubmission < 60 * 1000) {
      return res.status(429).json({
        error: "Please wait a minute before submitting another response.",
      })
    }

    const { data, error } = await supabaseAdmin
      .from("growth_challenge_responses")
      .insert({
        response: responseText,
        prompt: prompt || null,
        source,
        page_url: pageUrl || null,
        referrer: referrer || null,
        visitor_id: visitorId || null,
        ip_address: ipAddress || null,
        user_agent: userAgent || null,
      })
      .select("id, created_at")
      .single()

    if (error) throw error

    growthFeedbackRateLimit.set(rateKey, now)

    return res.status(201).json({
      ok: true,
      response_id: data.id,
      created_at: data.created_at,
    })
  } catch (err) {
    console.error("Growth challenge feedback submission failed:", err)
    return res.status(500).json({
      error: "Your response could not be saved. Please try again.",
    })
  }
})

app.get("/api/admin/feedback/growth-challenges", async (req, res) => {
  try {
    const user = await getAdminUserFromRequest(req)

    if (!user) {
      return res.status(403).json({ error: "Admin access required." })
    }

    const requestedLimit = Number(req.query.limit || 250)
    const limit = Math.max(1, Math.min(requestedLimit, 500))

    const { data, error } = await supabaseAdmin
      .from("growth_challenge_responses")
      .select(
        "id, response, prompt, source, page_url, referrer, visitor_id, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) throw error

    return res.json({
      ok: true,
      responses: data || [],
      count: (data || []).length,
    })
  } catch (err) {
    console.error("Loading growth challenge feedback failed:", err)
    return res.status(500).json({
      error: err.message || "Could not load feedback responses.",
    })
  }
})



app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)

  // 24/7 automation state lives in Supabase, so a Render restart does not
  // disable it. If enabled, resume the worker after the server is listening.
  setTimeout(() => {
    getContinuousAutomationState()
      .then((state) => {
        if (state?.enabled) kickContinuousAutomationWorker()
      })
      .catch((error) =>
        console.error("Could not resume 24/7 automation on startup:", error)
      )
  }, 3000)
})
