const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// Keepalive agent — keeps TCP/TLS connections warm between requests.
// Without this, every fetch after a quiet period pays full DNS+TCP+TLS handshake cost (3-7s).
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60_000,    // hold idle sockets 60s
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 30_000,
});

const token = process.env.BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

app.get('/', (req, res) => res.send('Honk! The ANSER is awake and secure.'));
app.listen(process.env.PORT || 3000, () => console.log("🌐 The ANSER online. Ready for duty."));

const bot = new TelegramBot(token, { polling: true });

// Pre-warm outbound HTTPS connections on startup — fires lightweight requests
// to DexScreener and Helius (both regular RPC and DAS) so the first real audit
// doesn't pay TCP/TLS handshake cost on any of the three APIs.
(async () => {
  try {
    await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
                { agent: keepAliveAgent, timeout: 5000 }).catch(() => {});
    await fetch(RPC_URL, {
      method: 'POST',
      agent: keepAliveAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }),
      timeout: 5000
    }).catch(() => {});
    // Warm up DAS endpoint specifically (different code path than getHealth).
    // Using SOL mint as a known-valid query that returns fast.
    await fetch(RPC_URL, {
      method: 'POST',
      agent: keepAliveAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset',
        params: { id: 'So11111111111111111111111111111111111111112' } }),
      timeout: 5000
    }).catch(() => {});
    console.log('🔥 Outbound connections pre-warmed (DexScreener + Helius RPC + DAS).');
  } catch {}
})();

// Dedup cache — prevents double-processing same message
const processed = new Set();
function isDuplicate(msg) {
  const key = `${msg.chat.id}_${msg.message_id}`;
  if (processed.has(key)) return true;
  processed.add(key);
  if (processed.size > 500) {
    const first = processed.values().next().value;
    processed.delete(first);
  }
  return false;
}

// ── RPC helper ────────────────────────────────────────────────────────────
// Primary: Helius. Fallback: public Solana RPC (slower, no API key needed).
const RPC_FALLBACK = 'https://api.mainnet-beta.solana.com';

async function rpc(method, params, useFallback = false) {
  const url = useFallback ? RPC_FALLBACK : RPC_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      agent: keepAliveAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.result;
  } catch (err) {
    if (!useFallback) {
      console.log(`RPC ${method} failed on Helius, retrying on fallback: ${err.message}`);
      return rpc(method, params, true);
    }
    throw err;
  }
}

// ── Token metadata ────────────────────────────────────────────────────────
async function getTokenMeta(address) {
  try {
    const a = await rpc('getAsset', { id: address });
    const updateAuth = a?.authorities?.find(x => x.scopes?.includes('metadata'))?.address
      || a?.update_authority || null;
    const updateAuthRevoked = !updateAuth || updateAuth === '11111111111111111111111111111111' || a?.mutable === false;
    return {
      name:   a?.content?.metadata?.name   || a?.token_info?.symbol || 'Unknown',
      symbol: a?.content?.metadata?.symbol || a?.token_info?.symbol || '???',
      updateAuthRevoked
    };
  } catch { return { name: 'Unknown', symbol: '???', updateAuthRevoked: null }; }
}

// ── Honeypot detection ───────────────────────────────────────────────────
async function getHoneypotStatus(address) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [address, { limit: 20 }]);
    if (!sigs || sigs.length === 0) return { status: 'no_activity' };
    const dexPrograms = new Set([
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    ]);
    let failedSells = 0, successSells = 0;
    for (const sig of sigs.slice(0, 5)) {
      try {
        const tx = await rpc('getTransaction', [sig.signature, {
          encoding: 'jsonParsed', maxSupportedTransactionVersion: 0
        }]);
        if (!tx) continue;
        const accts = tx?.transaction?.message?.accountKeys?.map(k =>
          typeof k === 'string' ? k : k?.pubkey) || [];
        if (accts.some(a => dexPrograms.has(a))) {
          tx.meta?.err ? failedSells++ : successSells++;
        }
      } catch {}
    }
    const total = failedSells + successSells;
    if (total >= 3 && failedSells / total > 0.8) return { status: 'likely_honeypot', failRate: Math.round(failedSells/total*100) };
    if (total >= 3 && failedSells / total > 0.3) return { status: 'suspicious', failRate: Math.round(failedSells/total*100) };
    if (successSells > 0) return { status: 'sellable' };
    return { status: 'unknown' };
  } catch { return { status: 'unknown' }; }
}

// ── Mint & Freeze via raw account data ───────────────────────────────────
async function getMintAuthorities(address) {
  const result = await rpc('getAccountInfo', [address, { encoding: 'base64' }]);
  if (!result?.value?.data) throw new Error('Not a valid token mint.');
  const raw  = Buffer.from(result.value.data[0], 'base64');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const mintAuthorityRevoked   = view.getUint32(0,  true) === 0;
  const freezeAuthorityRevoked = view.getUint32(46, true) === 0;
  const isToken2022 = result.value.owner === 'TokenzQdBNbequF8Li1WhHnkPdmEep1qEkfLBs9w9vF';
  const dangerousExtensions = [];
  if (isToken2022 && raw.length > 83) {
    const DANGER = { 1: 'Transfer Fee', 6: 'Permanent Delegate', 8: 'Non-Transferable', 12: 'Transfer Hook' };
    let offset = 83;
    while (offset + 4 <= raw.length) {
      const type = view.getUint16(offset, true);
      const len  = view.getUint16(offset + 2, true);
      if (type === 0 && len === 0) break;
      if (DANGER[type]) dangerousExtensions.push(DANGER[type]);
      offset += 4 + len;
      if (offset >= raw.length || len === 0) break;
    }
  }
  return { mintAuthorityRevoked, freezeAuthorityRevoked, isToken2022, dangerousExtensions };
}

// ── Holder concentration (top 20) ────────────────────────────────────────
// PRIMARY: getTokenLargestAccounts — RPC method that returns the actual top 20
// holders of a token. Reliable, fast, and what Solscan uses under the hood.
//
// FALLBACK: DAS getTokenAccounts (Helius) — only when the primary fails.
// IMPORTANT: DAS does NOT sort by amount (Helius removed `sortBy`), so a fetch
// with limit:1000 returns an arbitrary subset. For tokens with >>1000 holders
// (BONK, USDC, etc.) the resulting "top 20" from this subset is meaningless
// dust → falsely shows as "0% top 20". To prevent this misleading output,
// EVERY result goes through a sanity check: if top-20 sums to <0.5% of total
// supply, the data is treated as bogus and we return null instead.
//
// AMM POOL FILTER: token accounts owned by AMM programs (Raydium, Orca,
// Meteora, PumpFun…) are pooled liquidity, not concentrated holders. We
// identify them by fetching each top-N account's `owner` field via
// getMultipleAccounts and discarding those owned by known AMM programs.
// CEX wallets are NOT filtered — they're real custodial holders, and
// distinguishing them is too fragile (addresses change frequently). The
// UX layer flags this with "Verify labels on Solscan".
const AMM_PROGRAM_OWNERS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Token Swap v2
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkQGfFyR', // Meteora Pools
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // PumpFun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpAMM (PumpSwap)
  'DSwpgjMvXhtGn6BsbqmacdBZyfLj6jSKCqdis1hTMAFU', // FluxBeam
]);

// Returns a Set of token-account addresses (from `topAddresses`) whose
// `owner` field on-chain is a known AMM program. Failures are non-fatal:
// on RPC error we return an empty Set and the caller proceeds without
// filtering rather than erroring out.
async function getAmmOwnedAccounts(topAddresses) {
  if (!topAddresses.length) return new Set();
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
    const res = await Promise.race([
      rpc('getMultipleAccounts', [topAddresses, { encoding: 'jsonParsed' }]),
      timeout
    ]);
    const ammSet = new Set();
    (res?.value || []).forEach((acct, i) => {
      const ownerProgram = acct?.data?.parsed?.info?.owner;
      if (ownerProgram && AMM_PROGRAM_OWNERS.has(ownerProgram)) {
        ammSet.add(topAddresses[i]);
      }
    });
    return ammSet;
  } catch (e) {
    console.log('AMM owner lookup failed (proceeding without filter):', e.message);
    return new Set();
  }
}

async function getHolderConcentration(address) {
  // Validates and shapes the response. Filters AMM-owned accounts by their
  // on-chain owner program. Returns null for bogus data (top-20 sums to
  // <0.5% of supply — DAS arbitrary subset signature).
  const validateAndShape = async (rawAccounts, supply) => {
    if (!rawAccounts.length || !supply) return null;
    rawAccounts.sort((a, b) => b.uiAmount - a.uiAmount);

    // Look up owners of top-30 (we want at least 20 left after filtering
    // pools — a token like BONK can have 2-3 pools in its top holders).
    const lookupSlice = rawAccounts.slice(0, 30);
    const lookupAddrs = lookupSlice.map(a => a.address);
    const ammOwned   = await getAmmOwnedAccounts(lookupAddrs);

    // Filter known AMM accounts; keep the rest in original sorted order.
    const filtered = rawAccounts.filter(a => !ammOwned.has(a.address));
    if (!filtered.length) return null;

    const top20    = filtered.slice(0, 20);
    const top20sum = top20.reduce((s, h) => s + h.uiAmount, 0);
    if ((top20sum / supply) < 0.005) {
      console.log('Holders sanity check failed: top20 sums to ' + ((top20sum / supply) * 100).toFixed(3) + '% — discarding as bogus');
      return null;
    }
    return {
      top20pct: Math.round((top20sum / supply) * 100),
      top1pct:  Math.round((top20[0].uiAmount / supply) * 100),
      poolsFiltered: ammOwned.size
    };
  };

  try {
    const supplyRes = await rpc('getTokenSupply', [address]);
    const supply    = parseFloat(supplyRes?.value?.uiAmount || 0);
    const decimals  = supplyRes?.value?.decimals || 0;

    // ── PRIMARY: getTokenLargestAccounts ─────────────────────────────────
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 18000));
      const res = await Promise.race([
        rpc('getTokenLargestAccounts', [address]),
        timeout
      ]);
      const accounts = (res?.value || []).map(a => ({
        address:  a.address,
        uiAmount: parseFloat(a.uiAmount || 0)
      }));
      const result = await validateAndShape(accounts, supply);
      if (result) {
        console.log('Holders OK via getTokenLargestAccounts (pools filtered: ' + result.poolsFiltered + ')');
        return { top20pct: result.top20pct, top1pct: result.top1pct };
      }
    } catch (e) { console.log('Holders primary failed:', e.message); }

    // ── RETRY PRIMARY ─────────────────────────────────────────────────────
    try {
      await new Promise(r => setTimeout(r, 1000));
      const timeout2 = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000));
      const res2 = await Promise.race([
        rpc('getTokenLargestAccounts', [address]),
        timeout2
      ]);
      const accounts = (res2?.value || []).map(a => ({
        address:  a.address,
        uiAmount: parseFloat(a.uiAmount || 0)
      }));
      const result = await validateAndShape(accounts, supply);
      if (result) {
        console.log('Holders OK via retry (pools filtered: ' + result.poolsFiltered + ')');
        return { top20pct: result.top20pct, top1pct: result.top1pct };
      }
    } catch (e) { console.log('Holders retry failed:', e.message); }

    // ── FALLBACK: DAS (last resort, sanity-checked) ───────────────────────
    try {
      const timeout3 = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
      const das = await Promise.race([
        rpc('getTokenAccounts', { mint: address, limit: 1000 }),
        timeout3
      ]);
      const accounts = (das?.token_accounts || []).map(a => ({
        address:  a.address,
        uiAmount: parseFloat(a.amount || 0) / Math.pow(10, decimals)
      }));
      const result = await validateAndShape(accounts, supply);
      if (result) {
        console.log('Holders OK via DAS fallback (pools filtered: ' + result.poolsFiltered + ')');
        return { top20pct: result.top20pct, top1pct: result.top1pct };
      }
      console.log('Holders: DAS returned data but failed sanity check (huge token, arbitrary subset)');
    } catch (e) { console.log('Holders DAS fallback failed:', e.message); }

    return null;
  } catch (e) {
    console.log('Holder error:', e.message);
    return null;
  }
}

// ── Minimal base58 encoder for on-chain pubkey parsing ──────────────────────
function toBase58(bytes) {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(0);
  for (const b of bytes) n = n * 256n + BigInt(b);
  let r = '';
  while (n > 0n) { r = ALPHA[Number(n % 58n)] + r; n = n / 58n; }
  for (const b of bytes) { if (b === 0) r = '1' + r; else break; }
  return r;
}

// Unicrypt on-chain LP lock check for Raydium CPMM pools.
// Reads LP mint from pool state (offset 136), checks Unicrypt CPMM storage.
// Returns true if locked, null if undetermined (non-fatal fallback).
async function checkUnicryptLpLock(pairAddress) {
  try {
    const poolInfo = await rpc('getAccountInfo', [pairAddress, { encoding: 'base64' }]);
    const raw = poolInfo?.value?.data;
    if (!raw || !Array.isArray(raw) || raw[1] !== 'base64') return null;
    const buf = Buffer.from(raw[0], 'base64');
    if (buf.length < 168) return null;
    const lpMint = toBase58(buf.slice(136, 168));
    if (!lpMint || lpMint.length < 32) return null;
    const UNICRYPT_CPMM_STORAGE = 'FEmGEWdxCBSJ1QFKeX5B6k7VTDPwNU3ZLdfgJkvGYrH5';
    const lockRes = await rpc('getTokenAccountsByOwner', [
      UNICRYPT_CPMM_STORAGE,
      { mint: lpMint },
      { encoding: 'jsonParsed' }
    ]);
    const accounts = lockRes?.value || [];
    const locked = accounts.some(a =>
      (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0) > 0
    );
    return locked ? true : null;
  } catch { return null; }
}

// ── Liquidity + Volume via DexScreener ───────────────────────────────────
function buildLiqResult(pairs) {
  const totalLiq      = pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
  const vol24h        = pairs.reduce((s, p) => s + (p.volume?.h24    || 0), 0);
  const mcap          = pairs.find(p => p.marketCap)?.marketCap || null;
  const dexes         = [...new Set(pairs.map(p => p.dexId).filter(Boolean))].slice(0, 2).join(', ');
  const pairCreatedAt = pairs[0]?.pairCreatedAt ? new Date(pairs[0].pairCreatedAt) : null;
  const volMcapRatio  = mcap > 0 ? Math.round((vol24h / mcap) * 100) : null;
  // LP lock detection from DexScreener
  let lpLocked = null;
  for (const p of pairs) {
    const boolLock = p.liquidity?.locked;
    const pctLock  = p.info?.liquidity?.locked;
    if (typeof boolLock === 'boolean') { lpLocked = boolLock; break; }
    if (typeof pctLock  === 'number')  { lpLocked = pctLock >= 90; break; }
  }
  return { totalLiq, mcap, dexes, poolCount: pairs.length, vol24h, pairCreatedAt, volMcapRatio, lpLocked };
}

async function getLiquidity(address) {
  const DEX_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; ANSER-Scanner/1.0)'
  };
  const fetchWithTimeout = (url, ms = 12000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { headers: DEX_HEADERS, signal: ctrl.signal, agent: keepAliveAgent })
      .finally(() => clearTimeout(t));
  };

  try {
    // v1 endpoint — extended 12s timeout for first-call cold connection
    const res1  = await fetchWithTimeout(`https://api.dexscreener.com/tokens/v1/solana/${address}`, 12000);
    if (res1.ok) {
      const data1 = await res1.json();
      const pairs1 = Array.isArray(data1) ? data1
                   : Array.isArray(data1?.pairs) ? data1.pairs.filter(p => p.chainId === 'solana')
                   : [];
          if (pairs1.length) {
        const res = buildLiqResult(pairs1);
        if (res.lpLocked === null && pairs1[0]?.pairAddress) {
          const oc = await checkUnicryptLpLock(pairs1[0].pairAddress);
          if (oc === true) res.lpLocked = true;
        }
        return res;
      }
    }
  } catch (e) { console.log('DexScreener v1 error:', e.message); }

  try {
    // Legacy endpoint fallback — connection now warm, 8s is plenty
    const res2  = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${address}`, 8000);
    if (res2.ok) {
      const data2 = await res2.json();
      const pairs2 = (data2.pairs || []).filter(p => p.chainId === 'solana');
      if (pairs2.length) {
        const res = buildLiqResult(pairs2);
        if (res.lpLocked === null && pairs2[0]?.pairAddress) {
          const oc = await checkUnicryptLpLock(pairs2[0].pairAddress);
          if (oc === true) res.lpLocked = true;
        }
        return res;
      }
    }
  } catch (e) { console.log('DexScreener legacy error:', e.message); }

  // Retry: wait 1.5s and try v1 again (handles transient failures / rate limits)
  try {
    await new Promise(r => setTimeout(r, 1500));
    const res3  = await fetchWithTimeout(`https://api.dexscreener.com/tokens/v1/solana/${address}`, 10000);
    if (res3.ok) {
      const data3 = await res3.json();
      const pairs3 = Array.isArray(data3) ? data3
                   : Array.isArray(data3?.pairs) ? data3.pairs.filter(p => p.chainId === 'solana')
                   : [];
      if (pairs3.length) {
          console.log('DexScreener retry succeeded');
          const res = buildLiqResult(pairs3);
          if (res.lpLocked === null && pairs3[0]?.pairAddress) {
            const oc = await checkUnicryptLpLock(pairs3[0].pairAddress);
            if (oc === true) res.lpLocked = true;
          }
          return res;
        }
    }
  } catch (e) { console.log('DexScreener retry error:', e.message); }

  return null;
}

// ── Contract age ──────────────────────────────────────────────────────────
async function getContractAge(address) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
    if (!sigs?.length) return null;
    if (sigs.length >= 1000) return { tooActive: true };
    const oldest = sigs[sigs.length - 1];
    return oldest.blockTime ? new Date(oldest.blockTime * 1000) : null;
  } catch { return null; }
}

function fmtUsd(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

// ── Main handler ──────────────────────────────────────────────────────────
const manejarMensaje = async (msg) => {
  if (isDuplicate(msg)) return;
  const chatId = msg.chat.id;
  const texto  = msg.text;
  if (!texto) return;

  if (texto.startsWith('/start')) {
    bot.sendMessage(chatId,
      `🦢 **WELCOME TO THE ANSER | Solana Scanner**\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nSend me any Solana contract address and I'll run an automated on-chain check.\n\n🌐 **Official App:** https://theanser.app\n\n*Protect your bags. Trust the code.*`,
      { parse_mode: 'Markdown', disable_web_page_preview: false,
        reply_markup: { inline_keyboard: [[{ text: "🌐 LAUNCH THE ANSER APP", url: "https://theanser.app" }]] } }
    ); return;
  }
  if (texto.startsWith('/website')) {
    bot.sendMessage(chatId,
      `🌐 **THE ANSER OFFICIAL PLATFORM**\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nAccess our full suite of tools, rug-checks, and in-depth analytics.\nhttps://theanser.app`,
      { parse_mode: 'Markdown', disable_web_page_preview: false,
        reply_markup: { inline_keyboard: [[{ text: "📊 OPEN WEB APP", url: "https://theanser.app" }]] } }
    ); return;
  }
  if (texto.startsWith('/channel')) {
    bot.sendMessage(chatId,
      `📢 **THE GOOSE NEST**\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nStay updated with the latest security alerts, community news, and alpha.\nhttps://t.me/theanser`,
      { parse_mode: 'Markdown', disable_web_page_preview: false,
        reply_markup: { inline_keyboard: [[{ text: "💬 JOIN TELEGRAM", url: "https://t.me/theanser" }]] } }
    ); return;
  }

  // ── /savetweet — register a tweet URL for a CA (admin only) ──────────────
  // Usage: /savetweet <CA> <tweet_url> [symbol] [score]
  // Example: /savetweet EKpQ...abc https://x.com/theanserapp/status/123 WIF 87
  if (texto.startsWith('/savetweet')) {
    if (String(chatId) !== String(ADMIN_CHAT_ID)) {
      bot.sendMessage(chatId, '❌ Not authorized.', { parse_mode: 'Markdown' }); return;
    }
    const parts = texto.trim().split(/\s+/);
    const ca = parts[1];
    const tweetUrl = parts[2];
    if (!ca || !tweetUrl || !ca.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) || !tweetUrl.match(/x\.com|twitter\.com/)) {
      bot.sendMessage(chatId,
        '⚠️ Usage: `/savetweet <CA> <tweet_url> [symbol] [score]`\nExample: `/savetweet EKpQ...abc https://x.com/theanserapp/status/123 WIF 87`',
        { parse_mode: 'Markdown' }); return;
    }
    const symbol = parts[3] || '???';
    const score  = parts[4] ? parseInt(parts[4]) : null;
    tweetRegistry.set(ca, { tweetUrl, symbol, score, savedAt: new Date().toISOString() });
    await saveTweetRegistry();
    bot.sendMessage(chatId,
      `🪿 Registered tweet for \`${ca.slice(0,8)}...\`\n$${symbol}${score ? ' · Score: ' + score + '/100' : ''}\n${tweetUrl}\n\nTotal in registry: ${tweetRegistry.size}`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    ); return;
  }

  // ── /tweets — list registered tweets (admin only) ────────────────────────
  if (texto.startsWith('/tweets')) {
    if (String(chatId) !== String(ADMIN_CHAT_ID)) return;
    if (tweetRegistry.size === 0) {
      bot.sendMessage(chatId, '🪿 No tweets registered yet. Use /savetweet to add one.', { parse_mode: 'Markdown' }); return;
    }
    const lines = [...tweetRegistry.entries()].map(([ca, e]) =>
      `• $${e.symbol}${e.score ? ' (' + e.score + '/100)' : ''} — \`${ca.slice(0,8)}...\`\n  ${e.tweetUrl}`
    ).join('\n\n');
    bot.sendMessage(chatId, `🪿 *Tweet registry (${tweetRegistry.size}):*\n\n${lines}`, { parse_mode: 'Markdown', disable_web_page_preview: true }); return;
  }

  const match = texto.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (!match) return;

  const contrato = match[0];

  let loadingMsgId = null;
  try {
    const loadingMsg = await bot.sendMessage(chatId, '🦢 *Reading the chain...*', { parse_mode: 'Markdown' });
    loadingMsgId = loadingMsg.message_id;
  } catch(e) {}

  const [meta, auth, conc, liq, age, honey] = await Promise.allSettled([
    getTokenMeta(contrato),
    getMintAuthorities(contrato),
    getHolderConcentration(contrato),
    getLiquidity(contrato),
    getContractAge(contrato),
    getHoneypotStatus(contrato)
  ]);

  if (auth.status === 'rejected') {
    bot.sendMessage(chatId,
      `🦢 **THE ANSER | ON-CHAIN AUDIT**\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ Could not read contract: ${auth.reason?.message || 'Unknown error'}\n\nVerify the address and try again.`,
      { parse_mode: 'Markdown' }
    ); return;
  }

  const { name, symbol, updateAuthRevoked }                = meta.value || { name: 'Unknown', symbol: '???', updateAuthRevoked: null };
  const honeyData = honey?.status === 'fulfilled' ? honey.value : null;
  const { mintAuthorityRevoked, freezeAuthorityRevoked,
          isToken2022, dangerousExtensions }               = auth.value;
  const concData = conc.status === 'fulfilled' ? conc.value : null;
  const liqData  = liq.status  === 'fulfilled' ? liq.value  : null;
  const ageData  = age.status  === 'fulfilled' ? age.value  : null;

  // ── Age signals ───────────────────────────────────────────────────────
  const ageHours    = ageData instanceof Date ? (Date.now() - ageData.getTime()) / 3600000 : null;
  const poolHours   = liqData?.pairCreatedAt instanceof Date
                      ? (Date.now() - liqData.pairCreatedAt.getTime()) / 3600000 : null;
  const isVeryNew   = (ageHours !== null && ageHours < 48) || (poolHours !== null && poolHours < 48);
  const hoursOld    = Math.round(ageHours || poolHours || 0);

  // ── Vol/MCAP signal ───────────────────────────────────────────────────
  const vmr = liqData?.volMcapRatio || null;  // percentage

  // ── Holder concentration line ─────────────────────────────────────────
  // For established tokens (>180d or tooActive), 40-80% top-20 often reflects
  // CEX cold wallets and AMM pools rather than coordinated dump risk — match
  // the web's tone ("Verify wallet labels on Solscan") instead of screaming
  // "HIGH RISK" at every blue-chip token.
  let concLine;
  if (!concData) {
    concLine = `⚪ **Holders:** Not available — [verify on Deep Audit](https://theanser.app/score/?ca=${contrato})`;
  } else {
    const p    = concData.top20pct;
    const top1 = concData.top1pct ? ` | Top wallet: ${concData.top1pct}%` : '';
    const isEstablishedToken = (ageData instanceof Date && ((Date.now() - ageData.getTime()) > 180 * 86400000))
                               || ageData?.tooActive === true;
    if      (p < 20) concLine = `✅ **Holders:** Top 20 hold ${p}% of supply${top1} — healthy distribution`;
    else if (p < 40) concLine = `🟡 **Holders:** Top 20 hold ${p}% of supply${top1} — moderate concentration`;
    else if (p < 60 && isEstablishedToken) concLine = `🟡 **Holders:** Top 20 hold ${p}%${top1} — established token, often CEX/pool wallets. Verify labels on Solscan.`;
    else if (p < 60) concLine = `🔴 **Holders:** Top 20 hold ${p}% — HIGH concentration risk`;
    else if (p < 80 && isEstablishedToken) concLine = `🟡 **Holders:** Top 20 hold ${p}%${top1} — established token, likely CEX/pool wallets. Verify labels on Solscan.`;
    else if (p < 80) concLine = `🔴 **Holders:** Top 20 hold ${p}% — HIGH RISK, significant concentration`;
    else             concLine = `🚨 **Holders:** Top 20 hold ${p}% — CRITICAL, severe rug risk`;
  }

  // ── Liquidity line ────────────────────────────────────────────────────
  let liqLine;
  if (!liqData) {
    liqLine = `⚪ **Liquidity:** Not detected — [verify on Deep Audit](https://theanser.app/score/?ca=${contrato})`;
  } else {
    const isSmallCap = liqData.mcap && liqData.mcap < 10_000_000 && liqData.mcap > 0;
    const ratioNum   = liqData.mcap ? liqData.totalLiq / liqData.mcap * 100 : null;
    let icon;
    if (isSmallCap && ratioNum !== null) {
      icon = ratioNum >= 10 ? '✅' : ratioNum >= 3 ? '🟡' : '🔴';
    } else {
      icon = liqData.totalLiq > 200_000 ? '✅' : liqData.totalLiq > 30_000 ? '🟡' : '🔴';
    }
    const liqStr  = fmtUsd(liqData.totalLiq);
    const dexStr  = liqData.dexes ? ` on ${liqData.dexes.toUpperCase()}` : '';
    const mcapStr = liqData.mcap  ? ` | MCAP ${fmtUsd(liqData.mcap)}` : '';
    const ratio   = liqData.mcap  ? ` (${((liqData.totalLiq / liqData.mcap) * 100).toFixed(1)}% of MCAP)` : '';
    liqLine = `${icon} **Liquidity:** ${liqStr}${dexStr}${mcapStr}${ratio} · [Full analysis](https://theanser.app/score/?ca=${contrato})`;
  }

  // ── Update Authority line ────────────────────────────────────────────────
  let updAuthLine = '';
  if (updateAuthRevoked === null) {
    updAuthLine = `\n⚪ **Metadata:** Status unknown — verify on Solscan`;
  } else if (updateAuthRevoked) {
    updAuthLine = `\n✅ **Metadata:** Immutable — name/logo/URI cannot be changed`;
  } else {
    updAuthLine = `\n⚠️ **Metadata:** MUTABLE — creator can change name, logo or URI`;
  }

  // ── Honeypot line ─────────────────────────────────────────────────────────
  let honeyLine = '';
  if (honeyData?.status === 'likely_honeypot') {
    honeyLine = `\n🚨 **Honeypot:** ${honeyData.failRate}% of sell attempts failed — token may be a trap.`;
  } else if (honeyData?.status === 'suspicious') {
    honeyLine = `\n⚠️ **Honeypot:** ${honeyData.failRate}% of sell attempts failed — verify you can exit.`;
  } else if (honeyData?.status === 'sellable') {
    honeyLine = `\n✅ **Honeypot:** Sell transactions confirmed — token appears sellable.`;
  }

  // ── Token-2022 line ───────────────────────────────────────────────────
  let mechLine = '';
  if (isToken2022 && dangerousExtensions.length > 0)
    mechLine = `\n🔴 **Token-2022:** ${dangerousExtensions.join(', ')} detected`;
  else if (isToken2022)
    mechLine = `\n✅ **Token-2022:** No dangerous extensions`;

  // ── Age warning line ──────────────────────────────────────────────────
  // Differentiates: contract young → "Token age" / contract old + pool young → "Pool age"
  let ageLine = '';
  const _contractYoung = ageHours !== null && ageHours < 48;
  const _poolYoung     = poolHours !== null && poolHours < 48;
  const _contractMature = ageData?.tooActive === true || (ageHours !== null && ageHours >= 48);
  if (_poolYoung && !_contractYoung && _contractMature) {
    const _ph = Math.round(poolHours);
    ageLine = `\n⏱ **Pool age warning:** Pool is only ${_ph}h old (contract has extensive history) — re-launch or fresh pool. LP lock unverifiable. Score capped at 60.`;
  } else if (isVeryNew) {
    ageLine = `\n⏱ **Age warning:** Token is only ${hoursOld}h old — LP lock and creator intent unverifiable. Score capped at 60.`;
  }

  // ── Volume anomaly line ───────────────────────────────────────────────
  // ── LP lock line ─────────────────────────────────────────────────────
  let lpLockLine = '';
  const lpLocked = liqData?.lpLocked;
  if (lpLocked === true)  lpLockLine = `\n✅ **LP Lock [OBSERVED]:** DexScreener reports liquidity locked.`;
  else if (lpLocked === false) lpLockLine = `\n🔴 **LP Lock [OBSERVED]:** DexScreener reports LP NOT locked — creator can remove liquidity. (−5 pts)`;
  else lpLockLine = `\n⚠️ **LP Lock:** Not reported by DexScreener — verify manually on Unicrypt / Streamflow. No penalty applied.`;

  let volLine = '';
  if (vmr !== null && vmr > 200 && liqData?.vol24h) {
    const volFmt = fmtUsd(liqData.vol24h);
    if (vmr > 500) {
      volLine = `\n🚨 **Vol/MCAP ${vmr}%:** Volume (${volFmt}) exceeds market cap ${(vmr/100).toFixed(1)}x — likely coordinated pump.`;
    } else {
      volLine = `\n⚠️ **Vol/MCAP ${vmr}%:** Abnormal 24h volume (${volFmt}) relative to market cap — verify before investing.`;
    }
  }

  const allClear   = mintAuthorityRevoked && freezeAuthorityRevoked && dangerousExtensions.length === 0;

  // ─────────────────────────────────────────────────────────────────────────
  //  SCORE — IDENTICAL to scanner web (theanser.app/score)
  //  Both implementations must remain in sync. If you change one, change both.
  //  Source: index_score.html · function calcScore + critical signal overrides
  //
  //  Single defensible difference: bot does not fetch creator wallet activity,
  //  so Creator Risk uses the "unknown" branch (5 pts) — same value the scanner
  //  awards when creator data is unavailable.
  // ─────────────────────────────────────────────────────────────────────────
  const _holderPct = concData?.top20pct ?? null;
  const _liqUsd    = liqData?.totalLiq ?? 0;
  const _mcap      = liqData?.mcap ?? null;
  const _liqRatio  = (_liqUsd && _mcap) ? (_liqUsd / _mcap) * 100 : null;
  const _isLargeCap = _liqUsd > 500000;

  let botScore = 0;

  // Mint Authority — 25 pts
  if (mintAuthorityRevoked) botScore += 25;

  // Freeze Authority — 10 pts
  if (freezeAuthorityRevoked) botScore += 10;

  // Token Mechanics — 10 / 8 / 0 pts
  // (Scanner has a 3-pt tier for transferFeeBps < 100; bot lacks fee detail,
  //  so falls to the conservative 0-pt branch when dangerous extensions exist.)
  if (!isToken2022)                            botScore += 10;
  else if (dangerousExtensions.length === 0)   botScore += 8;

  // Holder Distribution — 20 / 14 / 7 / 3 pts (matches scanner exactly)
  if (_holderPct !== null) {
    if      (_holderPct < 20) botScore += 20;
    else if (_holderPct < 40) botScore += 14;
    else if (_holderPct < 60) botScore += 7;
    else if (_holderPct < 80) botScore += 3;
  }

  // Liquidity — small-cap uses ratio; large-cap or unknown mcap uses absolute
  if (_liqUsd > 0) {
    const isSmallCap = _mcap !== null && _mcap < 10000000;
    if (isSmallCap && _liqRatio !== null) {
      if      (_liqRatio >= 20) botScore += 15;
      else if (_liqRatio >= 10) botScore += 12;
      else if (_liqRatio >= 3)  botScore += 6;
      else                       botScore += 1;
    } else {
      if      (_liqUsd > 1000000) botScore += 15;
      else if (_liqUsd > 200000)  botScore += 12;
      else if (_liqUsd > 50000)   botScore += 8;
      else if (_liqUsd > 5000)    botScore += 4;
      else                         botScore += 1;
    }
  }

  // Contract Age — 10 / 7 / 5 / 2 / 1 pts
  if (ageData instanceof Date) {
    const _days = (Date.now() - ageData.getTime()) / 86400000;
    if      (_days > 180) botScore += 10;
    else if (_days > 30)  botScore += 7;
    else if (_days > 7)   botScore += 5;
    else if (_days > 1)   botScore += 2;
    else                   botScore += 1;
  } else if (ageData?.tooActive) {
    botScore += 10;
  }

  // Creator Risk — bot uses "unknown" branch (no wallet fetch)
  botScore += 5;

  botScore = Math.min(100, botScore);

  // Mutable metadata: cap at 85 (was −5 pts). A token with mutable metadata
  // is a phishing vector — cannot be considered STRUCTURALLY SOUND.
  if (updateAuthRevoked === false) botScore = Math.min(botScore, 85);

  // ── Critical Signal Overrides — IDENTICAL to scanner web ─────────────────
  // Track caps firing for compounding penalty (3+ → −10 final).
  let capsFired = 0;

  // Holder concentration caps — small-cap vs large-cap, with NEW critical
  // tier at ≥95% (creator effectively controls supply).
  if      (_holderPct !== null && _holderPct >= 95 && !_isLargeCap) { botScore = Math.min(botScore, 35); capsFired++; }
  else if (_holderPct !== null && _holderPct >= 80 && !_isLargeCap) { botScore = Math.min(botScore, 49); capsFired++; }
  else if (_holderPct !== null && _holderPct >= 60 && !_isLargeCap) { botScore = Math.min(botScore, 65); capsFired++; }
  else if (_holderPct !== null && _holderPct >= 80 &&  _isLargeCap) { botScore = Math.min(botScore, 65); capsFired++; }
  else if (_holderPct !== null && _holderPct >= 60 &&  _isLargeCap) { botScore = Math.min(botScore, 75); capsFired++; }
  // Holder data unavailable on a large-ish token → cap 70
  else if (_holderPct === null && _liqUsd > 100000) botScore = Math.min(botScore, 70);

  // Authority caps
  if (!mintAuthorityRevoked)               { botScore = Math.min(botScore, 60); capsFired++; }
  if (!freezeAuthorityRevoked)             { botScore = Math.min(botScore, 70); capsFired++; }
  if (dangerousExtensions.length > 0)      { botScore = Math.min(botScore, 40); capsFired++; }

  // Honeypot caps
  if      (honeyData?.status === 'likely_honeypot') { botScore = Math.min(botScore, 15); capsFired++; }
  else if (honeyData?.status === 'suspicious')      { botScore = Math.min(botScore, 50); capsFired++; }

  // Age caps — token < 48h or pool < 48h
  if (isVeryNew) { botScore = Math.min(botScore, 60); capsFired++; }

  // Vol/MCAP caps — NEW critical tier at >1000% (10x mcap = blatant manipulation)
  if      (vmr !== null && vmr > 1000) { botScore = Math.min(botScore, 35); capsFired++; }
  else if (vmr !== null && vmr > 500)  { botScore = Math.min(botScore, 49); capsFired++; }
  else if (vmr !== null && vmr > 200)  { botScore = Math.min(botScore, 65); capsFired++; }

  // LP Confirmed Unlocked → −5 pts
  if (liqData?.lpLocked === false) botScore = Math.max(0, botScore - 5);

  // Compounding red-flag penalty: 3+ caps firing = beyond reasonable doubt
  if (capsFired >= 3) botScore = Math.max(0, botScore - 10);

  // Liquidity data unavailable: cannot verify Vol/MCAP, LP lock, or wash
  // trading context. Cap depends on how established the token looks on-chain:
  //   - Established + strong fundamentals → cap at 80 (preserves trust for
  //     legit big tokens like BONK when DexScreener has a hiccup)
  //   - Otherwise → cap at 50 (truly suspicious / unverifiable)
  // This prevents the bot from looking absurdly conservative on major tokens
  // while staying strict for newer/smaller ones where data gaps matter more.
  const incompleteRead = (!liqData || _liqUsd === 0);
  let softCapApplied = false;
  if (incompleteRead) {
    const isEstablished = (ageData instanceof Date && ((Date.now() - ageData.getTime()) > 180 * 86400000))
                          || ageData?.tooActive === true;
    const strongFundamentals = mintAuthorityRevoked
                            && freezeAuthorityRevoked
                            && (!isToken2022 || dangerousExtensions.length === 0)
                            && updateAuthRevoked === true
                            && _holderPct !== null
                            && _holderPct < 60;
    if (isEstablished && strongFundamentals) {
      botScore = Math.min(botScore, 80);
      softCapApplied = true;
    } else {
      botScore = Math.min(botScore, 50);
    }
  }

  botScore = Math.max(0, Math.min(100, botScore));

  const botVerdict = botScore >= 90 ? 'PRISTINE' : botScore >= 75 ? 'STRUCTURALLY SOUND' : botScore >= 60 ? 'PARTIAL RISK' : botScore >= 40 ? 'HIGH RISK' : 'CRITICAL';


  const botVerdictEmoji = botScore >= 75 ? '🟢' : botScore >= 60 ? '🟡' : '🔴';

  const techRating = allClear ? '🟢 **RENOUNCED (Authorities Revoked)**' : '🔴 **HIGH RISK (Authorities Active)**';

  const deepAuditUrl = `https://theanser.app/score/?ca=${contrato}`;
  const incompleteWarn = incompleteRead
    ? (softCapApplied
        ? `\n\nℹ️ **MARKET DATA UNAVAILABLE** — DexScreener is not responding. Strong on-chain fundamentals detected (revoked authorities, healthy distribution, established contract). Score capped at 80 pending market verification. Run [Deep Audit](${deepAuditUrl}) for full breakdown.`
        : `\n\n⚠️ **INCOMPLETE READ** — Market data (DexScreener) unavailable. Wash trading, LP lock, and Vol/MCAP cannot be verified. Score capped at 50. Run [Deep Audit](${deepAuditUrl}) for full analysis.`)
    : '';

  const textResponse =
`🦢 **THE ANSER | ON-CHAIN AUDIT**
━━━━━━━━━━━━━━━━━━━━━━━━━━
🪙 **Token:** ${name} — $${symbol}
🏷️ **CA:** \`${contrato}\`

${botVerdictEmoji} **SCORE: ${botScore}/100 — ${botVerdict}**
🚦 **CONTRACT:** ${techRating}
_Quick on-chain read. Full breakdown at_ [theanser.app/score](${deepAuditUrl})_._${incompleteWarn}

**[ TECHNICAL CHECKS ]**
${mintAuthorityRevoked   ? '✅' : '🔴'} **Minting:** ${mintAuthorityRevoked   ? 'Revoked' : 'Active (Dilution Risk)'}
${freezeAuthorityRevoked ? '✅' : '🔴'} **Freeze:**  ${freezeAuthorityRevoked ? 'Revoked' : 'Active (Block Risk)'}${mechLine}
${concLine}
${liqLine}${lpLockLine}${updAuthLine}${honeyLine}${ageLine}${volLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━
👁️ **VERDICT:** ${botVerdict} — Full breakdown on the web scanner.
*Trust the code.*`;

  if (loadingMsgId) {
    bot.deleteMessage(chatId, loadingMsgId).catch(() => {});
  }

  bot.sendMessage(chatId, textResponse, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 DEEP AUDIT (WEB)", url: `https://theanser.app/score/?ca=${contrato}` }],
        [{ text: "📢 SHARE REPORT", url: `https://t.me/share/url?url=https://theanser.app/score/?ca=${contrato}&text=🦢 Check this token on THE ANSER Scanner` }],
        ...(String(chatId) === String(ADMIN_CHAT_ID) && botScore < 60 ? [[
          { text: '🚨 ADD TO HALL OF SHAME', callback_data: 'manual_hall_' + contrato }
        ]] : [])
      ]
    }
  }).catch(err => console.log("Error enviando:", err.message));
};


// ═══════════════════════════════════════════════════════════════════════════
// HALL OF SHAME AUTOMATION — Level 1
// Discovery: DexScreener trending Solana (max 24h old, Vol/MCAP > 200%)
// Scoring:   same logic as the main bot audit
// Approval:  Telegram inline keyboard → admin only
// Commit:    GitHub API → updates index_hall.html on ansertoken/ansertoken
// ═══════════════════════════════════════════════════════════════════════════

const ADMIN_CHAT_ID  = process.env.ADMIN_TELEGRAM_ID || '5548705788';
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = 'ansertoken/ansertoken';
const HALL_FILE      = 'hall/index.html';
const TWEETS_FILE    = 'audit_tweets.json';  // CA → tweet URL registry

// In-memory store of pending proposals: ca → { entry, proposalMsgId }
const pendingProposals = new Map();
// Cooldown: don't re-propose same CA within 48h
const recentlySeen     = new Map();
// Tweet registry: ca → { tweetUrl, symbol, score, auditDate }
const tweetRegistry    = new Map();

// ── Tweet registry: load from GitHub on startup ───────────────────────────────
async function loadTweetRegistry() {
  if (!GITHUB_TOKEN) return;
  try {
    const res = await fetch(
      'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + TWEETS_FILE,
      { headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (!res.ok) { console.log('[Tweets] No registry file yet — will create on first /savetweet'); return; }
    const data = await res.json();
    const json = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    for (const [ca, entry] of Object.entries(json)) tweetRegistry.set(ca, entry);
    console.log('[Tweets] Registry loaded: ' + tweetRegistry.size + ' entries');
  } catch(e) { console.log('[Tweets] Load error:', e.message); }
}

async function saveTweetRegistry() {
  if (!GITHUB_TOKEN) return;
  try {
    const apiBase = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + TWEETS_FILE;
    const obj = Object.fromEntries(tweetRegistry);
    const newContent = Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');
    // Get current SHA (needed for update)
    const getRes = await fetch(apiBase, {
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
    });
    const sha = getRes.ok ? (await getRes.json()).sha : undefined;
    const body = { message: 'Tweet registry updated', content: newContent };
    if (sha) body.sha = sha;
    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (putRes.ok) console.log('[Tweets] Registry saved (' + tweetRegistry.size + ' entries)');
    else console.log('[Tweets] Save failed:', putRes.status);
  } catch(e) { console.log('[Tweets] Save error:', e.message); }
}

// Load registry on startup (after bot is initialized)
setTimeout(loadTweetRegistry, 3000);

// ── 1. Audit a CA and return structured result (mirrors manejarMensaje logic) ──
async function auditForHall(address) {
  try {
    const [meta, auth, conc, liq, age, honey] = await Promise.allSettled([
      getTokenMeta(address),
      getMintAuthorities(address),
      getHolderConcentration(address),
      getLiquidity(address),
      getContractAge(address),
      getHoneypotStatus(address)
    ]);
    if (auth.status === 'rejected') return null;

    const { name, symbol, updateAuthRevoked }           = meta.value || { name: 'Unknown', symbol: '???', updateAuthRevoked: null };
    const { mintAuthorityRevoked, freezeAuthorityRevoked,
            isToken2022, dangerousExtensions }           = auth.value;
    const concData = conc.status === 'fulfilled' ? conc.value : null;
    const liqData  = liq.status  === 'fulfilled' ? liq.value  : null;
    const ageData  = age.status  === 'fulfilled' ? age.value  : null;
    const honeyData = honey?.status === 'fulfilled' ? honey.value : null;

    const ageHours  = ageData instanceof Date ? (Date.now() - ageData.getTime()) / 3600000 : null;
    const poolHours = liqData?.pairCreatedAt instanceof Date
                      ? (Date.now() - liqData.pairCreatedAt.getTime()) / 3600000 : null;
    const isVeryNew = (ageHours !== null && ageHours < 48) || (poolHours !== null && poolHours < 48);
    const vmr       = liqData?.volMcapRatio || null;
    const _holderPct = concData?.top20pct ?? null;
    const _liqUsd   = liqData?.totalLiq ?? 0;
    const _mcap     = liqData?.mcap ?? null;
    const _liqRatio = (_liqUsd && _mcap) ? (_liqUsd / _mcap) * 100 : null;
    const _isLargeCap = _liqUsd > 500000;

    // Score (identical to bot scoring section)
    let score = 0;
    if (mintAuthorityRevoked)   score += 25;
    if (freezeAuthorityRevoked) score += 10;
    if (!isToken2022) score += 10;
    else if (dangerousExtensions.length === 0) score += 8;
    if (_holderPct !== null) {
      if      (_holderPct < 20) score += 20;
      else if (_holderPct < 40) score += 14;
      else if (_holderPct < 60) score += 7;
      else if (_holderPct < 80) score += 3;
    }
    if (_liqUsd > 0) {
      const isSmallCap = _mcap !== null && _mcap < 10000000;
      if (isSmallCap && _liqRatio !== null) {
        if      (_liqRatio >= 20) score += 15;
        else if (_liqRatio >= 10) score += 12;
        else if (_liqRatio >= 3)  score += 6;
        else                       score += 1;
      } else {
        if      (_liqUsd > 1000000) score += 15;
        else if (_liqUsd > 200000)  score += 12;
        else if (_liqUsd > 50000)   score += 8;
        else if (_liqUsd > 5000)    score += 4;
        else                         score += 1;
      }
    }
    if (ageData instanceof Date) {
      const _days = (Date.now() - ageData.getTime()) / 86400000;
      if      (_days > 180) score += 10;
      else if (_days > 30)  score += 7;
      else if (_days > 7)   score += 5;
      else if (_days > 1)   score += 2;
      else                   score += 1;
    } else if (ageData?.tooActive) { score += 10; }
    score += 5; // Creator Risk unknown
    score = Math.min(100, score);
    if (updateAuthRevoked === false) score = Math.min(score, 85);

    let capsFired = 0;
    if      (_holderPct !== null && _holderPct >= 95 && !_isLargeCap) { score = Math.min(score, 35); capsFired++; }
    else if (_holderPct !== null && _holderPct >= 80 && !_isLargeCap) { score = Math.min(score, 49); capsFired++; }
    else if (_holderPct !== null && _holderPct >= 60 && !_isLargeCap) { score = Math.min(score, 65); capsFired++; }
    else if (_holderPct !== null && _holderPct >= 80 &&  _isLargeCap) { score = Math.min(score, 65); capsFired++; }
    else if (_holderPct !== null && _holderPct >= 60 &&  _isLargeCap) { score = Math.min(score, 75); capsFired++; }
    else if (_holderPct === null && _liqUsd > 100000) score = Math.min(score, 70);
    if (!mintAuthorityRevoked)              { score = Math.min(score, 60); capsFired++; }
    if (!freezeAuthorityRevoked)            { score = Math.min(score, 70); capsFired++; }
    if (dangerousExtensions.length > 0)     { score = Math.min(score, 40); capsFired++; }
    if (honeyData?.status === 'likely_honeypot') { score = Math.min(score, 15); capsFired++; }
    else if (honeyData?.status === 'suspicious') { score = Math.min(score, 50); capsFired++; }
    if (isVeryNew) { score = Math.min(score, 60); capsFired++; }
    if      (vmr !== null && vmr > 1000) { score = Math.min(score, 35); capsFired++; }
    else if (vmr !== null && vmr > 500)  { score = Math.min(score, 49); capsFired++; }
    else if (vmr !== null && vmr > 200)  { score = Math.min(score, 65); capsFired++; }
    if (liqData?.lpLocked === false) score = Math.max(0, score - 5);
    if (capsFired >= 3) score = Math.max(0, score - 10);
    if (!liqData || _liqUsd === 0) {
      const est = (ageData instanceof Date && ((Date.now() - ageData.getTime()) > 180 * 86400000)) || ageData?.tooActive;
      const strong = mintAuthorityRevoked && freezeAuthorityRevoked && (!isToken2022 || dangerousExtensions.length === 0) && updateAuthRevoked === true && _holderPct !== null && _holderPct < 60;
      score = Math.min(score, (est && strong) ? 80 : 50);
    }
    score = Math.max(0, Math.min(100, score));

    // Build flags for Hall entry
    const flags = [];
    if (!mintAuthorityRevoked)  flags.push('Mint Active');
    if (!freezeAuthorityRevoked) flags.push('Freeze Active');
    if (_holderPct !== null && _holderPct >= 60) flags.push(`${_holderPct}% top-20 concentration`);
    if (vmr !== null && vmr > 200) flags.push(`Vol/MCAP ${vmr}%`);
    if (isVeryNew) flags.push('Pool < 48h');
    if (honeyData?.status === 'likely_honeypot') flags.push('Likely Honeypot');
    if (dangerousExtensions.length > 0) flags.push('Dangerous Token-2022');

    // Goose voice (simplified)
    let voice = 'The contract has been read. Verify independently.';
    if (vmr !== null && vmr > 1000) voice = `Volume exceeds market cap ${(vmr/100).toFixed(0)}x in 24h. The price is being moved, not discovered.`;
    else if (vmr !== null && vmr > 500) voice = `Vol/MCAP at ${vmr}% — strong signal of coordinated pump or wash trading.`;
    else if (honeyData?.status === 'likely_honeypot') voice = 'Sell transactions are failing. Tokens cannot leave. Classic trap.';
    else if (!mintAuthorityRevoked) voice = 'Supply is not fixed. What exists today may not be what exists tomorrow.';
    else if (_holderPct !== null && _holderPct >= 80) voice = `${_holderPct}% of supply in 20 wallets. One decision ends the price.`;
    else if (_liqUsd < 10000 && _liqUsd > 0) voice = 'Liquidity is thin. Exit doors are narrow.';

    const verdict = score >= 90 ? 'PRISTINE' : score >= 75 ? 'STRUCTURALLY SOUND' :
                    score >= 60 ? 'PARTIAL RISK' : score >= 40 ? 'HIGH RISK' : 'CRITICAL';

    const _now = new Date();
    return { address, name, symbol, score, verdict, voice, flags,
             liqUsd: _liqUsd, mcap: _mcap, vmr,
             auditDate: _now.toISOString().split('T')[0],
             auditTimestamp: _now.toISOString(),
             initialLiq: _liqUsd,
             initialMcap: _mcap,
             mintAuthorityRevoked,
             honeyStatus: honeyData?.status || null,
             dangerousExtensions,
             concPct: _holderPct };
  } catch(e) {
    console.log('auditForHall error:', e.message);
    return null;
  }
}

// ── 2. Fetch trending Solana tokens from DexScreener ─────────────────────────
// Both endpoints are always queried and results combined — previously the code
// returned on the first hit, meaning token-boosts (more DEX variety) was
// almost never used. Combining gives a healthier mix beyond pump.fun.
async function fetchTrendingCandidates() {
  const endpoints = [
    'https://api.dexscreener.com/token-profiles/latest/v1',  // new token launches
    'https://api.dexscreener.com/token-boosts/top/v1',       // top boosted — more DEX variety
  ];

  const combined = new Set();

  for (const url of endpoints) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await new Promise(r => setTimeout(r, attempt > 1 ? 4000 : 0));
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; TokenScanner/1.0)'
          }
        });
        clearTimeout(t);
        if (res.status === 429) {
          console.log('[Hall] ' + url.split('/').pop() + ' rate limited — skipping');
          break;
        }
        if (!res.ok) {
          console.log('[Hall] ' + url.split('/').pop() + ' returned ' + res.status);
          continue;
        }
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.data || []);
        const solana = arr
          .filter(item => (item.chainId || item.chain) === 'solana' && (item.tokenAddress || item.address))
          .map(item => item.tokenAddress || item.address)
          .filter(Boolean)
          .slice(0, 30);
        solana.forEach(ca => combined.add(ca));
        console.log('[Hall] ' + url.split('/').pop() + ': ' + solana.length + ' candidates (total so far: ' + combined.size + ')');
        break;
      } catch(e) {
        console.log('[Hall] ' + url.split('/').pop() + ' attempt ' + attempt + ' error: ' + e.message);
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  if (combined.size === 0) {
    console.log('[Hall] All endpoints failed — skipping cycle.');
    return [];
  }

  console.log('[Hall] Total unique candidates: ' + combined.size);
  return [...combined];
}

// ── 3. Send proposal to admin ─────────────────────────────────────────────────
async function sendHallProposal(entry) {
  const scoreEmoji = entry.score < 40 ? '🔴' : '🟠';
  const liqStr = entry.liqUsd > 0 ? '$' + Math.round(entry.liqUsd).toLocaleString() : 'Unknown';
  const mcapStr = entry.mcap > 0 ? '$' + Math.round(entry.mcap).toLocaleString() : 'Unknown';
  const flagsStr = entry.flags && entry.flags.length > 0 ? entry.flags.join(' · ') : 'None';
  const escMd = s => String(s).replace(/[_*`[\]()~>#+=|{}.!\-]/g, '\\$&');
  const text =
    '🚨 HALL OF SHAME CANDIDATE\n━━━━━━━━━━━━━━━━━━━━\n' +
    scoreEmoji + ' ' + escMd(entry.name) + ' ($' + escMd(entry.symbol) + ')\n' +
    'CA: ' + entry.address + '\n' +
    'Score: ' + entry.score + '/100 - ' + entry.verdict + '\n\n' +
    '"' + escMd(entry.voice) + '"\n\n' +
    'Flags: ' + escMd(flagsStr) + '\n' +
    'Liquidity: ' + liqStr + ' - MCAP: ' + mcapStr + '\n' +
    'Scanned: ' + (entry.auditTimestamp
      ? new Date(entry.auditTimestamp).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) + ' · ' +
        new Date(entry.auditTimestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',timeZone:'UTC'}) + ' UTC'
      : entry.auditDate);

  const msg = await bot.sendMessage(ADMIN_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ ADD TO HALL', callback_data: 'hall_add_' + entry.address },
        { text: '❌ REJECT',      callback_data: 'hall_reject_' + entry.address },
        { text: '🔍 AUDIT',       url: 'https://theanser.app/score/?ca=' + entry.address }
      ]]
    }
  });
  pendingProposals.set(entry.address, { entry, proposalMsgId: msg.message_id });
  console.log('[Hall] Proposal sent for ' + entry.symbol + ' (' + entry.address + ')');
}

// ── 4. Commit entry to GitHub ─────────────────────────────────────────────────
async function commitHallEntry(entry) {
  if (!GITHUB_TOKEN) {
    console.log('[Hall] No GITHUB_TOKEN — skipping commit. Env vars available: ' +
      Object.keys(process.env).filter(k => k.startsWith('GITHUB') || k.startsWith('ADMIN')).join(', '));
    return false;
  }
  try {
    const apiBase = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + HALL_FILE;
    const getRes = await fetch(apiBase, {
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!getRes.ok) throw new Error('GitHub GET failed: ' + getRes.status);
    const fileData = await getRes.json();
    const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');
    const sha = fileData.sha;

    const flagsLiteral = (entry.flags || []).map(f => '"' + f + '"').join(', ');
    const safeVoice  = (entry.voice   || '').replace(/"/g, "'");
    const safeName   = (entry.name    || '').replace(/"/g, "'");
    const safeSymbol = (entry.symbol  || '').replace(/"/g, "'");
    const newEntryStr = [
      '    {',
      '      name: "' + safeName + '", symbol: "' + safeSymbol + '", address: "' + entry.address + '",',
      '      score: ' + entry.score + ', voice: "' + safeVoice + '",',
      '      verdict: "' + entry.verdict + '", auditDate: "' + entry.auditDate + '", rugDate: null,',
      '      auditTimestamp: "' + (entry.auditTimestamp || entry.auditDate) + '",',
      '      initialLiq: ' + (entry.initialLiq || 0) + ', initialMcap: ' + (entry.initialMcap || 0) + ',',
      '      flags: [' + flagsLiteral + '],',
      '      dexscreenerUrl: "https://dexscreener.com/solana/' + entry.address + '",',
      '    }'
    ].join('\n');

    // Support both '  ];' and '\n];' formats
    let insertPoint = currentContent.indexOf('  ];');
    let insertSuffix = '  ';
    if (insertPoint === -1) { insertPoint = currentContent.lastIndexOf('];'); insertSuffix = ''; }
    if (insertPoint === -1) throw new Error('Could not find entries array end in hall/index.html');
    const finalContent = currentContent.slice(0, insertPoint) +
      newEntryStr + ',\n' + insertSuffix + currentContent.slice(insertPoint);

    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Hall of Shame: add ' + entry.symbol + ' (' + entry.score + '/100 - ' + entry.verdict + ')',
        content: Buffer.from(finalContent).toString('base64'),
        sha: sha
      })
    });
    if (!putRes.ok) throw new Error('GitHub PUT failed: ' + putRes.status);
    console.log('[Hall] Committed ' + entry.symbol + ' to Hall of Shame');
    return true;
  } catch(e) {
    console.log('[Hall] Commit error:', e.message);
    return false;
  }
}

// ── 5. Main monitor cycle ─────────────────────────────────────────────────────
async function runHallMonitor() {
  console.log('[Hall] Monitor cycle starting...');
  for (const [key, ts] of recentlySeen.entries()) {
    if (Date.now() - ts > 48 * 3600000) recentlySeen.delete(key);
  }

  const candidates = await fetchTrendingCandidates();
  if (candidates.length === 0) {
    console.log('[Hall] No candidates found — DexScreener may be unreachable.');
    return;
  }

  let proposed = 0;
  let pumpFunProposed = 0;  // max 1 pump.fun per cycle
  for (const ca of candidates) {
    if (recentlySeen.has(ca) || pendingProposals.has(ca)) continue;
    recentlySeen.set(ca, Date.now());

    const liq = await getLiquidity(ca).catch(() => null);
    if (!liq) continue;
    const vmrQ = liq?.volMcapRatio || 0;
    const poolH = liq?.pairCreatedAt instanceof Date
      ? (Date.now() - liq.pairCreatedAt.getTime()) / 3600000 : 9999;
    if (poolH > 48 && vmrQ <= 200) continue;

    // Limit pump.fun / pumpswap to max 1 per cycle — they dominate the feed
    // and tend to follow the same pattern. We want variety, not zero pump.fun.
    const PUMPFUN_DEXES = new Set(['pumpfun', 'pumpswap']);
    const dexList = (liq.dexes || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const isPumpOnly = dexList.length > 0 && dexList.every(d => PUMPFUN_DEXES.has(d));
    if (isPumpOnly && pumpFunProposed >= 1) {
      console.log('[Hall] Skipping pump.fun-only token (quota reached): ' + ca.slice(0,8) + '...');
      continue;
    }

    const result = await auditForHall(ca);
    if (!result) continue;

    // Hard criteria: score ≤ 49 + min liquidity $5K + at least one hard flag
    const hardFlags = [
      !result.mintAuthorityRevoked,                          // mint active
      result.honeyStatus === 'likely_honeypot',              // honeypot confirmed
      result.dangerousExtensions?.length > 0,                // dangerous Token-2022
      (result.vmr !== null && result.vmr > 500),             // Vol/MCAP >500%
      (result.concPct !== null && result.concPct >= 80 && result.liqUsd < 500000) // concentration ≥80%
    ];
    const hasHardFlag = hardFlags.some(Boolean);
    const meetsLiquidity = result.liqUsd >= 5000;

    if (result.score <= 49 && meetsLiquidity && hasHardFlag) {
      await sendHallProposal(result).catch(e => console.log('[Hall] Proposal send error:', e.message));
      proposed++;
      if (isPumpOnly) pumpFunProposed++;
      if (proposed >= 5) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log('[Hall] Cycle complete. ' + proposed + ' proposals sent.');
}


// ── Rug detection ─────────────────────────────────────────────────────────────
// Checks Hall entries with rugDate===null and marks them as rugged if:
// - Liquidity dropped below $500 (essentially dead), OR
// - Current liquidity is < 5% of initialLiq (>95% drain)
async function checkForRugs() {
  if (!GITHUB_TOKEN) return;
  try {
    const apiBase = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + HALL_FILE;
    const getRes = await fetch(apiBase, {
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!getRes.ok) return;
    const fileData = await getRes.json();
    let content = Buffer.from(fileData.content, 'base64').toString('utf8');
    const sha = fileData.sha;

    // Extract entries array from file
    const entriesMatch = content.match(/const entries = \[([\s\S]*?)\];\s*function renderEntries/);
    if (!entriesMatch) return;

    let modified = false;
    const today = new Date().toISOString().split('T')[0];

    // Find all entries with rugDate: null that have an address
    const addrPattern = /address: "([^"]+)"[\s\S]*?rugDate: null/g;
    let match;
    const toCheck = [];
    while ((match = addrPattern.exec(entriesMatch[1])) !== null) {
      toCheck.push(match[1]);
    }

    for (const addr of toCheck.slice(0, 5)) { // max 5 checks per cycle
      try {
        const liq = await getLiquidity(addr).catch(() => null);
        if (!liq) continue;
        const curLiq = liq.totalLiq || 0;

        // Get initialLiq from file if available
        const initMatch = content.match(new RegExp('address: "' + addr + '"[\\s\\S]*?initialLiq: (\\d+(?:\\.\\d+)?)'));
        const initialLiq = initMatch ? parseFloat(initMatch[1]) : 0;

        const isDead = curLiq < 500;
        const isDrained = initialLiq > 1000 && curLiq < initialLiq * 0.05;

        if (isDead || isDrained) {
          // Calculate days to collapse
          const auditMatch = content.match(new RegExp('address: "' + addr + '"[\\s\\S]*?auditDate: "([^"]+)"'));
          const auditDate = auditMatch ? auditMatch[1] : today;
          const days = Math.floor((new Date(today) - new Date(auditDate)) / 86400000);

          content = content.replace(
            new RegExp('(address: "' + addr + '"[\\s\\S]*?)rugDate: null'),
            '$1rugDate: "' + today + '"'
          );
          // Also update daysToCollapse in the rendered output (via entry data)
          console.log('[Hall] Rug detected: ' + addr.slice(0,8) + '... liq=$' + Math.round(curLiq) + ' days=' + days);
          modified = true;

          // ── "El Ganso Te Avisó" notification ─────────────────────────────
          const tweetEntry = tweetRegistry.get(addr);
          if (tweetEntry?.tweetUrl) {
            const tweetId = tweetEntry.tweetUrl.match(/status\/(\d+)/)?.[1];
            const qtUrl   = tweetId ? `https://twitter.com/intent/retweet?tweet_id=${tweetId}` : tweetEntry.tweetUrl;
            const liqDrop = initialLiq > 0 ? ` ($${Math.round(initialLiq)} → $${Math.round(curLiq)})` : '';
            bot.sendMessage(ADMIN_CHAT_ID,
              `🪿 *EL GANSO TE AVISÓ*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n💀 *$${tweetEntry.symbol}* — Rug confirmado\nLiquidez drenada${liqDrop}\nDías desde el audit: ${days}\n\nTweet original del audit:\n${tweetEntry.tweetUrl}`,
              {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🪿 ABRIR TWEET PARA QT', url: qtUrl }
                  ]]
                }
              }
            ).catch(e => console.log('[Tweets] QT notification error:', e.message));
          }
          // ─────────────────────────────────────────────────────────────────

          await new Promise(r => setTimeout(r, 2000));
        }
      } catch(e) { console.log('[Hall] Rug check error for ' + addr.slice(0,8) + ': ' + e.message); }
    }

    if (!modified) { console.log('[Hall] Rug check: no new rugs detected.'); return; }

    // Commit updated file
    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Hall of Shame: rug detected — updated rugDate',
        content: Buffer.from(content).toString('base64'),
        sha: sha
      })
    });
    if (putRes.ok) console.log('[Hall] Rug dates committed to GitHub');
    else console.log('[Hall] Rug commit failed: ' + putRes.status);
  } catch(e) { console.log('[Hall] checkForRugs error:', e.message); }
}

// ── 6. Callback query handler (approve / reject buttons) ─────────────────────
bot.on('callback_query', async (query) => {
  // Only respond to admin
  if (String(query.from.id) !== String(ADMIN_CHAT_ID)) {
    bot.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    return;
  }

  const data = query.data;
  if (!data) return;

  if (data.startsWith('hall_add_')) {
    const ca = data.replace('hall_add_', '');
    const pending = pendingProposals.get(ca);
    if (!pending) {
      bot.answerCallbackQuery(query.id, { text: 'Proposal expired or already processed.' });
      return;
    }
    bot.answerCallbackQuery(query.id, { text: 'Committing to Hall of Shame...' });
    const ok = await commitHallEntry(pending.entry);
    const confirmText = ok
      ? '✅ ' + pending.entry.symbol + ' added to Hall of Shame. Score: ' + pending.entry.score + '/100 - ' + pending.entry.verdict
      : '❌ Commit failed for ' + pending.entry.symbol + '. Check GITHUB_TOKEN in Render.';
    bot.editMessageText(confirmText, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }).catch(() => bot.sendMessage(ADMIN_CHAT_ID, confirmText, {}));
    pendingProposals.delete(ca);

  } else if (data.startsWith('hall_reject_')) {
    const ca = data.replace('hall_reject_', '');
    pendingProposals.delete(ca);
    bot.answerCallbackQuery(query.id, { text: 'Rejected.' });
    bot.editMessageText(`❌ Rejected.`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }).catch(() => {});

  } else if (data.startsWith('manual_hall_')) {
    // Manual add to Hall triggered from audit result
    const ca = data.replace('manual_hall_', '');
    if (pendingProposals.has(ca)) {
      bot.answerCallbackQuery(query.id, { text: 'Already pending approval.' });
      return;
    }
    bot.answerCallbackQuery(query.id, { text: '🔍 Running full audit for Hall...' });
    const result = await auditForHall(ca).catch(() => null);
    if (!result) {
      bot.sendMessage(ADMIN_CHAT_ID, '❌ Could not audit ' + ca.slice(0,8) + '... for Hall.');
      return;
    }
    await sendHallProposal(result).catch(e => console.log('[Hall] Manual proposal error:', e.message));
  }
});

// ── 7. Schedule: run every 6 hours ───────────────────────────────────────────
const HALL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
setTimeout(() => {
  runHallMonitor(); // First run after 5 min (let bot fully start)
  setInterval(runHallMonitor, HALL_INTERVAL_MS);
  // Rug check runs every 3 hours, offset by 30min from monitor
}, 5 * 60 * 1000);

setTimeout(() => {
  checkForRugs();
  setInterval(checkForRugs, 3 * 60 * 60 * 1000); // every 3 hours
}, 30 * 60 * 1000); // first run after 30min

console.log('[Hall] Hall of Shame monitor scheduled (every 6h, first run in 5min)');

bot.on('message',      manejarMensaje);
bot.on('channel_post', manejarMensaje);
