# $ANSER — The Goose That Cannot Lie

**theanser.app** · [Token Scanner](https://theanser.app/score/) · [Milestones](https://theanser.app/milestones/) · [Hall of Shame](https://theanser.app/hall/) · [Whitepaper](https://theanser.app/anser_whitepaper.pdf) · [@theanserapp](https://x.com/theanserapp) · [t.me/theanser](https://t.me/theanser)

---

> *The goose doesn't promise anything. That's why you can trust it.*  
> *Anseres Capitolium servaverunt.*

---

## What is this repo?

This is the public codebase for **theanser.app** — the official web presence of the $ANSER project on Solana.

Everything here is visible by design. The project's founding principle is that transparency is not a marketing claim — it is a technical constraint. This repo is part of that constraint.

---

## What's in here?

| File | What it does |
|---|---|
| `index.html` | Landing page — theanser.app |
| `score/index.html` | ANSER Token Scanner — theanser.app/score |
| `milestones/index.html` | Milestone Verification Dashboard — theanser.app/milestones |
| `hall/index.html` | Hall of Shame — theanser.app/hall |
| `anser_whitepaper.pdf` | Whitepaper v1.0 |
| `goose.png` | Brand asset |
| `favicon.png` | Favicon |
| `sitemap.xml` | Sitemap |
| `robots.txt` | robots.txt |

---

## How is this deployed?

**GitHub Pages** serves this repo directly from the `main` branch.  
**Cloudflare** handles DNS, HTTPS, and caching for theanser.app.  
**Cloudflare Workers** proxy API calls to Helius (Solana RPC) to avoid exposing keys client-side.

No build step. No framework. Files go in, site goes live.

---

## The Token Scanner

The ANSER Token Scanner (`score/index.html`) analyzes any Solana token against nine on-chain metrics and returns a transparency score from 0–100.

**Metrics:**

| Metric | Type | Weight |
|---|---|---|
| Mint Authority revoked | VERIFIED | 25 pts |
| Holder Distribution (top 20) | OBSERVED | 20 pts |
| Liquidity / MCAP ratio | OBSERVED | 15 pts |
| Freeze Authority revoked | VERIFIED | 10 pts |
| Contract Age | OBSERVED | 10 pts |
| Token Mechanics (Token-2022) | VERIFIED | 10 pts |
| Honeypot Check | OBSERVED | Cap — 15 if likely trap, 50 if suspicious |
| Update Authority | VERIFIED | Cap at 85 if mutable |
| Creator Risk | INDICATIVE | 10 pts |

**VERIFIED** = on-chain binary fact, cannot be gamed.  
**OBSERVED** = real data, but potentially gameable via wallet splitting etc.  
**INDICATIVE** = useful signal, not conclusive.

Certain red flags cap the total score regardless of other metrics. The goose does not average away red flags.

**Score cap overrides:**

| Signal | Condition | Cap |
|---|---|---|
| Holder Concentration | Top-20 ≥95% · liq <$500K | 35 — CRITICAL |
| Holder Concentration | Top-20 ≥80% · liq <$500K | 49 — HIGH RISK |
| Holder Concentration | Top-20 ≥60% · liq <$500K | 65 — PARTIAL RISK |
| Holder Concentration | Top-20 ≥80% · liq ≥$500K | 65 — softer cap |
| Holder Concentration | Top-20 ≥60% · liq ≥$500K | 75 — softer cap |
| Holder Data Unavailable | High-activity token | 70 |
| Mint Authority | Still active | 60 |
| Freeze Authority | Still active | 70 |
| Update Authority | Mutable metadata | 85 |
| Token-2022 Extensions | Dangerous extension detected | 40 |
| Honeypot Check | Likely trap — high failed sell rate | 15 — CRITICAL |
| Honeypot Check | Suspicious sell pattern | 50 — HIGH RISK |
| Token / Pool Age | Less than 48 hours old | 60 — HIGH RISK |
| Vol / MCAP Ratio | 24h volume >200% of market cap | 65 — PARTIAL RISK |
| Vol / MCAP Ratio | 24h volume >500% of market cap | 49 — HIGH RISK |
| Vol / MCAP Ratio | 24h volume >1000% of market cap | 35 — CRITICAL |
| LP Confirmed Unlocked | DexScreener confirms LP not locked | −5 pts penalty |
| Liquidity Data Unavailable | DexScreener fetch failed | 50 |
| Compounding Red Flags | 3+ caps fired simultaneously | −10 pts penalty |

---

## The Telegram Bot

**@TheAnser_bot** — [t.me/TheAnser_bot](https://t.me/TheAnser_bot)

Runs on **Render** (free tier), kept alive via **UptimeRobot** pings every 5 min.  
Source: private repo `ansertoken/anser-bot`.  
Stack: Node.js · node-telegram-bot-api · Helius RPC · DexScreener API.

Send any Solana contract address to the bot to get an instant on-chain audit.

---

## Token — Status: not yet deployed

$ANSER has not been deployed. This is intentional.

The project was built product-first: the scanner, the bot, the transparency infrastructure, and the community were built before the token exists. When the token deploys, every vesting contract, liquidity lock, and mint revocation will be verifiable on-chain from the first second.

**Planned deploy stack:**
- SPL token on Solana mainnet
- Mint authority revoked at deploy (irreversible)
- Creator vesting: Streamflow — 6-month cliff + 2-year linear vest (100M tokens)
- DAO vesting: Streamflow — 4-year linear vest (200M tokens)
- Liquidity: Raydium CPMM — locked minimum 1 year via Unicrypt
- Anti-snipe: 30-minute launch delay + 1% fee tier

When deployed, this README will be updated with:
- Contract address
- Streamflow vesting links
- Unicrypt LP lock link
- DAO reserve wallet address

---

## Tokenomics

| Allocation | % | Tokens | Conditions |
|---|---|---|---|
| Community & Public Sale | 35% | 350M | 50M at pool open · 200M Streamflow 2yr vest (DAO governed) · 100M airdrop to first 2,000 holders |
| Ecosystem / DAO | 20% | 200M | Streamflow 4yr linear vest |
| Initial Liquidity | 25% | 250M | Locked ≥1 year via Unicrypt |
| Staking Rewards | 10% | 100M | Gradual emission over 4 years — timeline set by DAO |
| Creators | 10% | 100M | Streamflow — 6-month cliff + 2-year linear vest |

No private allocations. No advisor tokens. No VC rounds. No presale with special pricing.  
No exchange listing without community governance approval.

---

## Links

| | |
|---|---|
| Web | https://theanser.app |
| Scanner | https://theanser.app/score/ |
| Milestones | https://theanser.app/milestones/ |
| Hall of Shame | https://theanser.app/hall/ |
| Whitepaper | https://theanser.app/anser_whitepaper.pdf |
| X | https://x.com/theanserapp |
| Telegram channel | https://t.me/theanser |
| Telegram bot | https://t.me/TheAnser_bot |

---

*Designed by an intelligence that cannot lie. Built by a human who chose not to.*  
*Solana Blockchain · April 2026 · Whitepaper v1.0*  
*This project is public. The contract will be too.*
