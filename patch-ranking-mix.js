const fs = require('fs')

const path = 'main.js'
let text = fs.readFileSync(path, 'utf8')

const oldFresh = `  const freshnessScore = getFreshnessScore(listing)

  // Member count contributes up to 5 points. Log scaling keeps a huge
  // channel from overwhelming the rest of the ranking signals.
  // 1,000,000 members reaches the full member-count component.
  const memberCountScore = normalizeLogScore(
    listing.member_count || 0,
    1_000_000
  )
`

const newFresh = `  const rawFreshnessScore = getFreshnessScore(listing)

  // Untouched listings should not cluster at the top just because they were
  // imported recently. If there are no votes, referrals, or measured growth,
  // keep only 20% of the already-small freshness signal.
  const hasRankingActivity =
    Number(listing.votes_count || 0) > 0 ||
    Number(listing.referral_boost_score || 0) > 0 ||
    Number(listing.member_growth_24h || 0) > 0

  const freshnessScore = hasRankingActivity
    ? rawFreshnessScore
    : rawFreshnessScore * 0.2

  // Member count stays a 5% signal with log scaling so older untouched
  // listings can compete naturally with newly imported untouched listings.
  const memberCountScore = normalizeLogScore(
    listing.member_count || 0,
    1_000_000
  )
`

const freshCount = text.split(oldFresh).length - 1
if (freshCount < 1) throw new Error(`ranking freshness block not found: ${freshCount}`)
text = text.split(oldFresh).join(newFresh)

const helperAnchor = 'function getFreshnessScore(listing) {\n'
const helper = `function stableRankingTieBreak(listing) {
  const value = String(
    listing?.id ||
    listing?.telegram_link ||
    listing?.telegram_username ||
    listing?.channel_name ||
    ''
  )

  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

`

if (!text.includes(helper)) {
  if (!text.includes(helperAnchor)) throw new Error('freshness function anchor not found')
  text = text.replace(helperAnchor, helper + helperAnchor)
}

const oldSort = `      .sort((a, b) => {
        if (b.ranking_score !== a.ranking_score) {
          return b.ranking_score - a.ranking_score
        }

        return (
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
        )
      })`

const newSort = `      .sort((a, b) => {
        if (b.ranking_score !== a.ranking_score) {
          return b.ranking_score - a.ranking_score
        }

        // Never break ranking ties by newest-first. Prefer member count, then
        // use a stable age-neutral hash so old/new untouched listings mix.
        const memberDiff = Number(b.member_count || 0) - Number(a.member_count || 0)
        if (memberDiff !== 0) return memberDiff

        return stableRankingTieBreak(a) - stableRankingTieBreak(b)
      })`

const sortCount = text.split(oldSort).length - 1
if (sortCount < 1) throw new Error(`newest-first ranking tie-break not found: ${sortCount}`)
text = text.split(oldSort).join(newSort)

text = text.replace(
  '"telehub-admin-controlled-ai-style-2026-08-08"',
  '"telehub-coldstart-ranking-mix-2026-08-09"'
)

fs.writeFileSync(path, text)
console.log(`Patched ${freshCount} score block(s) and ${sortCount} sort block(s).`)
