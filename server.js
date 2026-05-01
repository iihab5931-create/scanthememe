const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '7E223ZJ84EDSH1WG9YWQYG6DKDTI42RBB2'; // Optional - works without but rate limited
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';

// Etherscan v2 chain IDs
const ETHERSCAN_CHAIN_MAP = {
  ethereum: '1',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  optimism: '10',
  avalanche: '43114',
  base: '8453',
  fantom: '250',
  cronos: '25',
  linea: '59144',
  zksync: '324',
  scroll: '534352',
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function safeNum(val, fallback = 0) {
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

function pct(value, total) {
  if (!total) return 0;
  return (value / total) * 100;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// ETHERSCAN WALLET INTELLIGENCE
// ─────────────────────────────────────────────

/**
 * Fetch contract creation info via Etherscan API v2
 * Uses txlistinternal to find the creation transaction
 */
async function fetchContractCreation(ca, chain) {
  const chainId = ETHERSCAN_CHAIN_MAP[chain];
  if (!chainId) return null;

  try {
    // Method 1: txlistinternal to find contract creation
    const url = `${ETHERSCAN_BASE}?chainid=${chainId}&module=account&action=txlistinternal&address=${ca}&startblock=0&endblock=99999999&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });

    if (res.data?.status === '1' && res.data?.result?.length > 0) {
      // The first internal tx with contractAddress = ca is the creation
      const creationTx = res.data.result.find(tx => 
        tx.contractAddress?.toLowerCase() === ca.toLowerCase()
      );

      if (creationTx) {
        return {
          deployer: creationTx.from,
          txHash: creationTx.hash,
          blockNumber: parseInt(creationTx.blockNumber),
          timestamp: parseInt(creationTx.timeStamp) * 1000,
          gasUsed: creationTx.gasUsed,
        };
      }
    }

    // Method 2: Fallback - get first normal tx and infer deployer
    const txUrl = `${ETHERSCAN_BASE}?chainid=${chainId}&module=account&action=txlist&address=${ca}&startblock=0&endblock=99999999&sort=asc&page=1&offset=1&apikey=${ETHERSCAN_API_KEY}`;
    const txRes = await axios.get(txUrl, { timeout: 8000 });

    if (txRes.data?.status === '1' && txRes.data?.result?.length > 0) {
      const firstTx = txRes.data.result[0];
      // If first tx is a contract creation (to is empty)
      if (!firstTx.to || firstTx.to === '') {
        return {
          deployer: firstTx.from,
          txHash: firstTx.hash,
          blockNumber: parseInt(firstTx.blockNumber),
          timestamp: parseInt(firstTx.timeStamp) * 1000,
          gasUsed: firstTx.gasUsed,
          inferred: true,
        };
      }
    }

    return null;
  } catch (e) {
    console.warn('[Etherscan] contract creation fetch failed:', e.message);
    return null;
  }
}

/**
 * Fetch all token contracts created by a deployer wallet
 * Uses Etherscan API to get internal txs where deployer is the 'from' address
 */
async function fetchDeployerTokenHistory(deployer, chain, excludeCa) {
  const chainId = ETHERSCAN_CHAIN_MAP[chain];
  if (!chainId) return null;

  try {
    // Get internal transactions where deployer created contracts
    const url = `${ETHERSCAN_BASE}?chainid=${chainId}&module=account&action=txlistinternal&address=${deployer}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });

    if (res.data?.status !== '1' || !res.data?.result) {
      return null;
    }

    // Filter to contract creations (contractAddress present and non-empty)
    const creations = res.data.result
      .filter(tx => tx.contractAddress && tx.contractAddress.length > 0)
      .filter(tx => tx.contractAddress.toLowerCase() !== excludeCa.toLowerCase())
      .map(tx => ({
        contractAddress: tx.contractAddress,
        txHash: tx.hash,
        blockNumber: parseInt(tx.blockNumber),
        timestamp: parseInt(tx.timeStamp) * 1000,
      }));

    // Deduplicate by contract address, keep most recent
    const seen = new Set();
    const unique = [];
    for (const c of creations) {
      if (!seen.has(c.contractAddress.toLowerCase())) {
        seen.add(c.contractAddress.toLowerCase());
        unique.push(c);
      }
    }

    // Limit to last 20 tokens for performance
    return unique.slice(0, 20);
  } catch (e) {
    console.warn('[Etherscan] deployer history fetch failed:', e.message);
    return null;
  }
}

/**
 * Fetch token balances for a wallet to detect if deployer still holds tokens
 */
async function fetchDeployerTokenBalance(deployer, tokenCa, chain) {
  const chainId = ETHERSCAN_CHAIN_MAP[chain];
  if (!chainId) return null;

  try {
    const url = `${ETHERSCAN_BASE}?chainid=${chainId}&module=account&action=tokenbalance&contractaddress=${tokenCa}&address=${deployer}&tag=latest&apikey=${ETHERSCAN_API_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });

    if (res.data?.status === '1') {
      return {
        balance: res.data.result,
        raw: res.data.result,
      };
    }
    return null;
  } catch (e) {
    console.warn('[Etherscan] token balance fetch failed:', e.message);
    return null;
  }
}

/**
 * Fetch recent transactions from deployer wallet to detect sell patterns
 */
async function fetchDeployerRecentTxns(deployer, chain) {
  const chainId = ETHERSCAN_CHAIN_MAP[chain];
  if (!chainId) return null;

  try {
    const url = `${ETHERSCAN_BASE}?chainid=${chainId}&module=account&action=txlist&address=${deployer}&startblock=0&endblock=99999999&sort=desc&page=1&offset=50&apikey=${ETHERSCAN_API_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });

    if (res.data?.status !== '1' || !res.data?.result) {
      return null;
    }

    return res.data.result.map(tx => ({
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      timestamp: parseInt(tx.timeStamp) * 1000,
      gasPrice: tx.gasPrice,
      gasUsed: tx.gasUsed,
      isError: tx.isError === '1',
      txReceiptStatus: tx.txreceipt_status,
    }));
  } catch (e) {
    console.warn('[Etherscan] deployer txns fetch failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// WALLET INTELLIGENCE ANALYSIS
// ─────────────────────────────────────────────

async function analyzeWalletIntelligence(ca, chain, tokenData) {
  const result = {
    deployer: null,
    deployerHistory: null,
    deployerBalance: null,
    deployerTxns: null,
    insiderCluster: null,
    riskBoost: 0,
    critical: [],
    warnings: [],
    safe: [],
  };

  // Step 1: Find deployer
  const creation = await fetchContractCreation(ca, chain);
  if (!creation) {
    result.warnings.push('Could not trace contract deployer — wallet intelligence limited');
    return result;
  }

  result.deployer = {
    address: creation.deployer,
    txHash: creation.txHash,
    blockNumber: creation.blockNumber,
    timestamp: creation.timestamp,
    ageDays: Math.floor((Date.now() - creation.timestamp) / (1000 * 60 * 60 * 24)),
    inferred: creation.inferred || false,
  };

  // Step 2: Analyze deployer token history
  const history = await fetchDeployerTokenHistory(creation.deployer, chain, ca);
  if (history) {
    result.deployerHistory = {
      totalTokensLaunched: history.length,
      recentTokens: history.slice(0, 5).map(h => ({
        address: h.contractAddress,
        launchedAt: new Date(h.timestamp).toISOString(),
        ageDays: Math.floor((Date.now() - h.timestamp) / (1000 * 60 * 60 * 24)),
      })),
    };

    // Flag serial deployers
    if (history.length >= 5) {
      result.critical.push(`Deployer has launched ${history.length} tokens — serial deployer pattern detected`);
      result.riskBoost += 20;
    } else if (history.length >= 2) {
      result.warnings.push(`Deployer has launched ${history.length} other tokens`);
      result.riskBoost += 10;
    }

    // Flag rapid deployment
    const recentCount = history.filter(h => (Date.now() - h.timestamp) < 30 * 24 * 60 * 60 * 1000).length;
    if (recentCount >= 3) {
      result.critical.push(`Deployer launched ${recentCount} tokens in the last 30 days — factory behavior`);
      result.riskBoost += 15;
    }
  }

  // Step 3: Check if deployer still holds tokens
  const balance = await fetchDeployerTokenBalance(creation.deployer, ca, chain);
  if (balance && balance.balance) {
    const bal = safeNum(balance.balance);
    // We can't know total supply from Etherscan easily, so use heuristic
    // If balance is 0, deployer has sold everything
    if (bal === 0) {
      result.critical.push('Deployer wallet holds ZERO tokens — full exit suspected');
      result.riskBoost += 25;
    } else {
      result.safe.push('Deployer wallet still holds tokens');
    }
    result.deployerBalance = { balance: bal };
  }

  // Step 4: Analyze deployer recent transactions
  const txns = await fetchDeployerRecentTxns(creation.deployer, chain);
  if (txns) {
    // Count failed transactions (possible bot/rug behavior)
    const failedTxns = txns.filter(t => t.isError);
    if (failedTxns.length > 5) {
      result.warnings.push(`${failedTxns.length} failed transactions from deployer — possible bot behavior`);
    }

    // Detect interaction with DEXs (selling)
    const dexAddresses = [
      '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router
      '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap V3 Router
      '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap V2 Router
    ];

    const dexInteractions = txns.filter(t => 
      t.to && dexAddresses.includes(t.to.toLowerCase())
    );

    if (dexInteractions.length > 0) {
      result.warnings.push(`Deployer interacted with DEX ${dexInteractions.length} times recently — potential sell activity`);
      result.riskBoost += 10;
    }

    result.deployerTxns = {
      recentCount: txns.length,
      failedCount: failedTxns.length,
      dexInteractionCount: dexInteractions.length,
    };
  }

  // Step 5: Insider clustering (heuristic from Dexscreener data)
  // We use buy/sell ratio and tx patterns to infer insider behavior
  if (tokenData.buyRatio !== null && tokenData.buyRatio > 0.85 && tokenData.totalTxns24 > 20) {
    result.warnings.push('Extreme buy dominance — possible insider accumulation or wash trading');
  }

  if (tokenData.txnsSell24 < 3 && tokenData.txnsBuy24 > 30) {
    result.critical.push('Virtually no sell transactions — holders may be unable to exit (honeypot signal)');
    result.riskBoost += 20;
  }

  return result;
}

// ─────────────────────────────────────────────
// DATA FETCHER (Dexscreener)
// ─────────────────────────────────────────────

async function fetchTokenData(ca) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
  const res = await axios.get(url, { timeout: 8000 });
  const pairs = res.data?.pairs;
  if (!pairs || pairs.length === 0) return null;

  pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd));
  const pair = pairs[0];

  const liquidity     = safeNum(pair.liquidity?.usd);
  const volume24h     = safeNum(pair.volume?.h24);
  const volume1h      = safeNum(pair.volume?.h1);
  const volume6h      = safeNum(pair.volume?.h6);
  const priceChange24 = safeNum(pair.priceChange?.h24);
  const priceChange1  = safeNum(pair.priceChange?.h1);
  const priceChange6  = safeNum(pair.priceChange?.h6);
  const fdv           = safeNum(pair.fdv);
  const marketCap     = safeNum(pair.marketCap) || fdv;
  const txnsBuy24     = safeNum(pair.txns?.h24?.buys);
  const txnsSell24    = safeNum(pair.txns?.h24?.sells);
  const totalTxns24   = txnsBuy24 + txnsSell24;
  const pairAge       = pair.pairCreatedAt
    ? Math.floor((Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60))
    : null;
  const dex           = pair.dexId || 'unknown';
  const chain         = pair.chainId || 'unknown';
  const baseSymbol    = pair.baseToken?.symbol || '???';
  const baseName      = pair.baseToken?.name || '???';
  const baseAddress   = pair.baseToken?.address || ca;
  const priceUsd      = safeNum(pair.priceUsd);
  const totalPairs    = pairs.length;

  const buyRatio      = totalTxns24 > 0 ? txnsBuy24 / totalTxns24 : null;

  const v1_weight = (volume1h * 24);
  const volumeConsistency = (v1_weight && volume24h)
    ? Math.abs(v1_weight - volume24h) / (volume24h || 1)
    : null;

  return {
    liquidity, volume24h, volume1h, volume6h,
    priceChange24, priceChange1, priceChange6,
    fdv, marketCap, txnsBuy24, txnsSell24, totalTxns24,
    pairAge, dex, chain, baseSymbol, baseName, baseAddress,
    priceUsd, totalPairs, buyRatio, volumeConsistency,
    liquidityToMcap: marketCap > 0 ? pct(liquidity, marketCap) : null,
    volumeToLiquidity: liquidity > 0 ? volume24h / liquidity : null,
  };
}

// ─────────────────────────────────────────────
// GOPLUS SECURITY FETCHER
// ─────────────────────────────────────────────

const GOPLUS_CHAIN_MAP = {
  ethereum: '1', bsc: '56', polygon: '137', arbitrum: '42161',
  optimism: '10', avalanche: '43114', base: '8453', fantom: '250',
  cronos: '25', linea: '59144', zksync: '324', scroll: '534352',
};

async function fetchGoPlusData(ca, chain) {
  const chainId = GOPLUS_CHAIN_MAP[chain];
  if (!chainId) return null;
  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${ca}`;
    const res = await axios.get(url, { timeout: 8000 });
    const result = res.data?.result?.[ca.toLowerCase()];
    if (!result) return null;

    const flag = (val) => val === '1' || val === 1;
    const num  = (val) => val !== undefined && val !== null ? parseFloat(val) : null;

    return {
      ownershipRenounced: flag(result.owner_address === '0x0000000000000000000000000000000000000000') || flag(result.owner_change_balance),
      ownerAddress: result.owner_address || null,
      creatorAddress: result.creator_address || null,
      isHoneypot: flag(result.is_honeypot),
      cannotBuy: flag(result.cannot_buy),
      cannotSellAll: flag(result.cannot_sell_all),
      hasMintFunction: flag(result.is_mintable),
      hasBlacklist: flag(result.is_blacklisted),
      hasWhitelist: flag(result.is_whitelisted),
      hasProxy: flag(result.is_proxy),
      selfDestruct: flag(result.selfdestruct),
      externalCall: flag(result.external_call),
      hiddenOwner: flag(result.hidden_owner),
      canTakeBackOwnership: flag(result.can_take_back_ownership),
      ownerChangeBalance: flag(result.owner_change_balance),
      buyTax: num(result.buy_tax),
      sellTax: num(result.sell_tax),
      slippageModifiable: flag(result.slippage_modifiable),
      personalSlippageModifiable: flag(result.personal_slippage_modifiable),
      lpHolders: result.lp_holders || [],
      lpTotalSupply: num(result.lp_total_supply),
      isOpenSource: flag(result.is_open_source),
      isTrueToken: flag(result.trust_list),
      holders: result.holders || [],
      holderCount: num(result.holder_count),
      top10HolderPercent: result.holders
        ? result.holders.slice(0, 10).reduce((s, h) => s + parseFloat(h.percent || 0), 0)
        : null,
      dexList: result.dex || [],
    };
  } catch (e) {
    console.warn('[GoPlus] fetch failed:', e.message);
    return null;
  }
}

function analyzeGoPlus(gp) {
  if (!gp) return null;
  const critical = [], warnings = [], safe = [];

  if (gp.isHoneypot) critical.push('CONTRACT CONFIRMED HONEYPOT — tokens cannot be sold');
  if (gp.hasMintFunction) critical.push('Mint function present — supply can be inflated at will');
  if (gp.hiddenOwner) critical.push('Hidden owner detected — contract control is concealed');
  if (gp.canTakeBackOwnership) critical.push('Ownership can be reclaimed — renouncement is fake');
  if (gp.selfDestruct) critical.push('Self-destruct function present — contract can be wiped');
  if (gp.cannotSellAll) critical.push('Cannot sell full balance — partial exit trap');
  if (gp.cannotBuy) critical.push('Buy function restricted — token has limited entry');
  if (gp.ownerChangeBalance) critical.push('Owner can modify holder balances — extreme rug risk');

  if (gp.sellTax !== null) {
    if (gp.sellTax > 0.5) critical.push(`Sell tax is ${(gp.sellTax * 100).toFixed(0)}% — effectively unsellable`);
    else if (gp.sellTax > 0.1) warnings.push(`High sell tax: ${(gp.sellTax * 100).toFixed(0)}%`);
    else if (gp.sellTax > 0.05) warnings.push(`Sell tax: ${(gp.sellTax * 100).toFixed(0)}% — above normal`);
  }

  if (gp.buyTax !== null && gp.buyTax > 0.1) warnings.push(`Buy tax: ${(gp.buyTax * 100).toFixed(0)}%`);
  if (gp.hasBlacklist) warnings.push('Blacklist function — deployer can block specific wallets');
  if (gp.hasWhitelist) warnings.push('Whitelist function — selective trading access');
  if (gp.hasProxy) warnings.push('Proxy contract — logic can be swapped after deployment');
  if (gp.externalCall) warnings.push('External call in contract — third-party dependency risk');
  if (gp.slippageModifiable) warnings.push('Slippage can be modified by owner');

  if (gp.top10HolderPercent !== null) {
    const pct = gp.top10HolderPercent * 100;
    if (pct > 80) critical.push(`Top 10 holders own ${pct.toFixed(1)}% of supply — extreme concentration`);
    else if (pct > 60) warnings.push(`Top 10 holders own ${pct.toFixed(1)}% of supply`);
    else safe.push(`Top 10 holders own ${pct.toFixed(1)}% — reasonable distribution`);
  }

  const lockedLp = gp.lpHolders.filter(h => h.is_locked === 1);
  const lockedPct = lockedLp.reduce((s, h) => s + parseFloat(h.percent || 0), 0) * 100;
  if (lockedPct > 80) safe.push(`${lockedPct.toFixed(0)}% of liquidity is locked`);
  else if (lockedPct > 0) warnings.push(`Only ${lockedPct.toFixed(0)}% of LP is locked — partial lock`);
  else warnings.push('No liquidity lock detected');

  if (!gp.hasMintFunction) safe.push('No mint function — supply is fixed');
  if (!gp.hasBlacklist) safe.push('No blacklist function');
  if (gp.isOpenSource) safe.push('Contract source code is verified');
  if (gp.ownershipRenounced) safe.push('Ownership appears renounced');

  const gpRiskBoost = (critical.length * 15) + (warnings.length * 5);

  return {
    critical, warnings, safe,
    isHoneypot: gp.isHoneypot,
    buyTax: gp.buyTax, sellTax: gp.sellTax,
    holderCount: gp.holderCount,
    top10Pct: gp.top10HolderPercent ? parseFloat((gp.top10HolderPercent * 100).toFixed(1)) : null,
    lockedLpPct: parseFloat(lockedPct.toFixed(1)),
    isOpenSource: gp.isOpenSource,
    hasMint: gp.hasMintFunction,
    hasBlacklist: gp.hasBlacklist,
    gpRiskBoost: Math.min(gpRiskBoost, 30),
  };
}

// ─────────────────────────────────────────────
// HONEYPOT.IS FETCHER
// ─────────────────────────────────────────────

const HONEYPOT_CHAIN_MAP = {
  ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', arbitrum: 'arbitrum',
  base: 'base', avalanche: 'avalanche', fantom: 'fantom', cronos: 'cronos', optimism: 'optimism',
};

async function fetchHoneypotIs(ca, chain) {
  const hpChain = HONEYPOT_CHAIN_MAP[chain];
  if (!hpChain) return null;
  try {
    const url = `https://api.honeypot.is/v2/IsHoneypot?address=${ca}&chainID=${hpChain}`;
    const res = await axios.get(url, { timeout: 7000 });
    const d = res.data;
    if (!d) return null;
    const sim = d.simulationResult || {};
    const hp  = d.honeypotResult  || {};
    return {
      isHoneypot: d.isHoneypot === true,
      honeypotReason: hp.reason || null,
      buyTax: sim.buyTax != null ? parseFloat(sim.buyTax) : null,
      sellTax: sim.sellTax != null ? parseFloat(sim.sellTax) : null,
      transferTax: sim.transferTax != null ? parseFloat(sim.transferTax) : null,
      buyGas: sim.buyGas || null, sellGas: sim.sellGas || null,
      maxBuy: d.simulationResult?.maxBuy || null,
      maxSell: d.simulationResult?.maxSell || null,
      flags: d.flags || [],
      pairAddress: d.pair?.pair?.address || null,
      pairLiquidity: d.pair?.liquidity || null,
      tokenName: d.token?.name || null,
      tokenSymbol: d.token?.symbol || null,
    };
  } catch (e) {
    console.warn('[honeypot.is] fetch failed:', e.message);
    return null;
  }
}

function analyzeHoneypotIs(hp) {
  if (!hp) return null;
  const critical = [], warnings = [], safe = [];

  if (hp.isHoneypot) {
    critical.push(`Honeypot.is CONFIRMED: ${hp.honeypotReason || 'token cannot be sold'}`);
  } else {
    safe.push('Honeypot.is: no honeypot detected via simulation');
  }

  if (hp.sellTax !== null) {
    if (hp.sellTax > 50) critical.push(`Sell tax simulated at ${hp.sellTax.toFixed(1)}% — effectively a trap`);
    else if (hp.sellTax > 10) warnings.push(`Sell tax: ${hp.sellTax.toFixed(1)}% (simulated)`);
    else if (hp.sellTax > 0) safe.push(`Sell tax: ${hp.sellTax.toFixed(1)}% (simulated)`);
  }

  if (hp.buyTax !== null && hp.buyTax > 10) warnings.push(`Buy tax: ${hp.buyTax.toFixed(1)}% (simulated)`);
  if (hp.transferTax !== null && hp.transferTax > 0) warnings.push(`Transfer tax: ${hp.transferTax.toFixed(1)}%`);
  if (hp.flags && hp.flags.length > 0) hp.flags.forEach(f => warnings.push(`Flag: ${f}`));

  return {
    isHoneypot: hp.isHoneypot, buyTax: hp.buyTax, sellTax: hp.sellTax, transferTax: hp.transferTax,
    reason: hp.honeypotReason, critical, warnings, safe,
  };
}

// ─────────────────────────────────────────────
// CLASSIFICATION MODULES
// ─────────────────────────────────────────────

function checkLiquidityExitRisk(d) {
  const evidence = [];
  let score = 0;
  if (d.liquidity < 5000) {
    evidence.push(`Critically low liquidity ($${d.liquidity.toLocaleString()}) — easy to drain`);
    score += 45;
  } else if (d.liquidity < 25000) {
    evidence.push(`Low liquidity ($${d.liquidity.toLocaleString()}) — exit risk elevated`);
    score += 25;
  }
  if (d.liquidityToMcap !== null && d.liquidityToMcap < 2) {
    evidence.push(`Liquidity is only ${d.liquidityToMcap.toFixed(1)}% of market cap — thin cushion`);
    score += 30;
  }
  if (d.pairAge !== null && d.pairAge < 24 && d.liquidity < 50000) {
    evidence.push(`Pair created ${d.pairAge}h ago — new pairs are high-risk before liquidity stabilizes`);
    score += 20;
  }
  if (d.totalPairs === 1) {
    evidence.push('Single trading pair detected — liquidity split risk absent but fragility high');
    score += 10;
  }
  return { type: 'LIQUIDITY EXIT RISK', triggered: score >= 40, confidence: Math.min(score, 95), evidence };
}

function checkSlowRug(d) {
  const evidence = [];
  let score = 0;
  if (d.priceChange24 < -30 && d.volume24h < d.liquidity * 0.1) {
    evidence.push(`Price down ${Math.abs(d.priceChange24).toFixed(1)}% with suspiciously low sell volume — controlled bleed`);
    score += 40;
  }
  if (d.priceChange24 < -15 && d.txnsSell24 > d.txnsBuy24 * 2) {
    evidence.push(`Sell transactions (${d.txnsSell24}) overwhelm buys (${d.txnsBuy24}) — insider exit pattern`);
    score += 30;
  }
  if (d.priceChange6 < -10 && d.priceChange1 < -5) {
    evidence.push(`Consistent hourly and 6h decline — steady downtrend without recovery`);
    score += 20;
  }
  if (d.liquidity < 30000 && d.priceChange24 < -20) {
    evidence.push(`Low liquidity + price decline combo — rug in progress possible`);
    score += 25;
  }
  return { type: 'SLOW RUG', triggered: score >= 40, confidence: Math.min(score, 95), evidence };
}

function checkPumpAndDump(d) {
  const evidence = [];
  let score = 0;
  if (d.priceChange24 > 100) {
    evidence.push(`Price surged +${d.priceChange24.toFixed(1)}% in 24h — extreme spike`);
    score += 35;
  } else if (d.priceChange24 > 50) {
    evidence.push(`Price up ${d.priceChange24.toFixed(1)}% today — unusual momentum`);
    score += 20;
  }
  if (d.volumeToLiquidity !== null && d.volumeToLiquidity > 8) {
    evidence.push(`Volume/liquidity ratio: ${d.volumeToLiquidity.toFixed(1)}x — volume vastly exceeds liquidity pool`);
    score += 30;
  }
  if (d.buyRatio !== null && d.buyRatio > 0.75 && d.priceChange24 > 30) {
    evidence.push(`${(d.buyRatio * 100).toFixed(0)}% of transactions are buys — coordinated buy wall likely`);
    score += 25;
  }
  if (d.pairAge !== null && d.pairAge < 48 && d.priceChange24 > 50) {
    evidence.push(`Token is ${d.pairAge}h old with a massive price spike — early-stage P&D pattern`);
    score += 20;
  }
  if (d.fdv > 0 && d.liquidity < d.fdv * 0.005) {
    evidence.push(`FDV of $${(d.fdv / 1e6).toFixed(2)}M is disproportionate to available liquidity`);
    score += 15;
  }
  return { type: 'PUMP & DUMP SETUP', triggered: score >= 40, confidence: Math.min(score, 95), evidence };
}

function checkHoneypot(d) {
  const evidence = [];
  let score = 0;
  if (d.txnsSell24 < 5 && d.txnsBuy24 > 30) {
    evidence.push(`Only ${d.txnsSell24} sell txns vs ${d.txnsBuy24} buys — sellers may be blocked`);
    score += 50;
  } else if (d.txnsSell24 < d.txnsBuy24 * 0.05 && d.txnsBuy24 > 20) {
    evidence.push(`Sell transactions are ${((d.txnsSell24 / d.txnsBuy24) * 100).toFixed(1)}% of buy volume — abnormal asymmetry`);
    score += 40;
  }
  if (d.buyRatio !== null && d.buyRatio > 0.92 && d.totalTxns24 > 20) {
    evidence.push(`${(d.buyRatio * 100).toFixed(0)}% of all txns are buys — almost no outflows detected`);
    score += 30;
  }
  if (d.priceChange24 > 20 && d.txnsSell24 < 10) {
    evidence.push('Price rising but selling activity near-zero — holders may be unable to exit');
    score += 20;
  }
  return { type: 'HONEYPOT SUSPICION', triggered: score >= 40, confidence: Math.min(score, 95), evidence };
}

function checkFakeVolume(d) {
  const evidence = [];
  let score = 0;
  if (d.volume24h > 500000 && d.totalTxns24 < 50) {
    evidence.push(`$${(d.volume24h / 1e3).toFixed(0)}K volume from only ${d.totalTxns24} transactions — wash trading suspected`);
    score += 50;
  }
  if (d.volumeConsistency !== null && d.volumeConsistency > 2.5) {
    evidence.push(`Volume distribution is highly irregular across time windows — artificial spikes likely`);
    score += 35;
  }
  if (d.volumeToLiquidity !== null && d.volumeToLiquidity > 15) {
    evidence.push(`Volume is ${d.volumeToLiquidity.toFixed(0)}x the liquidity pool — mathematically inconsistent without wash trading`);
    score += 40;
  }
  if (d.priceChange24 < 2 && d.priceChange24 > -2 && d.volume24h > d.liquidity * 5) {
    evidence.push('Flat price despite massive volume — price manipulation via circular trading');
    score += 30;
  }
  return { type: 'FAKE VOLUME / WASH TRADING', triggered: score >= 40, confidence: Math.min(score, 95), evidence };
}

function checkInsiderAccumulation(d) {
  const evidence = [];
  let score = 0;
  if (d.pairAge !== null && d.pairAge < 12 && d.volume24h > 100000) {
    evidence.push(`Token is only ${d.pairAge}h old with $${(d.volume24h / 1e3).toFixed(0)}K volume — early accumulation window`);
    score += 30;
  }
  if (d.buyRatio !== null && d.buyRatio > 0.8 && d.priceChange24 < 10) {
    evidence.push(`Heavy buying (${(d.buyRatio * 100).toFixed(0)}% buy ratio) with minimal price impact — whales absorbing supply`);
    score += 35;
  }
  if (d.liquidityToMcap !== null && d.liquidityToMcap > 30 && d.volume24h < d.liquidity * 0.1) {
    evidence.push('High liquidity relative to mcap with low volume — team holding most supply off-market');
    score += 25;
  }
  if (d.marketCap > 0 && d.fdv > d.marketCap * 5) {
    evidence.push(`FDV ($${(d.fdv / 1e6).toFixed(2)}M) is ${(d.fdv / d.marketCap).toFixed(0)}x current mcap — large unlocked supply held by insiders`);
    score += 30;
  }
  return { type: 'INSIDER ACCUMULATION', triggered: score >= 40, confidence: Math.min(score, 95), evidence };
}

function checkOvervalued(d) {
  const evidence = [];
  let score = 0;
  if (d.fdv > 0 && d.liquidity > 0 && d.fdv / d.liquidity > 500) {
    evidence.push(`FDV/liquidity ratio is ${(d.fdv / d.liquidity).toFixed(0)}x — massively overvalued vs depth`);
    score += 35;
  }
  if (d.priceChange24 > 200) {
    evidence.push(`+${d.priceChange24.toFixed(0)}% price change in 24h — unsustainable valuation`);
    score += 30;
  }
  if (d.marketCap > 10000000 && d.liquidity < 50000) {
    evidence.push(`$${(d.marketCap / 1e6).toFixed(1)}M mcap backed by only $${(d.liquidity / 1e3).toFixed(0)}K liquidity`);
    score += 35;
  }
  return { type: 'OVERVALUED / INSIDER CONTROL', triggered: score >= 40, confidence: Math.min(score, 95), evidence };
}

// ─────────────────────────────────────────────
// CLASSIFICATION ENGINE
// ─────────────────────────────────────────────

function classifyToken(d, walletIntel) {
  const checks = [
    checkHoneypot(d),
    checkLiquidityExitRisk(d),
    checkFakeVolume(d),
    checkSlowRug(d),
    checkPumpAndDump(d),
    checkInsiderAccumulation(d),
    checkOvervalued(d),
  ];

  const triggered = checks.filter(c => c.triggered);

  // Inject wallet intelligence into evidence
  if (walletIntel) {
    if (walletIntel.critical.length > 0) {
      triggered.push({
        type: 'DEPLOYER RISK',
        triggered: true,
        confidence: Math.min(walletIntel.riskBoost * 2, 95),
        evidence: walletIntel.critical,
      });
    }
  }

  if (triggered.length === 0) {
    const safeEvidence = [];
    if (d.liquidity >= 50000) safeEvidence.push(`Adequate liquidity ($${(d.liquidity / 1e3).toFixed(0)}K)`);
    if (d.priceChange24 > -20 && d.priceChange24 < 80) safeEvidence.push(`Price change within normal range (${d.priceChange24.toFixed(1)}%)`);
    if (d.buyRatio !== null && d.buyRatio > 0.3 && d.buyRatio < 0.8) safeEvidence.push(`Balanced buy/sell ratio (${(d.buyRatio * 100).toFixed(0)}% buys)`);
    if (walletIntel && walletIntel.deployer && walletIntel.deployerHistory && walletIntel.deployerHistory.totalTokensLaunched === 0) {
      safeEvidence.push('Deployer has no prior token launches — first-time creator');
    }
    safeEvidence.push('No critical scam patterns detected in on-chain signals');

    return {
      type: 'RELATIVELY SAFE',
      confidence: 65,
      evidence: safeEvidence,
      allChecks: checks,
    };
  }

  triggered.sort((a, b) => b.confidence - a.confidence);
  const primary = triggered[0];
  const secondary = triggered.slice(1);

  return {
    type: primary.type,
    confidence: primary.confidence,
    evidence: primary.evidence,
    secondaryFlags: secondary.map(s => ({ type: s.type, confidence: s.confidence, evidence: s.evidence })),
    allChecks: checks,
  };
}

function deriveRiskScore(classification, walletIntel) {
  if (classification.type === 'RELATIVELY SAFE') {
    return Math.max(0, 35 - classification.confidence * 0.2);
  }

  const weights = {
    'HONEYPOT SUSPICION': 1.0, 'SLOW RUG': 0.95, 'LIQUIDITY EXIT RISK': 0.9,
    'FAKE VOLUME / WASH TRADING': 0.8, 'PUMP & DUMP SETUP': 0.85,
    'INSIDER ACCUMULATION': 0.75, 'OVERVALUED / INSIDER CONTROL': 0.7,
    'DEPLOYER RISK': 0.95,
  };

  const w = weights[classification.type] || 0.75;
  let score = classification.confidence * w;

  if (classification.secondaryFlags) {
    const bonus = classification.secondaryFlags.reduce((acc, f) => acc + f.confidence * 0.1, 0);
    score += Math.min(bonus, 15);
  }

  // Add wallet intelligence risk boost
  if (walletIntel) {
    score += Math.min(walletIntel.riskBoost, 25);
  }

  return Math.min(Math.round(score), 99);
}

function riskLabel(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  if (score >= 20) return 'LOW';
  return 'MINIMAL';
}

// ─────────────────────────────────────────────
// ROUTE
// ─────────────────────────────────────────────

app.get('/analyze', async (req, res) => {
  const { ca } = req.query;
  if (!ca || ca.trim().length < 10) {
    return res.status(400).json({ error: 'Missing or invalid contract address' });
  }

  try {
    const data = await fetchTokenData(ca.trim());
    if (!data) {
      return res.status(404).json({ error: 'Token not found on Dexscreener. Check the contract address.' });
    }

    // Fetch all intelligence in parallel
    const [classificationBase, gpRaw, hpRaw, walletIntel] = await Promise.all([
      Promise.resolve(classifyToken(data, null)), // Initial classification without wallet intel
      fetchGoPlusData(ca.trim(), data.chain),
      fetchHoneypotIs(ca.trim(), data.chain),
      analyzeWalletIntelligence(ca.trim(), data.chain, data),
    ]);

    // Re-classify with wallet intelligence
    const classification = classifyToken(data, walletIntel);

    const gpAnalysis = analyzeGoPlus(gpRaw);
    const hpAnalysis = analyzeHoneypotIs(hpRaw);

    let riskScore = deriveRiskScore(classification, walletIntel);
    if (gpAnalysis) riskScore = Math.min(riskScore + gpAnalysis.gpRiskBoost, 99);

    const honeypotConfirmed = gpAnalysis?.isHoneypot || hpAnalysis?.isHoneypot;
    if (honeypotConfirmed) {
      classification.type = 'HONEYPOT CONFIRMED';
      classification.confidence = 99;
      const sources = [
        gpAnalysis?.isHoneypot ? 'GoPlus' : null,
        hpAnalysis?.isHoneypot ? 'Honeypot.is' : null,
      ].filter(Boolean).join(' + ');
      classification.evidence.unshift(`${sources}: contract confirmed as honeypot — tokens cannot be sold`);
      riskScore = 99;
    }

    // Merge wallet intel evidence into main evidence
    if (walletIntel && walletIntel.critical.length > 0) {
      classification.evidence = [...walletIntel.critical, ...classification.evidence];
    }
    if (walletIntel && walletIntel.warnings.length > 0) {
      classification.evidence = [...classification.evidence, ...walletIntel.warnings];
    }

    const response = {
      type: classification.type,
      confidence: classification.confidence,
      riskScore,
      riskLevel: riskLabel(riskScore),
      evidence: classification.evidence,
      secondaryFlags: classification.secondaryFlags || [],
      token: {
        name: data.baseName,
        symbol: data.baseSymbol,
        address: data.baseAddress,
        chain: data.chain,
        dex: data.dex,
        priceUsd: data.priceUsd,
        pairAgeHours: data.pairAge,
      },
      metrics: {
        liquidity: data.liquidity,
        volume24h: data.volume24h,
        priceChange24h: data.priceChange24,
        priceChange1h: data.priceChange1,
        fdv: data.fdv,
        marketCap: data.marketCap,
        txnsBuy24h: data.txnsBuy24,
        txnsSell24h: data.txnsSell24,
        buyRatio: data.buyRatio ? parseFloat(data.buyRatio.toFixed(3)) : null,
        liquidityToMcapPct: data.liquidityToMcap ? parseFloat(data.liquidityToMcap.toFixed(2)) : null,
        volumeToLiquidity: data.volumeToLiquidity ? parseFloat(data.volumeToLiquidity.toFixed(2)) : null,
      },
      contractIntelligence: gpAnalysis ? {
        supported: true,
        isHoneypot: gpAnalysis.isHoneypot,
        buyTax: gpAnalysis.buyTax !== null ? parseFloat((gpAnalysis.buyTax * 100).toFixed(1)) : null,
        sellTax: gpAnalysis.sellTax !== null ? parseFloat((gpAnalysis.sellTax * 100).toFixed(1)) : null,
        holderCount: gpAnalysis.holderCount,
        top10HolderPct: gpAnalysis.top10Pct,
        lockedLpPct: gpAnalysis.lockedLpPct,
        isOpenSource: gpAnalysis.isOpenSource,
        hasMintFunction: gpAnalysis.hasMint,
        hasBlacklist: gpAnalysis.hasBlacklist,
        critical: gpAnalysis.critical,
        warnings: gpAnalysis.warnings,
        safe: gpAnalysis.safe,
      } : { supported: false },
      honeypotIs: hpAnalysis ? {
        supported: true,
        isHoneypot: hpAnalysis.isHoneypot,
        reason: hpAnalysis.reason,
        buyTax: hpAnalysis.buyTax !== null ? parseFloat(hpAnalysis.buyTax.toFixed(1)) : null,
        sellTax: hpAnalysis.sellTax !== null ? parseFloat(hpAnalysis.sellTax.toFixed(1)) : null,
        transferTax: hpAnalysis.transferTax !== null ? parseFloat(hpAnalysis.transferTax.toFixed(1)) : null,
        critical: hpAnalysis.critical,
        warnings: hpAnalysis.warnings,
        safe: hpAnalysis.safe,
      } : { supported: false },
      walletIntelligence: {
        supported: walletIntel.deployer !== null,
        deployer: walletIntel.deployer,
        deployerHistory: walletIntel.deployerHistory,
        deployerBalance: walletIntel.deployerBalance,
        deployerTxns: walletIntel.deployerTxns,
        critical: walletIntel.critical,
        warnings: walletIntel.warnings,
        safe: walletIntel.safe,
      },
    };

    return res.json(response);
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return res.status(504).json({ error: 'Dexscreener API timeout. Try again.' });
    }
    console.error('[analyze error]', err.message);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

app.get('/ping', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Scanthememes backend running on port ${PORT}`));
