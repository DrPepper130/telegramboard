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
// ONLINE COUNTER
// ========================================

// Start blank/hidden until first update happens
let fakeOnlineCount = null

function updateFakeOnlineCount() {
  // First real value: start somewhere between 1,000 and 2,000
  if (fakeOnlineCount === null) {
    fakeOnlineCount = Math.floor(Math.random() * 1001) + 1000
    return
  }

  // Change by 10–25 users per minute
  const changeAmount = Math.floor(Math.random() * 16) + 10

  // Randomly go up or down
  const direction = Math.random() < 0.5 ? -1 : 1

  fakeOnlineCount += changeAmount * direction

  // Keep it between 1,000 and 2,000
  if (fakeOnlineCount < 1000) fakeOnlineCount = 1000
  if (fakeOnlineCount > 2000) fakeOnlineCount = 2000
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

app.use(express.json())
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

  const json = await res.json()
  if (!json.ok) throw new Error(json.description || "Telegram API error")
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
  const listingType = normalizeTelegramType(chat.type)

  if (!listingType) {
    throw new Error("Could not detect whether this Telegram link is a group or channel.")
  }

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
      listing_type: listingType,
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", listing.id)

  if (error) throw error

  await supabaseAdmin.from("channel_member_snapshots").insert({
    listing_id: listing.id,
    member_count: memberCount,
    created_at: new Date().toISOString(),
  })
  
  return { chat, memberCount, iconUrl, listingType }
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
    listing.telegram_title ||
    listing.channel_name ||
    "Telegram Listing"

  const listingType = String(listing.listing_type || "channel").toLowerCase()
  const typeTitle = listingType.charAt(0).toUpperCase() + listingType.slice(1)
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
  const memberText = memberCount
    ? memberCount.toLocaleString()
    : "an updating number of"

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
    faq3Answer: `${name} is listed under ${categories || "General"} on TeleHub.`,
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

  try {
    await syncListingTelegramData(existingListing)
  } catch (err) {
    telegramSyncWarning = err.message
    console.warn("Telegram sync before Framer CMS sync failed:", err.message)
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

    const result = await queueFramerSync(() => syncListingToFramerCMS(listing_id))

    return res.json(result)
  } catch (err) {
    console.error("Framer listing sync error:", err)
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
          syncListingToFramerCMS(listing.id, { publish: false })
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
    await client.disconnect()
  } catch (err) {
    console.warn("MTProto disconnect warning:", err.message)
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

    // Sync Telegram data, then create/update the Framer CMS page.
    await syncListingTelegramData(listing)
    const framerResult = await queueFramerSync(() => syncListingToFramerCMS(listing.id))

    res.json({ ok: true, framer: framerResult })
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
      .eq("is_banned", false)

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

      const {
        data: snapshotData,
        error: snapshotError,
      } = await supabaseAdmin
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

    let homepageCache = null

    try {
      homepageCache = await updateHomepageListingCache()
    } catch (cacheErr) {
      console.error("Homepage cache refresh after sync failed:", cacheErr)
    }

    res.json({
      ok: true,
      results,
      homepage_cache: homepageCache
        ? {
            updated_at: homepageCache.updated_at,
            count: homepageCache.listings.length,
          }
        : null,
    })
      } catch (err) {
        console.error("Hourly sync error:", err)
        res.status(500).json({ error: err.message })
      }
    })




// ========================================
// ADMIN AI TELEGRAM LISTING IMPORT
// ========================================

const DEFAULT_ADMIN_IMPORT_LIMIT = 25
const MAX_ADMIN_IMPORT_LIMIT = 50
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

function sanitizeAiImportContent(raw, fallback) {
  const source = raw && typeof raw === "object" ? raw : {}

  let description = String(source.description || fallback.description || "").trim()
  let longDescription = String(source.long_description || source.longDescription || fallback.long_description || "").trim()
  let categories = Array.isArray(source.categories) ? source.categories : fallback.categories

  categories = uniqueValues(
    (categories || [])
      .map((cat) => String(cat || "").trim())
      .filter(Boolean)
      .map((cat) => cat.charAt(0).toUpperCase() + cat.slice(1))
  ).slice(0, 5)

  if (!categories.length) categories = fallback.categories

  if (!description) description = fallback.description
  if (!longDescription) longDescription = fallback.long_description

  description = description.slice(0, 250)
  longDescription = longDescription.slice(0, 2000)

  return {
    description,
    long_description: longDescription,
    categories,
    is_nsfw: source.is_nsfw === true,
  }
}

function fallbackImportContent({ title, username, telegramDescription, memberCount, listingType }) {
  const typeLabel = listingType === "group" ? "group" : "channel"
  const name = title || username || "This Telegram community"
  const baseText = [title, username, telegramDescription].filter(Boolean).join(" ")
  const categories = makeImportFallbackCategories(baseText, listingType)
  const memberText = memberCount ? `${Number(memberCount).toLocaleString()} members` : "an active audience"

  const description = telegramDescription
    ? String(telegramDescription).slice(0, 240)
    : `${name} is a Telegram ${typeLabel} listed on TeleHub with ${memberText}.`

  const long_description = telegramDescription
    ? `${telegramDescription}\n\n${name} is listed on TeleHub so users can discover its Telegram link, category, member count, and community details.`
    : `${name} is a Telegram ${typeLabel} listed on TeleHub. Explore this listing to view its Telegram link, member count, category, and community details before joining.`

  return {
    description: description.slice(0, 250),
    long_description: long_description.slice(0, 2000),
    categories,
    is_nsfw: false,
  }
}

async function generateAiImportContent(input) {
  const fallback = fallbackImportContent(input)
  const styleAngles = ["direct utility listing", "casual Telegram promo", "clean directory summary", "community-focused listing", "creator/news update listing", "fan/community listing", "short punchy listing", "professional but not corporate listing"]
  const styleAngle = styleAngles[Math.floor(Math.random() * styleAngles.length)]
  
  if (!process.env.OPENAI_API_KEY) {
    return {
      ...fallback,
      ai_used: false,
      ai_error: "OPENAI_API_KEY is not set; used fallback content.",
    }
  }
  
  try {
    const prompt = {
      telegram_title: input.title || "",
      telegram_username: input.username || "",
      telegram_description: input.telegramDescription || "",
      member_count: Number(input.memberCount || 0),
      listing_type: input.listingType || "channel",
      writing_style: styleAngle,
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_IMPORT_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.95,
        presence_penalty: 0.6,
        frequency_penalty: 0.5,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "You generate realistic, varied listing copy for TeleHub, a Telegram group/channel directory. Follow the writing_style provided in the user JSON. Return ONLY valid JSON: {\"description\":string,\"long_description\":string,\"categories\":string[],\"is_nsfw\":boolean}. The description must NOT use generic repeated openings like \"Join\", \"Stay updated\", \"Welcome to\", \"Discover\", \"This is\", \"A Telegram\", or \"[Name] is\" unless absolutely necessary. Every listing must use a different sentence structure and tone based on the source: some should sound like a fan/community listing, some like a clean directory summary, some like a direct utility listing, some like a creator/news listing, and some like a casual Telegram promo. Use the Telegram title, username, bio, member count, and listing type as the only source. Rewrite the bio into natural human copy; do not copy the bio word-for-word. Use 0-3 relevant emojis only when they fit the original vibe. Do not invent official status, guarantees, discounts, pricing, safety, verification, or trust claims. Only say official if the source clearly says official. description must be 120-240 characters, punchy, specific, and card-ready. long_description must be 500-1100 characters in 1-3 short paragraphs, explaining what users may find, who it is for, and why someone might join, without sounding corporate or AI-written. categories must be 2-5 short Title Case tags, specific first and broad second. is_nsfw is true only for clearly adult, explicit, sexual, gambling, drugs, or mature content.",
          },
          {
            role: "user",
            content: JSON.stringify(prompt),
          },
        ],
      }),
    })

    const json = await response.json()

    if (!response.ok) {
      throw new Error(json?.error?.message || "OpenAI request failed")
    }

    const content = json?.choices?.[0]?.message?.content || "{}"
    const parsed = JSON.parse(content)
    const sanitized = sanitizeAiImportContent(parsed, fallback)

    return {
      ...sanitized,
      ai_used: true,
      ai_error: null,
    }
  } catch (err) {
    console.error("AI import content generation failed:", err.message)
    return {
      ...fallback,
      ai_used: false,
      ai_error: err.message,
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

async function importSingleTelegramListing(link, options, adminUser) {
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

  const chat = await tg("getChat", { chat_id: username })
  const listingType = normalizeTelegramType(chat.type)

  if (!listingType) {
    return {
      ok: false,
      link: telegramLink,
      error: "Could not detect whether this Telegram link is a group or channel.",
    }
  }

  const telegramUsername = cleanUsername(chat.username) || username
  const normalizedTelegramLink = chat.username
    ? `https://t.me/${chat.username}`
    : telegramLink

  const duplicate = await findDuplicateImportListing({
    telegramChatId: String(chat.id),
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
    }
  }

  const memberCount = await tg("getChatMemberCount", { chat_id: chat.id })
  const telegramDescription = chat.description || chat.bio || ""

  const aiContent = await generateAiImportContent({
    title: chat.title || telegramUsername,
    username: telegramUsername,
    telegramDescription,
    memberCount,
    listingType,
  })

  const shortInviteBase = stripTelegramHandle(telegramUsername) || chat.title || "telegram-listing"
  const shortInvite = await generateUniqueShortInviteFromBase(shortInviteBase)

  const insertPayload = {
    user_id: adminUser.id,
    listing_type: listingType,
    channel_name: chat.title || stripTelegramHandle(telegramUsername) || "Telegram Listing",
    telegram_link: normalizedTelegramLink,
    description: aiContent.description,
    long_description: aiContent.long_description,
    categories: aiContent.categories,
    is_nsfw: aiContent.is_nsfw,
    short_invite: shortInvite,
    slug: `${listingType}-${slugifyImportValue(chat.title || telegramUsername)}-${Date.now().toString().slice(-6)}`,
    status: "approved",
    admin_reviewed: false,
    telegram_chat_id: String(chat.id),
    telegram_username: telegramUsername,
    telegram_title: chat.title || null,
    telegram_description: telegramDescription || null,
    member_count: memberCount,
    votes_count: 0,
    last_synced_at: new Date().toISOString(),
    framer_sync_status: options.syncToFramer ? "not_synced" : null,
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("channel_listings")
    .insert(insertPayload)
    .select("id, short_invite")
    .single()

  if (insertError) throw insertError

  let iconUrl = null
  let iconError = null

  if (chat.photo?.big_file_id) {
    try {
      iconUrl = await uploadTelegramPhoto(chat.photo.big_file_id, inserted.id)
    } catch (err) {
      iconError = err.message
      console.error("Auto import icon upload failed:", err.message)
    }
  }

  if (iconUrl) {
    const { error: imageUpdateError } = await supabaseAdmin
      .from("channel_listings")
      .update({
        icon_url: iconUrl,
        image_url: options.useIconAsBackground ? iconUrl : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", inserted.id)

    if (imageUpdateError) throw imageUpdateError
  }

  let framerResult = null
  let framerError = null

  if (options.syncToFramer) {
    try {
      framerResult = await queueFramerSync(() =>
        syncListingToFramerCMS(inserted.id, { publish: false })
      )
    } catch (err) {
      framerError = err.message
      console.error("Auto import Framer sync failed:", err.message)
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
    ai_used: aiContent.ai_used,
    ai_error: aiContent.ai_error,
    icon_url: iconUrl,
    icon_error: iconError,
    framer_synced: !!framerResult?.ok,
    framer_error: framerError,
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

    const options = {
      syncToFramer: req.body?.sync_to_framer !== false,
      useIconAsBackground: req.body?.use_icon_as_background !== false,
    }

    const results = []

    for (const link of linksToImport) {
      try {
        const result = await importSingleTelegramListing(link, options, user)
        results.push(result)
      } catch (err) {
        console.error("Auto import listing failed:", link, err)
        results.push({
          ok: false,
          link,
          error: err.message || "Import failed.",
        })
      }
    }

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

    const summary = {
      total_received: links.length,
      processed: linksToImport.length,
      created: results.filter((item) => item.created).length,
      duplicates: results.filter((item) => item.skipped).length,
      failed: results.filter((item) => item.ok === false).length,
      framer_synced: results.filter((item) => item.framer_synced).length,
      deployed,
    }

    return res.json({
      ok: true,
      ...summary,
      limit,
      remaining_not_processed: Math.max(0, links.length - linksToImport.length),
      results,
      homepage_cache: homepageCache
        ? {
            updated_at: homepageCache.updated_at,
            count: homepageCache.listings.length,
          }
        : null,
    })
  } catch (err) {
    console.error("Admin Telegram import error:", err)
    return res.status(500).json({ error: err.message })
  }
})


const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
