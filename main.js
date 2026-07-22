import * as React from "react"
import { addPropertyControls, ControlType } from "framer"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const supabase = createClient(
    "https://mbifjgsfuzsnkuwllrjy.supabase.co",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1iaWZqZ3NmdXpzbmt1d2xscmp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODE4NTAsImV4cCI6MjA5MjU1Nzg1MH0.OT6jH27KuGl3sgTcdce0gBR_rz2WPIivg-jGi52sKR8"
)

type TabName = "pending" | "changes" | "banned" | "import"

const BACKEND_URL = "https://telegramboard.onrender.com"
const IMAGE_BUCKET = "listing-images"

const MOD_FIELDS = [
    "listing_type",
    "channel_name",
    "telegram_link",
    "description",
    "long_description",
    "categories",
    "image_url",
    "icon_url",
    "telegram_username",
    "telegram_title",
    "telegram_description",
    "member_count",
    "votes_count",
    "is_nsfw",
    "short_invite",
    "status",
]

// Old-style frontend admin check.
// Add more user IDs or emails here if needed.
const ADMIN_USER_IDS = [
    "0a908330-be3d-44ad-af73-c7113fa1e41d",
    "f63dca60-e46c-494d-9909-a4554b2ae904",
    "eb65ec8c-ced2-4f25-807e-6a733aa75f08",
]
const ADMIN_EMAILS: string[] = []

export default function TelecadiaAdminListings(props: { loginPath: string }) {
    const { loginPath } = props

    const [loading, setLoading] = React.useState(true)
    const [user, setUser] = React.useState<any>(null)
    const [isAdmin, setIsAdmin] = React.useState(false)

    const [activeTab, setActiveTab] = React.useState<TabName>("changes")
    const [pendingListings, setPendingListings] = React.useState<any[]>([])
    const [pendingImageFiles, setPendingImageFiles] = React.useState<
        Record<string, File | null>
    >({})
    const [pendingImagePreviews, setPendingImagePreviews] = React.useState<
        Record<string, string>
    >({})
    const [savingListingId, setSavingListingId] = React.useState("")
    const [changes, setChanges] = React.useState<any[]>([])
    const [bannedListings, setBannedListings] = React.useState<any[]>([])

    const [error, setError] = React.useState("")
    const [message, setMessage] = React.useState("")
    const [importLinks, setImportLinks] = React.useState("")
    const [importing, setImporting] = React.useState(false)
    const [importResults, setImportResults] = React.useState<any[]>([])
    const [importUseIconAsBackground, setImportUseIconAsBackground] =
        React.useState(true)
    const [importSyncToFramer, setImportSyncToFramer] = React.useState(true)
    const [telegramRetryAfter, setTelegramRetryAfter] = React.useState(0)

    React.useEffect(() => {
        loadAdminPanel()
    }, [])

    React.useEffect(() => {
        if (telegramRetryAfter <= 0) return

        const timer = window.setInterval(() => {
            setTelegramRetryAfter((seconds) => Math.max(0, seconds - 1))
        }, 1000)

        return () => window.clearInterval(timer)
    }, [telegramRetryAfter > 0])

    async function loadAdminPanel() {
        setLoading(true)
        setError("")
        setMessage("")

        const { data: sessionData, error: sessionError } =
            await supabase.auth.getSession()

        if (sessionError) {
            setError(sessionError.message)
            setLoading(false)
            return
        }

        const currentUser = sessionData.session?.user ?? null
        setUser(currentUser)

        if (!currentUser) {
            setLoading(false)
            return
        }

        const token = sessionData.session?.access_token

        if (!token) {
            setIsAdmin(false)
            setLoading(false)
            return
        }

        const adminRes = await fetch(`${BACKEND_URL}/api/auth/is-admin`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
            },
        })

        const adminData = await adminRes.json().catch(() => ({}))
        const allowed = adminRes.ok && adminData?.isAdmin === true

        if (!allowed) {
            setIsAdmin(false)
            setLoading(false)
            return
        }

        setIsAdmin(true)

        await Promise.all([
            loadPendingListings(),
            loadRecentChanges(),
            loadBannedListings(),
        ])

        setLoading(false)
    }

    async function loadPendingListings() {
        const sevenDaysAgo = new Date(
            Date.now() - 7 * 24 * 60 * 60 * 1000
        ).toISOString()

        const { data, error } = await supabase
            .from("channel_listings")
            .select("*")
            .eq("admin_reviewed", false)
            .eq("is_banned", false)
            .eq("status", "approved")
            .gte("created_at", sevenDaysAgo)
            .order("created_at", { ascending: false })

        if (error) {
            setError(error.message)
            return
        }

        setPendingListings(data || [])
    }

    async function loadRecentChanges() {
        const { data, error } = await supabase
            .from("channel_listing_changes")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(60)

        if (error) {
            setError(error.message)
            return
        }

        setChanges(data || [])
    }

    async function loadBannedListings() {
        const { data, error } = await supabase
            .from("channel_listings")
            .select("*")
            .eq("is_banned", true)
            .order("updated_at", { ascending: false })

        if (error) {
            setError(error.message)
            return
        }

        setBannedListings(data || [])
    }

    function updatePendingField(id: string, field: string, value: any) {
        setPendingListings((prev) =>
            prev.map((listing) =>
                listing.id === id ? { ...listing, [field]: value } : listing
            )
        )
    }

    function handlePendingBackgroundSelect(
        listingId: string,
        event: React.ChangeEvent<HTMLInputElement>
    ) {
        const file = event.target.files?.[0]
        setError("")

        if (!file) return
        if (!file.type.startsWith("image/")) {
            setError("Please upload an image file.")
            return
        }
        if (file.size > 5 * 1024 * 1024) {
            setError("Background image must be under 5MB.")
            return
        }

        const previousPreview = pendingImagePreviews[listingId]
        if (previousPreview?.startsWith("blob:")) {
            URL.revokeObjectURL(previousPreview)
        }

        setPendingImageFiles((prev) => ({ ...prev, [listingId]: file }))
        setPendingImagePreviews((prev) => ({
            ...prev,
            [listingId]: URL.createObjectURL(file),
        }))
    }

    async function uploadPendingBackground(
        listingId: string,
        currentImageUrl: string | null
    ) {
        const file = pendingImageFiles[listingId]
        if (!file) return currentImageUrl || null
        if (!user?.id) throw new Error("You must be logged in.")

        const rawExt = file.name.split(".").pop() || "jpg"
        const cleanExt = rawExt.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg"
        const filePath = `${user.id}/admin-${listingId}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}.${cleanExt}`

        const { error: uploadError } = await supabase.storage
            .from(IMAGE_BUCKET)
            .upload(filePath, file, {
                cacheControl: "3600",
                upsert: false,
                contentType: file.type,
            })

        if (uploadError) throw uploadError

        const { data } = supabase.storage
            .from(IMAGE_BUCKET)
            .getPublicUrl(filePath)

        return data.publicUrl
    }

    async function getAccessToken() {
        const { data: sessionData, error: sessionError } =
            await supabase.auth.getSession()

        if (sessionError) throw sessionError

        const token = sessionData.session?.access_token

        if (!token) {
            throw new Error("Your admin session expired. Log in again.")
        }

        return token
    }

    async function syncAdminListingChange(
        listingId: string,
        changedFields: string[],
        options?: { forceFullSync?: boolean }
    ) {
        const token = await getAccessToken()
        const forceFullSync =
            options?.forceFullSync === true ||
            changedFields.includes("short_invite")

        const endpoint = forceFullSync
            ? "/api/framer/sync-listing"
            : "/api/framer/sync-content-change"

        const body = forceFullSync
            ? { listing_id: listingId }
            : {
                  listing_id: listingId,
                  changed_fields: changedFields,
              }

        const res = await fetch(`${BACKEND_URL}${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        })

        const data = await res.json().catch(() => ({}))

        if (!res.ok) {
            throw new Error(
                data?.error ||
                    "The listing was saved, but its public page did not refresh."
            )
        }

        return data
    }

    async function updateStatus(id: string, status: "approved" | "rejected") {
        setError("")
        setMessage("")
        setSavingListingId(id)

        try {
            const listing = pendingListings.find((item) => item.id === id)
            if (!listing) throw new Error("Listing could not be found.")

            if (status === "approved") {
                const finalImageUrl = await uploadPendingBackground(
                    id,
                    listing.image_url || null
                )

                const { error } = await supabase
                    .from("channel_listings")
                    .update({
                        listing_type: listing.listing_type || "channel",
                        channel_name: String(listing.channel_name || "").trim(),
                        telegram_title: String(
                            listing.telegram_title || ""
                        ).trim(),
                        telegram_username: String(
                            listing.telegram_username || ""
                        ).trim(),
                        telegram_link: String(
                            listing.telegram_link || ""
                        ).trim(),
                        description: String(listing.description || "").trim(),
                        long_description: String(
                            listing.long_description || ""
                        ).trim(),
                        telegram_description: String(
                            listing.telegram_description || ""
                        ).trim(),
                        member_count: Number(listing.member_count || 0),
                        votes_count: Number(listing.votes_count || 0),
                        short_invite: String(listing.short_invite || "").trim(),
                        is_nsfw: Boolean(listing.is_nsfw),
                        image_url: finalImageUrl,
                        status: "approved",
                        admin_reviewed: true,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", id)

                if (error) throw error

                await syncAdminListingChange(
                    id,
                    [
                        "listing_type",
                        "channel_name",
                        "telegram_title",
                        "telegram_username",
                        "telegram_link",
                        "description",
                        "long_description",
                        "telegram_description",
                        "short_invite",
                        "is_nsfw",
                        "image_url",
                        "status",
                    ],
                    {
                        forceFullSync: true,
                    }
                )
            } else {
                const { error } = await supabase
                    .from("channel_listings")
                    .update({
                        status: "rejected",
                        admin_reviewed: true,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", id)

                if (error) throw error
            }

            const preview = pendingImagePreviews[id]
            if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview)

            setPendingImageFiles((prev) => {
                const next = { ...prev }
                delete next[id]
                return next
            })
            setPendingImagePreviews((prev) => {
                const next = { ...prev }
                delete next[id]
                return next
            })

            setPendingListings((prev) => prev.filter((item) => item.id !== id))
            setMessage(
                status === "approved"
                    ? "Listing edits saved, approved, and public page refreshed."
                    : "Listing rejected."
            )

            await Promise.all([
                loadRecentChanges(),
                loadBannedListings(),
                loadPendingListings(),
            ])
        } catch (err: any) {
            setError(err?.message || "Status update failed.")
        } finally {
            setSavingListingId("")
        }
    }

    async function banListing(
        listingId: string,
        reason = "Temporarily banned by admin."
    ) {
        setError("")
        setMessage("")

        const { error } = await supabase
            .from("channel_listings")
            .update({
                is_banned: true,
                admin_reviewed: true,
                ban_reason: reason,
                updated_at: new Date().toISOString(),
            })
            .eq("id", listingId)

        if (error) {
            setError(error.message)
            return
        }

        setMessage("Listing temporarily banned.")
        await Promise.all([
            loadRecentChanges(),
            loadBannedListings(),
            loadPendingListings(),
        ])
    }

    async function unbanListing(listingId: string) {
        setError("")
        setMessage("")

        const { error } = await supabase
            .from("channel_listings")
            .update({
                is_banned: false,
                ban_reason: null,
                updated_at: new Date().toISOString(),
            })
            .eq("id", listingId)

        if (error) {
            setError(error.message)
            return
        }

        try {
            await syncAdminListingChange(listingId, ["status"], {
                forceFullSync: true,
            })
            setMessage("Listing unbanned and public page refreshed.")
        } catch (syncError: any) {
            setError(
                syncError?.message ||
                    "Listing was unbanned, but its public page did not refresh."
            )
            setMessage("Listing unbanned.")
        }

        await loadBannedListings()
    }

    async function revertChange(change: any) {
        setError("")
        setMessage("")

        const ok = window.confirm(
            "Revert this listing back to the old version from before this change?"
        )

        if (!ok) return

        const oldData = change.old_data || {}
        const listingId = change.listing_id

        const revertPayload: any = {}

        MOD_FIELDS.forEach((field) => {
            if (Object.prototype.hasOwnProperty.call(oldData, field)) {
                revertPayload[field] = oldData[field]
            }
        })

        revertPayload.updated_at = new Date().toISOString()

        const { error } = await supabase
            .from("channel_listings")
            .update(revertPayload)
            .eq("id", listingId)

        if (error) {
            setError(error.message)
            return
        }

        const revertedFields = Object.keys(revertPayload).filter(
            (field) => field !== "updated_at"
        )

        try {
            await syncAdminListingChange(listingId, revertedFields, {
                forceFullSync: revertedFields.includes("short_invite"),
            })
        } catch (syncError: any) {
            setError(
                syncError?.message ||
                    "Change reverted, but the public page did not refresh."
            )
        }

        await supabase.from("channel_listing_changes").insert({
            listing_id: listingId,
            changed_by: user?.id || null,
            change_type: "admin_revert",
            old_data: change.new_data || {},
            new_data: revertPayload,
        })

        setMessage("Change reverted and public page refreshed.")
        await loadRecentChanges()
    }

    function changedFields(change: any) {
        const oldData = change.old_data || {}
        const newData = change.new_data || {}

        return MOD_FIELDS.filter((field) => {
            const oldValue = JSON.stringify(oldData[field] ?? null)
            const newValue = JSON.stringify(newData[field] ?? null)
            return oldValue !== newValue
        })
    }

    function formatValue(value: any) {
        if (Array.isArray(value)) return value.join(", ")
        if (value === true) return "Yes"
        if (value === false) return "No"
        if (value === null || value === undefined || value === "")
            return "Empty"
        return String(value)
    }

    function listingNameFromChange(change: any) {
        return (
            change.new_data?.channel_name ||
            change.old_data?.channel_name ||
            "Changed listing"
        )
    }

    function listingLinkFromChange(change: any) {
        return (
            change.new_data?.telegram_link ||
            change.old_data?.telegram_link ||
            ""
        )
    }

    function titleForListing(listing: any) {
        return (
            listing.telegram_title || listing.channel_name || "Telegram Listing"
        )
    }

    function getListingType(item: any) {
        const raw =
            item?.listing_type ||
            item?.new_data?.listing_type ||
            item?.old_data?.listing_type ||
            "channel"

        return String(raw).toLowerCase() === "group" ? "group" : "channel"
    }

    function listingTypeLabel(item: any) {
        return getListingType(item) === "group" ? "👥 Group" : "📢 Channel"
    }

    function listingNoun(item: any) {
        return getListingType(item) === "group" ? "group" : "channel"
    }

    function shortInviteUrl(code: string) {
        if (!code) return ""
        return `${window.location.origin}/go?code=${encodeURIComponent(code)}`
    }

    function getReviewImage(item: any) {
        return (
            item?.image_url ||
            item?.new_data?.image_url ||
            item?.old_data?.image_url ||
            ""
        )
    }

    function getReviewIcon(item: any) {
        return (
            item?.icon_url ||
            item?.new_data?.icon_url ||
            item?.old_data?.icon_url ||
            ""
        )
    }

    function getListingUrl(item: any) {
        const slug = item?.slug || item?.new_data?.slug || item?.old_data?.slug
        if (!slug) return ""
        return `${window.location.origin}/channel?slug=${encodeURIComponent(slug)}`
    }

    function copyText(value: string) {
        navigator.clipboard?.writeText(value)
        setMessage("Copied.")
    }

    function formatRetryTime(totalSeconds: number) {
        const seconds = Math.max(0, Math.floor(totalSeconds || 0))
        const hours = Math.floor(seconds / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        const remainingSeconds = seconds % 60

        if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`
        if (minutes > 0) return `${minutes}m ${remainingSeconds}s`
        return `${remainingSeconds}s`
    }

    async function importTelegramListings() {
        setError("")
        setMessage("")
        setImportResults([])

        if (telegramRetryAfter > 0) {
            setError(
                `Telegram is still rate-limiting imports. Try again in ${formatRetryTime(
                    telegramRetryAfter
                )}.`
            )
            return
        }

        const links = importLinks
            .split(/[\n,]+/g)
            .map((link) => link.trim())
            .filter(Boolean)

        if (!links.length) {
            setError("Paste at least one public Telegram link.")
            return
        }

        setImporting(true)

        try {
            const { data: sessionData, error: sessionError } =
                await supabase.auth.getSession()

            if (sessionError) throw sessionError

            const token = sessionData.session?.access_token

            if (!token) {
                throw new Error("You need to log in before importing listings.")
            }

            const res = await fetch(
                `${BACKEND_URL}/api/admin/import-telegram-listings`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        links,
                        sync_to_framer: importSyncToFramer,
                        use_icon_as_background: importUseIconAsBackground,
                        limit: 5,
                    }),
                }
            )

            const data = await res.json().catch(() => ({}))
            setImportResults(data.results || [])

            if (
                res.status === 429 ||
                data?.code === "TELEGRAM_RATE_LIMITED" ||
                data?.rate_limit?.code === "TELEGRAM_RATE_LIMITED"
            ) {
                const retryAfter = Number(
                    data?.retry_after_seconds ||
                        data?.rate_limit?.retry_after_seconds ||
                        0
                )

                setTelegramRetryAfter(retryAfter)

                if (Array.isArray(data?.unprocessed_links)) {
                    setImportLinks(data.unprocessed_links.join("\n"))
                }

                setError(
                    `Telegram temporarily rate-limited the importer. Try again in ${formatRetryTime(
                        retryAfter
                    )}. ${
                        data?.remaining_not_processed || 0
                    } link(s) were kept in the box and were not processed.`
                )

                if ((data?.created || 0) > 0) {
                    setMessage(
                        `Before the rate limit: ${data.created} added and ${
                            data.duplicates || 0
                        } skipped.`
                    )
                }

                return
            }

            if (!res.ok) {
                throw new Error(data?.error || "Import failed.")
            }

            setMessage(
                `Import finished: ${data.created || 0} added, ${
                    data.duplicates || 0
                } skipped, ${data.failed || 0} failed.`
            )

            if ((data.remaining_not_processed || 0) > 0) {
                if (Array.isArray(data?.unprocessed_links)) {
                    setImportLinks(data.unprocessed_links.join("\n"))
                }

                setError(
                    `${data.remaining_not_processed} links were not processed because this tool imports 5 at a time. The remaining links were kept in the box.`
                )
            } else {
                setImportLinks("")
            }

            await Promise.all([
                loadPendingListings(),
                loadRecentChanges(),
                loadBannedListings(),
            ])
        } catch (err: any) {
            setError(err?.message || "Import failed.")
        } finally {
            setImporting(false)
        }
    }

    if (loading) {
        return (
            <div style={pageWrap}>
                <div style={cardStyle}>
                    <p style={subtitleStyle}>Loading admin panel...</p>
                </div>
            </div>
        )
    }

    if (!user) {
        return (
            <div style={pageWrap}>
                <div style={cardStyle}>
                    <h1 style={titleStyle}>Log in required</h1>
                    <p style={subtitleStyle}>
                        You need to log in before accessing the admin panel.
                    </p>
                    <a href={loginPath || "/login"} style={primaryLink}>
                        Log in
                    </a>
                </div>
            </div>
        )
    }

    if (!isAdmin) {
        return (
            <div style={pageWrap}>
                <div style={cardStyle}>
                    <h1 style={titleStyle}>Access denied</h1>
                    <p style={subtitleStyle}>
                        This page is only available to TeleHub admins.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div style={pageWrap}>
            <div style={panelStyle}>
                <div style={topRow}>
                    <div>
                        <h1 style={titleStyle}>Admin Panel</h1>
                        <p style={subtitleStyle}>
                            Posts and edits can go live while you still review,
                            revert, or temporarily ban bad listings.
                        </p>
                    </div>

                    <button onClick={loadAdminPanel} style={secondaryBtn}>
                        Refresh
                    </button>
                </div>

                <div style={tabsRow}>
                    <button
                        onClick={() => setActiveTab("changes")}
                        style={{
                            ...tabBtn,
                            ...(activeTab === "changes" ? tabBtnActive : {}),
                        }}
                    >
                        Recent Changes ({changes.length})
                    </button>
                    <button
                        onClick={() => setActiveTab("pending")}
                        style={{
                            ...tabBtn,
                            ...(activeTab === "pending" ? tabBtnActive : {}),
                        }}
                    >
                        New Posts ({pendingListings.length})
                    </button>
                    <button
                        onClick={() => setActiveTab("banned")}
                        style={{
                            ...tabBtn,
                            ...(activeTab === "banned" ? tabBtnActive : {}),
                        }}
                    >
                        Banned ({bannedListings.length})
                    </button>
                    <button
                        onClick={() => setActiveTab("import")}
                        style={{
                            ...tabBtn,
                            ...(activeTab === "import" ? tabBtnActive : {}),
                        }}
                    >
                        Auto Import
                    </button>
                </div>

                {message ? <div style={successStyle}>{message}</div> : null}
                {error ? <div style={errorStyle}>{error}</div> : null}

                {activeTab === "import" ? (
                    <div style={importPanelStyle}>
                        <div style={importHeaderRow}>
                            <div>
                                <h2 style={importTitleStyle}>
                                    Auto import Telegram listings
                                </h2>
                                <p style={importSubtitleStyle}>
                                    Paste public Telegram links, one per line.
                                    TeleHub will pull the Telegram info, create
                                    descriptions and tags with AI, add the
                                    listings, and update the public pages.
                                </p>
                            </div>
                        </div>

                        <textarea
                            value={importLinks}
                            onChange={(e) => setImportLinks(e.target.value)}
                            placeholder={
                                "https://t.me/examplechannel\n@anotherchannel\nt.me/examplegroup"
                            }
                            style={importTextareaStyle}
                        />

                        <div style={importOptionsGrid}>
                            <label style={importOptionStyle}>
                                <input
                                    type="checkbox"
                                    checked={importUseIconAsBackground}
                                    onChange={(e) =>
                                        setImportUseIconAsBackground(
                                            e.target.checked
                                        )
                                    }
                                />
                                <span>
                                    Use Telegram icon as the background image
                                </span>
                            </label>

                            <label style={importOptionStyle}>
                                <input
                                    type="checkbox"
                                    checked={importSyncToFramer}
                                    onChange={(e) =>
                                        setImportSyncToFramer(e.target.checked)
                                    }
                                />
                                <span>Create public pages automatically</span>
                            </label>
                        </div>

                        <div style={importHelpBox}>
                            This imports up to 5 links at a time with a short
                            delay between each one. Public t.me usernames only.
                            Private invite links usually cannot be imported
                            automatically.
                        </div>

                        <div style={buttonRow}>
                            <button
                                onClick={importTelegramListings}
                                disabled={importing || telegramRetryAfter > 0}
                                style={{
                                    ...approveBtn,
                                    opacity:
                                        importing || telegramRetryAfter > 0
                                            ? 0.7
                                            : 1,
                                    cursor:
                                        importing || telegramRetryAfter > 0
                                            ? "not-allowed"
                                            : "pointer",
                                }}
                            >
                                {importing
                                    ? "Importing listings..."
                                    : telegramRetryAfter > 0
                                      ? `Retry in ${formatRetryTime(
                                            telegramRetryAfter
                                        )}`
                                      : "Import Listings"}
                            </button>

                            <button
                                onClick={() => {
                                    setImportLinks("")
                                    setImportResults([])
                                }}
                                disabled={importing}
                                style={secondaryBtn}
                            >
                                Clear
                            </button>
                        </div>

                        {importResults.length > 0 ? (
                            <div style={importResultsGrid}>
                                {importResults.map((result, index) => (
                                    <div
                                        key={`${result.link || index}-${index}`}
                                        style={
                                            result.ok === false
                                                ? importResultErrorCard
                                                : result.skipped
                                                  ? importResultSkippedCard
                                                  : importResultCard
                                        }
                                    >
                                        <div style={importResultTopLine}>
                                            <strong>
                                                {result.created
                                                    ? result.channel_name ||
                                                      "Imported listing"
                                                    : result.skipped
                                                      ? result.existing_name ||
                                                        "Already listed"
                                                      : "Import failed"}
                                            </strong>
                                            <span>
                                                {result.created
                                                    ? "Added"
                                                    : result.skipped
                                                      ? "Skipped"
                                                      : "Failed"}
                                            </span>
                                        </div>

                                        <div style={importResultMeta}>
                                            {result.link || "Unknown link"}
                                        </div>

                                        {result.short_invite ? (
                                            <div style={importResultMeta}>
                                                Page: /channel/
                                                {result.short_invite}
                                            </div>
                                        ) : null}

                                        {Array.isArray(result.categories) &&
                                        result.categories.length ? (
                                            <div style={categoryWrap}>
                                                {result.categories.map(
                                                    (cat: string) => (
                                                        <span
                                                            key={cat}
                                                            style={categoryPill}
                                                        >
                                                            {cat}
                                                        </span>
                                                    )
                                                )}
                                            </div>
                                        ) : null}

                                        {result.error || result.ai_error ? (
                                            <div style={importResultErrorText}>
                                                {result.error ||
                                                    `AI note: ${result.ai_error}`}
                                            </div>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {activeTab === "changes" ? (
                    changes.length === 0 ? (
                        <div style={emptyStyle}>No recent listing changes.</div>
                    ) : (
                        <div style={listGrid}>
                            {changes.map((change) => {
                                const fields = changedFields(change)
                                const telegramLink =
                                    listingLinkFromChange(change)

                                return (
                                    <div key={change.id} style={listingCard}>
                                        <div style={listingTop}>
                                            <div>
                                                <h2 style={listingTitle}>
                                                    {listingNameFromChange(
                                                        change
                                                    )}
                                                </h2>

                                                {telegramLink ? (
                                                    <a
                                                        href={telegramLink}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        style={listingLink}
                                                    >
                                                        {telegramLink}
                                                    </a>
                                                ) : null}
                                            </div>

                                            <div style={badgeStack}>
                                                <span style={typeBadge}>
                                                    {listingTypeLabel(change)}
                                                </span>
                                                <span style={changeBadge}>
                                                    {change.change_type ||
                                                        "edit"}
                                                </span>
                                            </div>
                                        </div>

                                        <div style={metaStyle}>
                                            Changed:{" "}
                                            {change.created_at
                                                ? new Date(
                                                      change.created_at
                                                  ).toLocaleString()
                                                : "Unknown"}
                                        </div>

                                        <div style={changeSummaryBox}>
                                            <strong>Change summary:</strong>{" "}
                                            {fields.length
                                                ? fields
                                                      .map((field) =>
                                                          field.replaceAll(
                                                              "_",
                                                              " "
                                                          )
                                                      )
                                                      .join(", ")
                                                : "No visible field changes found."}
                                        </div>

                                        {change.old_data?.image_url ||
                                        change.new_data?.image_url ? (
                                            <div style={imageCompareGrid}>
                                                <div>
                                                    <strong
                                                        style={sectionMiniTitle}
                                                    >
                                                        Old image
                                                    </strong>
                                                    {change.old_data
                                                        ?.image_url ? (
                                                        <div
                                                            style={{
                                                                ...smallImagePreview,
                                                                backgroundImage: `linear-gradient(rgba(9,20,45,0.22), rgba(9,20,45,0.5)), url(${change.old_data.image_url})`,
                                                            }}
                                                        />
                                                    ) : (
                                                        <div
                                                            style={
                                                                emptyMiniStyle
                                                            }
                                                        >
                                                            No old image
                                                        </div>
                                                    )}
                                                </div>

                                                <div>
                                                    <strong
                                                        style={sectionMiniTitle}
                                                    >
                                                        New image
                                                    </strong>
                                                    {change.new_data
                                                        ?.image_url ? (
                                                        <div
                                                            style={{
                                                                ...smallImagePreview,
                                                                backgroundImage: `linear-gradient(rgba(9,20,45,0.22), rgba(9,20,45,0.5)), url(${change.new_data.image_url})`,
                                                            }}
                                                        />
                                                    ) : (
                                                        <div
                                                            style={
                                                                emptyMiniStyle
                                                            }
                                                        >
                                                            No new image
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ) : null}

                                        <div style={infoGrid}>
                                            <InfoRow
                                                label="Type"
                                                value={listingTypeLabel(change)}
                                            />
                                            <InfoRow
                                                label="Listing ID"
                                                value={change.listing_id}
                                            />
                                            <InfoRow
                                                label="Short invite"
                                                value={
                                                    change.new_data
                                                        ?.short_invite
                                                        ? shortInviteUrl(
                                                              change.new_data
                                                                  .short_invite
                                                          )
                                                        : "Empty"
                                                }
                                            />
                                            <InfoRow
                                                label="NSFW"
                                                value={
                                                    change.new_data?.is_nsfw
                                                        ? "Yes"
                                                        : "No"
                                                }
                                            />
                                            <InfoRow
                                                label="Members"
                                                value={
                                                    change.new_data
                                                        ?.member_count ||
                                                    change.old_data
                                                        ?.member_count ||
                                                    "Unknown"
                                                }
                                            />
                                        </div>

                                        {fields.length === 0 ? (
                                            <div style={emptyMiniStyle}>
                                                No visible field changes found.
                                            </div>
                                        ) : (
                                            <div style={diffGrid}>
                                                {fields.map((field) => (
                                                    <div
                                                        key={field}
                                                        style={diffRow}
                                                    >
                                                        <div
                                                            style={
                                                                diffFieldName
                                                            }
                                                        >
                                                            {field.replaceAll(
                                                                "_",
                                                                " "
                                                            )}
                                                        </div>

                                                        <div
                                                            style={diffColumns}
                                                        >
                                                            <div
                                                                style={
                                                                    oldValueBox
                                                                }
                                                            >
                                                                <strong>
                                                                    Old
                                                                </strong>
                                                                <span>
                                                                    {formatValue(
                                                                        change
                                                                            .old_data?.[
                                                                            field
                                                                        ]
                                                                    )}
                                                                </span>
                                                            </div>

                                                            <div
                                                                style={
                                                                    newValueBox
                                                                }
                                                            >
                                                                <strong>
                                                                    New
                                                                </strong>
                                                                <span>
                                                                    {formatValue(
                                                                        change
                                                                            .new_data?.[
                                                                            field
                                                                        ]
                                                                    )}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        <div style={buttonRow}>
                                            <button
                                                onClick={() =>
                                                    revertChange(change)
                                                }
                                                style={warningBtn}
                                            >
                                                Revert Change
                                            </button>

                                            <button
                                                onClick={() =>
                                                    banListing(
                                                        change.listing_id,
                                                        "Temporarily banned after admin review."
                                                    )
                                                }
                                                style={rejectBtn}
                                            >
                                                Temp Ban Listing
                                            </button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )
                ) : null}

                {activeTab === "pending" ? (
                    pendingListings.length === 0 ? (
                        <div style={emptyStyle}>No recent new listings.</div>
                    ) : (
                        <div style={listGrid}>
                            {pendingListings.map((listing) => {
                                const backgroundPreview =
                                    pendingImagePreviews[listing.id] ||
                                    listing.image_url ||
                                    ""

                                return (
                                    <div key={listing.id} style={listingCard}>
                                        <label
                                            style={{
                                                ...adminPreviewImage,
                                                ...(backgroundPreview
                                                    ? {
                                                          backgroundImage: `linear-gradient(rgba(9,20,45,0.34), rgba(9,20,45,0.68)), url(${backgroundPreview})`,
                                                      }
                                                    : {
                                                          background:
                                                              "linear-gradient(135deg, #EAF3FF, #D8E8FF)",
                                                      }),
                                                cursor: "pointer",
                                            }}
                                            title="Click to replace the background image"
                                        >
                                            <input
                                                type="file"
                                                accept="image/*"
                                                onChange={(event) =>
                                                    handlePendingBackgroundSelect(
                                                        listing.id,
                                                        event
                                                    )
                                                }
                                                style={{ display: "none" }}
                                            />
                                            <span style={imageLabel}>
                                                {backgroundPreview
                                                    ? "Click to replace background"
                                                    : "Click to upload background"}
                                            </span>
                                        </label>

                                        <div style={listingTop}>
                                            <div style={titleWithIcon}>
                                                {listing.icon_url ? (
                                                    <img
                                                        src={listing.icon_url}
                                                        alt={`${titleForListing(listing)} icon`}
                                                        style={adminIcon}
                                                    />
                                                ) : null}

                                                <div>
                                                    <h2 style={listingTitle}>
                                                        {titleForListing(
                                                            listing
                                                        )}
                                                    </h2>
                                                    <a
                                                        href={
                                                            listing.telegram_link
                                                        }
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        style={listingLink}
                                                    >
                                                        {listing.telegram_link}
                                                    </a>
                                                </div>
                                            </div>

                                            <div style={badgeStack}>
                                                <span style={typeBadge}>
                                                    {listingTypeLabel(listing)}
                                                </span>
                                                <span style={statusBadge}>
                                                    {listing.status}
                                                </span>
                                            </div>
                                        </div>

                                        <div style={infoGrid}>
                                            <EditableInfoRow
                                                label="Type"
                                                value={
                                                    listing.listing_type ||
                                                    "channel"
                                                }
                                                type="select"
                                                options={["channel", "group"]}
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "listing_type",
                                                        value
                                                    )
                                                }
                                            />
                                            <EditableInfoRow
                                                label="Listing name"
                                                value={
                                                    listing.channel_name || ""
                                                }
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "channel_name",
                                                        value
                                                    )
                                                }
                                            />
                                            <EditableInfoRow
                                                label="Telegram title"
                                                value={
                                                    listing.telegram_title || ""
                                                }
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "telegram_title",
                                                        value
                                                    )
                                                }
                                            />
                                            <EditableInfoRow
                                                label="Telegram username"
                                                value={
                                                    listing.telegram_username ||
                                                    ""
                                                }
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "telegram_username",
                                                        value
                                                    )
                                                }
                                            />
                                            <EditableInfoRow
                                                label="Members"
                                                value={
                                                    listing.member_count || 0
                                                }
                                                type="number"
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "member_count",
                                                        Number(value || 0)
                                                    )
                                                }
                                            />
                                            <EditableInfoRow
                                                label="Votes"
                                                value={listing.votes_count || 0}
                                                type="number"
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "votes_count",
                                                        Number(value || 0)
                                                    )
                                                }
                                            />
                                            <EditableInfoRow
                                                label="Short invite"
                                                value={
                                                    listing.short_invite || ""
                                                }
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "short_invite",
                                                        value
                                                    )
                                                }
                                            />
                                            <EditableInfoRow
                                                label="NSFW"
                                                value={
                                                    listing.is_nsfw
                                                        ? "Yes"
                                                        : "No"
                                                }
                                                type="select"
                                                options={["No", "Yes"]}
                                                onChange={(value) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "is_nsfw",
                                                        value === "Yes"
                                                    )
                                                }
                                            />
                                            <InfoRow
                                                label="Last synced"
                                                value={
                                                    listing.last_synced_at
                                                        ? new Date(
                                                              listing.last_synced_at
                                                          ).toLocaleString()
                                                        : "Never"
                                                }
                                            />
                                        </div>

                                        <div style={sectionBlock}>
                                            <strong style={sectionMiniTitle}>
                                                Short description
                                            </strong>
                                            <textarea
                                                value={
                                                    listing.description || ""
                                                }
                                                onChange={(event) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "description",
                                                        event.target.value
                                                    )
                                                }
                                                style={pendingTextareaStyle}
                                                placeholder="Short description"
                                            />
                                        </div>

                                        <div style={sectionBlock}>
                                            <strong style={sectionMiniTitle}>
                                                Long description
                                            </strong>
                                            <textarea
                                                value={
                                                    listing.long_description ||
                                                    ""
                                                }
                                                onChange={(event) =>
                                                    updatePendingField(
                                                        listing.id,
                                                        "long_description",
                                                        event.target.value
                                                    )
                                                }
                                                style={pendingLongTextareaStyle}
                                                placeholder="Long description"
                                            />
                                        </div>

                                        {listing.telegram_description ? (
                                            <div style={sectionBlock}>
                                                <strong
                                                    style={sectionMiniTitle}
                                                >
                                                    Telegram bio/description
                                                </strong>
                                                <textarea
                                                    value={
                                                        listing.telegram_description ||
                                                        ""
                                                    }
                                                    onChange={(event) =>
                                                        updatePendingField(
                                                            listing.id,
                                                            "telegram_description",
                                                            event.target.value
                                                        )
                                                    }
                                                    style={pendingTextareaStyle}
                                                    placeholder="Telegram bio/description"
                                                />
                                            </div>
                                        ) : null}

                                        <div style={categoryWrap}>
                                            {(listing.categories || []).map(
                                                (cat: string) => (
                                                    <span
                                                        key={cat}
                                                        style={categoryPill}
                                                    >
                                                        {cat}
                                                    </span>
                                                )
                                            )}
                                        </div>

                                        {listing.is_nsfw ? (
                                            <span style={nsfwBadge}>NSFW</span>
                                        ) : null}

                                        <div style={metaStyle}>
                                            Submitted:{" "}
                                            {listing.created_at
                                                ? new Date(
                                                      listing.created_at
                                                  ).toLocaleString()
                                                : "Unknown"}
                                        </div>

                                        <div style={buttonRow}>
                                            {getListingUrl(listing) ? (
                                                <a
                                                    href={getListingUrl(
                                                        listing
                                                    )}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    style={secondaryLinkBtn}
                                                >
                                                    View Page
                                                </a>
                                            ) : null}

                                            {listing.short_invite ? (
                                                <button
                                                    onClick={() =>
                                                        copyText(
                                                            shortInviteUrl(
                                                                listing.short_invite
                                                            )
                                                        )
                                                    }
                                                    style={secondaryBtn}
                                                >
                                                    Copy Short Invite
                                                </button>
                                            ) : null}

                                            <button
                                                onClick={() =>
                                                    updateStatus(
                                                        listing.id,
                                                        "approved"
                                                    )
                                                }
                                                disabled={
                                                    savingListingId ===
                                                    listing.id
                                                }
                                                style={{
                                                    ...approveBtn,
                                                    opacity:
                                                        savingListingId ===
                                                        listing.id
                                                            ? 0.65
                                                            : 1,
                                                }}
                                            >
                                                {savingListingId === listing.id
                                                    ? "Saving..."
                                                    : "Approve & Save"}
                                            </button>

                                            <button
                                                onClick={() =>
                                                    updateStatus(
                                                        listing.id,
                                                        "rejected"
                                                    )
                                                }
                                                style={rejectBtn}
                                            >
                                                Reject
                                            </button>

                                            <button
                                                onClick={() =>
                                                    banListing(
                                                        listing.id,
                                                        "Temporarily banned from new post review."
                                                    )
                                                }
                                                style={warningBtn}
                                            >
                                                Temp Ban
                                            </button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )
                ) : null}

                {activeTab === "banned" ? (
                    bannedListings.length === 0 ? (
                        <div style={emptyStyle}>No banned listings.</div>
                    ) : (
                        <div style={listGrid}>
                            {bannedListings.map((listing) => (
                                <div key={listing.id} style={listingCard}>
                                    <div style={listingTop}>
                                        <div>
                                            <h2 style={listingTitle}>
                                                {listing.channel_name}
                                            </h2>
                                            <a
                                                href={listing.telegram_link}
                                                target="_blank"
                                                rel="noreferrer"
                                                style={listingLink}
                                            >
                                                {listing.telegram_link}
                                            </a>
                                        </div>

                                        <div style={badgeStack}>
                                            <span style={typeBadge}>
                                                {listingTypeLabel(listing)}
                                            </span>
                                            <span style={banBadge}>Banned</span>
                                        </div>
                                    </div>

                                    {listing.image_url ? (
                                        <div
                                            style={{
                                                ...smallImagePreview,
                                                backgroundImage: `linear-gradient(rgba(9,20,45,0.22), rgba(9,20,45,0.5)), url(${listing.image_url})`,
                                            }}
                                        />
                                    ) : null}

                                    <div style={infoGrid}>
                                        <InfoRow
                                            label="Type"
                                            value={listingTypeLabel(listing)}
                                        />
                                        <InfoRow
                                            label="Telegram username"
                                            value={listing.telegram_username}
                                        />
                                        <InfoRow
                                            label="Members"
                                            value={
                                                listing.member_count?.toLocaleString?.() ||
                                                listing.member_count
                                            }
                                        />
                                        <InfoRow
                                            label="Votes"
                                            value={listing.votes_count || 0}
                                        />
                                        <InfoRow
                                            label="Short invite"
                                            value={
                                                listing.short_invite
                                                    ? shortInviteUrl(
                                                          listing.short_invite
                                                      )
                                                    : "Empty"
                                            }
                                        />
                                    </div>

                                    <p style={descriptionStyle}>
                                        {listing.description}
                                    </p>

                                    {listing.ban_reason ? (
                                        <div style={banReasonBox}>
                                            Reason: {listing.ban_reason}
                                        </div>
                                    ) : null}

                                    <div style={buttonRow}>
                                        <button
                                            onClick={() =>
                                                unbanListing(listing.id)
                                            }
                                            style={approveBtn}
                                        >
                                            Unban
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )
                ) : null}
            </div>
        </div>
    )
}

function EditableInfoRow({
    label,
    value,
    onChange,
    type = "text",
    options = [],
}: {
    label: string
    value: any
    onChange: (value: string) => void
    type?: "text" | "number" | "select"
    options?: string[]
}) {
    const [editing, setEditing] = React.useState(false)

    return (
        <div
            style={{
                ...infoRow,
                cursor: "text",
                outline: editing ? "2px solid #2C74F4" : "none",
            }}
            onClick={() => setEditing(true)}
            title="Click to edit"
        >
            <span style={infoLabel}>{label}</span>

            {editing ? (
                type === "select" ? (
                    <select
                        autoFocus
                        value={String(value ?? "")}
                        onChange={(event) => onChange(event.target.value)}
                        onBlur={() => setEditing(false)}
                        onClick={(event) => event.stopPropagation()}
                        style={inlineEditInput}
                    >
                        {options.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                ) : (
                    <input
                        autoFocus
                        type={type}
                        value={value ?? ""}
                        onChange={(event) => onChange(event.target.value)}
                        onBlur={() => setEditing(false)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.currentTarget.blur()
                            }
                        }}
                        onClick={(event) => event.stopPropagation()}
                        style={inlineEditInput}
                    />
                )
            ) : (
                <span style={infoValue}>
                    {value === null || value === undefined || value === ""
                        ? "Empty — click to edit"
                        : String(value)}
                </span>
            )}
        </div>
    )
}

function InfoRow({ label, value }: { label: string; value: any }) {
    return (
        <div style={infoRow}>
            <span style={infoLabel}>{label}</span>
            <span style={infoValue}>
                {value === null || value === undefined || value === ""
                    ? "Empty"
                    : String(value)}
            </span>
        </div>
    )
}

addPropertyControls(TelecadiaAdminListings, {
    loginPath: {
        type: ControlType.String,
        title: "Login Path",
        defaultValue: "/login",
    },
})

const pageWrap: React.CSSProperties = {
    minHeight: "100vh",
    background: "#EFF4FD",
    padding: 24,
    boxSizing: "border-box",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
}

const cardStyle: React.CSSProperties = {
    maxWidth: 560,
    margin: "80px auto",
    borderRadius: 30,
    padding: 30,
    background:
        "linear-gradient(180deg, rgba(255,255,255,0.82), rgba(247,250,255,0.96))",
    border: "1px solid rgba(219,230,248,1)",
    boxShadow: "0 24px 70px rgba(61,126,245,0.1)",
    backdropFilter: "blur(14px)",
}

const panelStyle: React.CSSProperties = {
    maxWidth: 1180,
    margin: "0 auto",
    borderRadius: 30,
    padding: 30,
    background:
        "linear-gradient(180deg, rgba(255,255,255,0.82), rgba(247,250,255,0.96))",
    border: "1px solid rgba(219,230,248,1)",
    boxShadow: "0 24px 70px rgba(61,126,245,0.1)",
    backdropFilter: "blur(14px)",
}

const topRow: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
    alignItems: "center",
    marginBottom: 20,
}

const titleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 38,
    lineHeight: 1.05,
    letterSpacing: "-0.04em",
    color: "#112B5C",
}

const subtitleStyle: React.CSSProperties = {
    marginTop: 10,
    marginBottom: 0,
    color: "#6F84AF",
    fontSize: 15,
    lineHeight: 1.6,
}

const tabsRow: React.CSSProperties = {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 18,
}

const tabBtn: React.CSSProperties = {
    height: 42,
    padding: "0 15px",
    borderRadius: 999,
    border: "1px solid rgba(210, 224, 245, 0.95)",
    background: "rgba(255,255,255,0.78)",
    color: "#26477D",
    fontWeight: 850,
    cursor: "pointer",
}

const tabBtnActive: React.CSSProperties = {
    background: "linear-gradient(135deg, #43A4FF, #2C74F4)",
    color: "white",
    border: "1px solid #2C74F4",
}

const listGrid: React.CSSProperties = {
    display: "grid",
    gap: 16,
}

const listingCard: React.CSSProperties = {
    borderRadius: 24,
    padding: 20,
    border: "1px solid rgba(219,230,248,1)",
    background: "rgba(255,255,255,0.72)",
    boxShadow: "0 16px 40px rgba(61,126,245,0.06)",
}

const listingTop: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
}

const listingTitle: React.CSSProperties = {
    margin: 0,
    fontSize: 22,
    color: "#112B5C",
}

const listingLink: React.CSSProperties = {
    display: "inline-block",
    marginTop: 6,
    color: "#2C74F4",
    fontSize: 14,
    fontWeight: 700,
    textDecoration: "none",
    maxWidth: "100%",
    overflowWrap: "anywhere",
}

const statusBadge: React.CSSProperties = {
    height: 32,
    padding: "0 12px",
    borderRadius: 999,
    background: "#FFF6D8",
    color: "#9A6B00",
    fontSize: 13,
    fontWeight: 800,
    display: "inline-flex",
    alignItems: "center",
    textTransform: "capitalize",
}

const changeBadge: React.CSSProperties = {
    ...statusBadge,
    background: "#EAF3FF",
    color: "#2C74F4",
}

const banBadge: React.CSSProperties = {
    ...statusBadge,
    background: "#FDEDEC",
    color: "#C0392B",
}

const badgeStack: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
}

const typeBadge: React.CSSProperties = {
    height: 32,
    padding: "0 12px",
    borderRadius: 999,
    background: "#EAF3FF",
    color: "#2C74F4",
    fontSize: 13,
    fontWeight: 900,
    display: "inline-flex",
    alignItems: "center",
}

const nsfwBadge: React.CSSProperties = {
    display: "inline-block",
    marginTop: 12,
    padding: "5px 9px",
    borderRadius: 999,
    background: "#FFE8EC",
    color: "#B4233D",
    fontSize: 11,
    fontWeight: 900,
    letterSpacing: "0.03em",
}

const descriptionStyle: React.CSSProperties = {
    color: "#59719C",
    fontSize: 15,
    lineHeight: 1.6,
    marginTop: 14,
}

const categoryWrap: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
}

const categoryPill: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 999,
    background: "#EAF3FF",
    color: "#2C74F4",
    fontSize: 13,
    fontWeight: 700,
}

const metaStyle: React.CSSProperties = {
    marginTop: 14,
    color: "#8A9CBD",
    fontSize: 13,
    fontWeight: 700,
}

const diffGrid: React.CSSProperties = {
    display: "grid",
    gap: 12,
    marginTop: 16,
}

const diffRow: React.CSSProperties = {
    borderRadius: 16,
    border: "1px solid rgba(219,230,248,1)",
    background: "rgba(247,250,255,0.78)",
    padding: 12,
}

const diffFieldName: React.CSSProperties = {
    color: "#112B5C",
    fontSize: 13,
    fontWeight: 900,
    textTransform: "capitalize",
    marginBottom: 8,
}

const diffColumns: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
}

const oldValueBox: React.CSSProperties = {
    display: "grid",
    gap: 5,
    padding: 10,
    borderRadius: 12,
    background: "#FFF6D8",
    color: "#7A5400",
    fontSize: 13,
    lineHeight: 1.45,
    overflowWrap: "anywhere",
}

const newValueBox: React.CSSProperties = {
    display: "grid",
    gap: 5,
    padding: 10,
    borderRadius: 12,
    background: "#EAF7EF",
    color: "#1D6F42",
    fontSize: 13,
    lineHeight: 1.45,
    overflowWrap: "anywhere",
}

const emptyMiniStyle: React.CSSProperties = {
    marginTop: 14,
    padding: 12,
    borderRadius: 14,
    background: "#F2F7FF",
    color: "#6F84AF",
    fontWeight: 700,
    fontSize: 13,
}

const banReasonBox: React.CSSProperties = {
    marginTop: 14,
    padding: 12,
    borderRadius: 14,
    background: "#FDEDEC",
    color: "#C0392B",
    fontWeight: 800,
    fontSize: 13,
}

const buttonRow: React.CSSProperties = {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 18,
}

const approveBtn: React.CSSProperties = {
    height: 44,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid #1DB954",
    background: "#1DB954",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
}

const rejectBtn: React.CSSProperties = {
    height: 44,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid #E74C3C",
    background: "#E74C3C",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
}

const warningBtn: React.CSSProperties = {
    height: 44,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid #F39C12",
    background: "#F39C12",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
}

const secondaryBtn: React.CSSProperties = {
    height: 44,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid rgba(210, 224, 245, 0.95)",
    background: "rgba(255,255,255,0.82)",
    color: "#26477D",
    fontWeight: 800,
    cursor: "pointer",
}

const primaryLink: React.CSSProperties = {
    marginTop: 20,
    height: 48,
    padding: "0 18px",
    borderRadius: 16,
    background: "linear-gradient(135deg, #43A4FF, #2C74F4)",
    color: "white",
    fontSize: 15,
    fontWeight: 800,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
}

const emptyStyle: React.CSSProperties = {
    borderRadius: 20,
    padding: 24,
    background: "rgba(255,255,255,0.7)",
    border: "1px dashed rgba(207,224,255,1)",
    color: "#6F84AF",
    fontWeight: 700,
    textAlign: "center",
}

const adminPreviewImage: React.CSSProperties = {
    minHeight: 210,
    borderRadius: 20,
    padding: 16,
    marginBottom: 18,
    backgroundSize: "cover",
    backgroundPosition: "center",
    display: "flex",
    alignItems: "end",
    color: "white",
    boxShadow: "0 18px 45px rgba(61,126,245,0.12)",
}

const smallImagePreview: React.CSSProperties = {
    minHeight: 160,
    borderRadius: 16,
    marginTop: 8,
    marginBottom: 12,
    backgroundSize: "cover",
    backgroundPosition: "center",
    boxShadow: "0 14px 32px rgba(61,126,245,0.1)",
}

const imageLabel: React.CSSProperties = {
    padding: "7px 10px",
    borderRadius: 999,
    background: "rgba(17,43,92,0.62)",
    color: "white",
    fontSize: 12,
    fontWeight: 900,
}

const titleWithIcon: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
}

const adminIcon: React.CSSProperties = {
    width: 54,
    height: 54,
    minWidth: 54,
    borderRadius: 999,
    objectFit: "cover",
    border: "2px solid rgba(46,124,246,0.18)",
    boxShadow: "0 12px 28px rgba(61,126,245,0.16)",
}

const infoGrid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
    marginTop: 16,
}

const infoRow: React.CSSProperties = {
    display: "grid",
    gap: 4,
    padding: 10,
    borderRadius: 14,
    background: "#F2F7FF",
    border: "1px solid rgba(214,226,248,1)",
    minWidth: 0,
}

const infoLabel: React.CSSProperties = {
    color: "#7B8FB8",
    fontSize: 12,
    fontWeight: 900,
}

const infoValue: React.CSSProperties = {
    color: "#112B5C",
    fontSize: 13,
    fontWeight: 800,
    overflowWrap: "anywhere",
}

const inlineEditInput: React.CSSProperties = {
    width: "100%",
    minWidth: 0,
    padding: "7px 9px",
    borderRadius: 9,
    border: "1px solid #2C74F4",
    background: "white",
    color: "#112B5C",
    fontSize: 13,
    fontWeight: 800,
    boxSizing: "border-box",
    outline: "none",
}

const pendingTextareaStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 92,
    marginTop: 8,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(214,226,248,1)",
    background: "#F8FBFE",
    color: "#59719C",
    fontSize: 15,
    lineHeight: 1.6,
    fontFamily: "inherit",
    boxSizing: "border-box",
    resize: "vertical",
    outline: "none",
}

const pendingLongTextareaStyle: React.CSSProperties = {
    ...pendingTextareaStyle,
    minHeight: 180,
}

const sectionBlock: React.CSSProperties = {
    marginTop: 16,
}

const sectionMiniTitle: React.CSSProperties = {
    display: "block",
    color: "#112B5C",
    fontSize: 13,
    fontWeight: 900,
    marginBottom: 7,
}

const longDescriptionPreview: React.CSSProperties = {
    ...descriptionStyle,
    whiteSpace: "pre-wrap",
    maxHeight: 240,
    overflow: "auto",
    padding: 12,
    borderRadius: 14,
    background: "#F8FBFE",
    border: "1px solid rgba(214,226,248,1)",
}

const changeSummaryBox: React.CSSProperties = {
    marginTop: 14,
    padding: 12,
    borderRadius: 14,
    background: "#EAF3FF",
    color: "#26477D",
    fontSize: 13,
    fontWeight: 800,
    lineHeight: 1.5,
}

const imageCompareGrid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
    marginTop: 16,
}

const secondaryLinkBtn: React.CSSProperties = {
    ...secondaryBtn,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
}

const errorStyle: React.CSSProperties = {
    color: "#C0392B",
    background: "#FDEDEC",
    border: "1px solid #F5C6CB",
    padding: 12,
    borderRadius: 12,
    fontSize: 14,
    marginBottom: 14,
}

const successStyle: React.CSSProperties = {
    color: "#1D6F42",
    background: "#EAF7EF",
    border: "1px solid #BEE3CC",
    padding: 12,
    borderRadius: 12,
    fontSize: 14,
    marginBottom: 14,
}

const importPanelStyle: React.CSSProperties = {
    display: "grid",
    gap: 16,
    padding: 20,
    borderRadius: 24,
    border: "1px solid rgba(214,226,248,1)",
    background: "rgba(255,255,255,0.72)",
}

const importHeaderRow: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
}

const importTitleStyle: React.CSSProperties = {
    margin: 0,
    color: "#112B5C",
    fontSize: 24,
    lineHeight: 1.15,
    fontWeight: 950,
    letterSpacing: "-0.035em",
}

const importSubtitleStyle: React.CSSProperties = {
    margin: "8px 0 0",
    color: "#6F84AF",
    fontSize: 14,
    lineHeight: 1.55,
    fontWeight: 600,
}

const importTextareaStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 220,
    padding: 16,
    borderRadius: 18,
    border: "1px solid rgba(214,226,248,1)",
    background: "white",
    color: "#173668",
    fontSize: 14,
    lineHeight: 1.5,
    fontWeight: 650,
    boxSizing: "border-box",
    outline: "none",
    resize: "vertical",
}

const importOptionsGrid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
}

const importOptionStyle: React.CSSProperties = {
    minHeight: 46,
    padding: "0 14px",
    borderRadius: 14,
    border: "1px solid rgba(214,226,248,1)",
    background: "rgba(255,255,255,0.86)",
    color: "#26477D",
    fontSize: 13,
    fontWeight: 800,
    display: "flex",
    alignItems: "center",
    gap: 9,
    cursor: "pointer",
}

const importHelpBox: React.CSSProperties = {
    padding: 12,
    borderRadius: 14,
    background: "#F2F7FF",
    border: "1px solid rgba(214,226,248,1)",
    color: "#59719C",
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1.45,
}

const importResultsGrid: React.CSSProperties = {
    display: "grid",
    gap: 10,
    marginTop: 4,
}

const importResultCard: React.CSSProperties = {
    padding: 14,
    borderRadius: 16,
    border: "1px solid rgba(190,230,205,1)",
    background: "#F1FBF5",
}

const importResultSkippedCard: React.CSSProperties = {
    ...importResultCard,
    border: "1px solid rgba(214,226,248,1)",
    background: "#F8FBFE",
}

const importResultErrorCard: React.CSSProperties = {
    ...importResultCard,
    border: "1px solid #F5C6CB",
    background: "#FDEDEC",
}

const importResultTopLine: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    color: "#112B5C",
    fontSize: 14,
    fontWeight: 900,
}

const importResultMeta: React.CSSProperties = {
    marginTop: 6,
    color: "#6F84AF",
    fontSize: 12,
    fontWeight: 700,
    overflowWrap: "anywhere",
}

const importResultErrorText: React.CSSProperties = {
    marginTop: 8,
    color: "#B4233D",
    fontSize: 12,
    fontWeight: 800,
    lineHeight: 1.45,
}
