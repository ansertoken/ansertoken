# $ANSER — The Goose That Cannot Lie

**theanser.app** · [Token Scanner](https://theanser.app/score/) · [Milestones](https://theanser.app/milestones/) · [Hall of Shame](https://theanser.app/hall/) · [Whitepaper](https://theanser.app/anser_whitepaper.pdf) · [@theanserapp](https://x.com/theanserapp) · [t.me/theanser](https://t.me/theanser)

---

> *The goose doesn't promise anything. That's why you can trust it.*  
> *The chain doesn't lie. Interpretation might. We show you both.*  
> *Anseres Capitolium servaverunt.*

---

## What is this repo?

**$ANSER is an on-chain transparency standard for Solana. The token exists to test whether transparency has economic value.**

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

## Why $ANSER should exist

The scanner is a gift. The token is a question. Three reasons it deserves an answer:

**Skin in the game.** $ANSER is audited by its own scanner from day one. Structural criteria — mint revoked, freeze revoked, LP locked — are verifiable on-chain before you buy. Time-based signals (age, distribution) improve by design as the token matures. The contradiction is always public. No founder rescue. No exceptions.

**Coordination layer.** The treasury (the 20% Ecosystem Vesting allocation, plus the Community Reserve as it unlocks) is governed by holders. What gets funded, audited, granted, or added to the Hall of Shame is a collective decision — not the founder's. Holding $ANSER is voting power over the goose's voice.

**Memetic filter.** If the market values radical honesty, the price is its thermometer. If it doesn't, we'll have learned something useful about the market. Either outcome is signal. Neither is a promise.

The scanner exists whether or not anyone holds the token. The token exists to ask whether transparency has economic gravity. That is the entire question.

---

## How is this deployed?

**GitHub Pages** serves this repo directly from the `main` branch.  
**Cloudflare** handles DNS, HTTPS, and caching for theanser.app.  
**Cloudflare Workers** proxy API calls to Helius (Solana RPC) to avoid exposing keys client-side.

No build step. No framework. Files go in, site goes live.

The scanner stores no data. RPC calls are proxied through Cloudflare Workers — API keys never reach the client. No wallet connection is ever required.

---

## The Token Scanner

The ANSER Token Scanner (`score/index.html`) analyzes any Solana token against nine on-chain metrics and returns a transparency score from 0–100.

**Metrics:**

| Metric | Type | Weight |
|---|---|---|
| Mint Authority revoked | VERIFIED | 25 pts |
| Holder Distribution (top 20) | OBSERVED | 20 pts — AMM pools (Raydium, Orca, Meteora) filtered from calculation |
| Liquidity / MCAP ratio | OBSERVED | 15 pts |
| Freeze Authority revoked | VERIFIED | 10 pts |
| Contract Age | OBSERVED | 10 pts |
| Token Mechanics (Token-2022) | VERIFIED | 10 pts |
| Honeypot Check | OBSERVED | Cap — 15 if likely trap, 50 if suspicious |
| Update Authority | VERIFIED | Cap at 85 if mutable |
| Deployer Conviction | INDICATIVE | 10 pts |

**VERIFIED** = on-chain binary fact, cannot be gamed.  
**OBSERVED** = real data, but potentially gameable via wallet splitting etc.  
**INDICATIVE** = useful signal, not conclusive.

The scanner reports both layers — the chain and our reading of it — so you always know which is which.

**Scoring version: v1.0** — this set of metrics, weights, and caps is frozen as the v1.0 baseline. Any change to weights or thresholds will be released as v1.1, v1.2, etc., and noted here. Fixes to bugs in the implementation (without changing the scoring logic) are not version bumps.

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
| Liquidity Data Unavailable | DexScreener fetch failed — established token (>180d) with clean fundamentals | 80 |
| Liquidity Data Unavailable | DexScreener fetch failed — otherwise | 50 |
| Compounding Red Flags | 3+ caps fired simultaneously | −10 pts penalty |

*Note: LP burned (Solana incinerator), locked via Raydium **Burn & Earn**, or locked via Unicrypt is verified on-chain by the scanner and displayed as [VERIFIED]. These positive verifications do not award points — a clean baseline is expected, not rewarded. Only failure modes are penalized. Coverage spans all Raydium pool types (CPMM, AMM v4, CLMM) via the Raydium API plus direct incinerator/Unicrypt checks on Solana RPC.*

---

## The Telegram Bot

**@TheAnser_bot** — [t.me/TheAnser_bot](https://t.me/TheAnser_bot)

Runs on **Render**, kept alive via **UptimeRobot** pings every 5 min.  
Source: private repo `ansertoken/anser-bot`.  
Stack: Node.js · node-telegram-bot-api · Helius RPC · DexScreener API.

**Why is the bot repo private when everything else is public?** The bot holds operational secrets (Helius API key, admin chat ID, GitHub write token) and the Hall-of-Shame proposal heuristics. Open-sourcing it would either leak those credentials or require a redacted copy that no longer matches what runs — a silent inconsistency. A named, documented exception is more honest than a public repo that lies about itself. The part that must be verifiable — the scanner's scoring logic — is fully public in `score/index.html`.

Send any Solana contract address to the bot to get an instant on-chain audit.

**Bot vs scanner divergence (expected):** the Telegram bot always assigns +5 pts for Deployer Conviction (unknown branch — no deployer wallet fetch). Maximum expected divergence: ±5 pts, on tokens where the deployer's current holdings would otherwise move the score. Documented in the bot reference PDF.

---

## Token — Status: not yet deployed

$ANSER has not been deployed. This is intentional.

The project was built product-first: the scanner, the bot, the transparency infrastructure, and the community were built before the token exists. When the token deploys, every vesting contract, liquidity lock, and mint revocation will be verifiable on-chain from the first second.

**Planned deploy stack:**
- SPL token on Solana mainnet
- Mint authority revoked at deploy (irreversible)
- Creator Vesting: Streamflow — 6-month cliff + 2-year linear vest (100M tokens)
- Ecosystem Vesting: Streamflow — 2-year linear vest (200M tokens)
- Community Reserve: Streamflow — 4-year linear vest into the DAO-governed treasury (530M tokens)
- Liquidity: 50M seeds the Raydium CPMM pool — LP locked minimum 1 year via Unicrypt
- Community Airdrop: 20M, proportional to verified early holders, claimed linearly over 6 months
- Anti-snipe: 30-minute launch delay + 1% fee tier

**Self-audit at deploy:** the first act after launch is publishing $ANSER's own transparency score on the home page, run on the live scanner, with full breakdown and links to every vesting and lock contract. If the live scanner returns a verdict below STRUCTURALLY SOUND (75+), deploy is halted and the contradiction is made public.

When deployed, this README will be updated with:
- Contract address
- Streamflow vesting links
- Unicrypt LP lock link
- Reserve wallet addresses (Ecosystem Vesting + Community Reserve)
- Live $ANSER score from the scanner

---

## Tokenomics

| Allocation | % | Tokens | Conditions |
|---|---|---|---|
| Community Reserve | 53% | 530M | Streamflow 4yr linear vest into the DAO-governed treasury · long-term community & liquidity incentives (incl. future liquidity provision) |
| Ecosystem Vesting | 20% | 200M | Streamflow 2yr linear vest (~8.3M/month) · DAO-governed · grants, bounties, listings, ops |
| Liquidity | 5% | 50M | Seeds the Raydium pool — LP locked ≥1 year via Unicrypt |
| Staking Rewards | 10% | 100M | Gradual emission over 4 years — timeline set by DAO |
| Creator Vesting | 10% | 100M | Streamflow — 6-month cliff + 2-year linear vest |
| Community Airdrop | 2% | 20M | Proportional to verified early holders · claimed linearly over 6 months · sized below pool depth |

No private allocations. No advisor tokens. No VC rounds. No presale with special pricing.  
No exchange listing without community governance approval.

Circulating supply at launch: **50,000,000 ANSER (5% of total)**. All other allocations are locked or vesting via on-chain contracts verifiable on Streamflow and Unicrypt.

---

## Hall of Shame — Dispute Policy

Every entry is based on public on-chain data at the time of audit. If you believe an entry contains a factual error (wrong address, incorrect flag, data fetch error), contact [@theanserapp](https://x.com/theanserapp) or [t.me/theanser](https://t.me/theanser) with the contract address and the specific correction. Disputes are reviewed within 7 days. Factual errors are corrected and noted. Entries are not removed because a token recovered — the audit was a snapshot, not a verdict on the future.

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
*Solana Blockchain · May 2026 · Whitepaper v1.0*  
*This project is public. The contract will be too.*
